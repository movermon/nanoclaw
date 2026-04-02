/**
 * APEX Deduplication Cache
 *
 * Caches API call results by semantic fingerprint to avoid repeating
 * similar queries. Wired into cost-proxy.ts as a pre-flight check
 * after kbCheck() and before the actual API call.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const CACHE_PATH = path.resolve(process.cwd(), 'dedup-cache.json');

// Default TTLs by inferred task type (hours)
const DEFAULT_TTLS = {
  research: 24,
  market: 6,
  decision: 72,
  default: 12,
};

const MAX_CACHE_ENTRIES = 200;

/**
 * Create a fingerprint from the first 200 chars of a prompt.
 */
function createFingerprint(prompt) {
  const normalized = (prompt || '').slice(0, 200).toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Infer task type from prompt content for TTL selection.
 */
function inferTaskType(prompt) {
  const lower = (prompt || '').toLowerCase();
  if (/\b(research|search|find|look up|investigate)\b/.test(lower)) return 'research';
  if (/\b(market|competitor|price|trend|industry)\b/.test(lower)) return 'market';
  if (/\b(decide|strategy|plan|recommend|evaluate)\b/.test(lower)) return 'decision';
  return 'default';
}

/**
 * Load the cache from disk.
 */
function loadCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    }
  } catch { /* fresh */ }
  return { entries: {} };
}

/**
 * Save the cache to disk, pruning expired and excess entries.
 */
function saveCache(cache) {
  const now = Date.now();

  // Prune expired entries
  for (const [key, entry] of Object.entries(cache.entries)) {
    if (entry.expires_at < now) {
      delete cache.entries[key];
    }
  }

  // If still too large, remove oldest entries
  const keys = Object.keys(cache.entries);
  if (keys.length > MAX_CACHE_ENTRIES) {
    const sorted = keys.sort((a, b) => cache.entries[a].created_at - cache.entries[b].created_at);
    const toRemove = sorted.slice(0, keys.length - MAX_CACHE_ENTRIES);
    for (const key of toRemove) {
      delete cache.entries[key];
    }
  }

  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
}

/**
 * Get cache stats for dashboard.
 */
export function getCacheStats() {
  const cache = loadCache();
  const now = Date.now();
  const entries = Object.values(cache.entries);
  const activeEntries = entries.filter(e => e.expires_at > now);

  // Count today's hits
  const today = new Date().toISOString().split('T')[0];
  const todayHits = entries.reduce((sum, e) =>
    sum + (e.hits || []).filter(h => h.startsWith(today)).length, 0
  );
  const todayChecks = cache.totalChecksToday || 0;

  return {
    totalEntries: activeEntries.length,
    todayHits,
    todayChecks,
    hitRate: todayChecks > 0 ? `${Math.round(todayHits / todayChecks * 100)}%` : '0%',
  };
}

/**
 * Check the dedup cache for a recent result matching this prompt.
 *
 * @param {string} prompt - The full prompt text
 * @param {string} model - The model being used
 * @param {number} ttlHours - Override TTL in hours (optional)
 * @returns {{ hit: boolean, result?: string, fingerprint: string }}
 */
export function cacheCheck(prompt, model = '', ttlHours = null) {
  const fingerprint = createFingerprint(prompt);
  const cache = loadCache();
  const now = Date.now();

  // Track check count for today
  const today = new Date().toISOString().split('T')[0];
  if (!cache.checksDate || cache.checksDate !== today) {
    cache.checksDate = today;
    cache.totalChecksToday = 0;
  }
  cache.totalChecksToday = (cache.totalChecksToday || 0) + 1;

  const entry = cache.entries[fingerprint];
  if (entry && entry.expires_at > now) {
    // Cache hit
    if (!entry.hits) entry.hits = [];
    entry.hits.push(new Date().toISOString());
    // Keep only last 50 hit timestamps
    if (entry.hits.length > 50) entry.hits = entry.hits.slice(-50);
    saveCache(cache);

    return {
      hit: true,
      result: entry.result,
      fingerprint,
      age_minutes: Math.round((now - entry.created_at) / 60000),
    };
  }

  saveCache(cache);
  return { hit: false, fingerprint };
}

/**
 * Store a result in the dedup cache.
 *
 * @param {string} prompt - The prompt that was sent
 * @param {string} result - The API response result text
 * @param {string} model - The model used
 * @param {number} ttlHours - TTL in hours (auto-detected if not provided)
 */
export function cacheStore(prompt, result, model = '', ttlHours = null) {
  if (!prompt || !result) return;

  const fingerprint = createFingerprint(prompt);
  const taskType = inferTaskType(prompt);
  const ttl = ttlHours || DEFAULT_TTLS[taskType] || DEFAULT_TTLS.default;
  const now = Date.now();

  const cache = loadCache();
  cache.entries[fingerprint] = {
    fingerprint,
    prompt_preview: prompt.slice(0, 100),
    result: typeof result === 'string' ? result : JSON.stringify(result),
    model,
    task_type: taskType,
    created_at: now,
    expires_at: now + ttl * 3600000,
    hits: [],
  };

  saveCache(cache);
}

export { createFingerprint, inferTaskType, DEFAULT_TTLS };
