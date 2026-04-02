/**
 * APEX Knowledge Base Gate
 *
 * Mandatory pre-flight check before any API call that involves research
 * or information retrieval. Searches the local knowledge base first —
 * if relevant content is found, returns it directly without spending tokens.
 *
 * Wired into cost-proxy.ts: runs before every gated API call.
 */

import fs from 'fs';
import path from 'path';

const KB_DIR = path.resolve(process.cwd(), 'groups/main/knowledge');
const KB_STATS_PATH = path.resolve(process.cwd(), 'kb-stats.json');

// Minimum keyword matches to consider a KB hit
const MIN_KEYWORD_MATCHES = 3;

// Characters per token estimate (matches prompt-compressor.js)
const CHARS_PER_TOKEN = 4;

/**
 * Extract keywords from a query string.
 * Strips common stop words and returns lowercase unique terms >= 3 chars.
 */
function extractKeywords(text) {
  const stopWords = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
    'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'some', 'them',
    'than', 'its', 'over', 'such', 'that', 'this', 'with', 'will', 'each',
    'make', 'like', 'from', 'just', 'into', 'what', 'when', 'who', 'how',
    'which', 'their', 'about', 'would', 'there', 'could', 'other', 'more',
    'very', 'after', 'should', 'also', 'these', 'where', 'most', 'only',
  ]);

  return [...new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !stopWords.has(w))
  )];
}

/**
 * Recursively read all .md files from a directory.
 */
function readKBFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip archive directory
      if (entry.name === 'archive' || entry.name === 'archives') continue;
      results.push(...readKBFiles(fullPath));
    } else if (entry.name.endsWith('.md')) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        results.push({ filename: entry.name, path: fullPath, content });
      } catch { /* skip unreadable */ }
    }
  }
  return results;
}

/**
 * Search KB files for relevance to a query.
 * Returns matching excerpts if enough keyword matches are found.
 */
function searchKB(keywords, kbFiles) {
  const matches = [];

  for (const file of kbFiles) {
    const contentLower = file.content.toLowerCase();
    let matchCount = 0;
    const matchedKeywords = [];

    for (const keyword of keywords) {
      if (contentLower.includes(keyword)) {
        matchCount++;
        matchedKeywords.push(keyword);
      }
    }

    if (matchCount >= MIN_KEYWORD_MATCHES) {
      // Extract relevant paragraphs containing matched keywords
      const paragraphs = file.content.split(/\n\n+/);
      const relevantParagraphs = paragraphs.filter(p => {
        const pLower = p.toLowerCase();
        return matchedKeywords.some(kw => pLower.includes(kw));
      });

      // Limit to first 5 relevant paragraphs, max 300 chars each
      const excerpts = relevantParagraphs
        .slice(0, 5)
        .map(p => p.length > 300 ? p.slice(0, 300) + '...' : p);

      matches.push({
        filename: file.filename,
        matchCount,
        matchedKeywords,
        excerpts,
      });
    }
  }

  // Sort by match count descending
  matches.sort((a, b) => b.matchCount - a.matchCount);
  return matches;
}

/**
 * Log a KB check result to kb-stats.json.
 */
function logKBCheck(query, taskType, hit, tokensSavedEstimate) {
  let stats = [];
  try {
    if (fs.existsSync(KB_STATS_PATH)) {
      stats = JSON.parse(fs.readFileSync(KB_STATS_PATH, 'utf-8'));
    }
  } catch { /* fresh stats */ }

  stats.push({
    date: new Date().toISOString(),
    query: query.slice(0, 100), // Truncate for storage
    taskType,
    hit,
    tokens_saved_estimate: tokensSavedEstimate,
  });

  // Keep last 500 entries
  if (stats.length > 500) {
    stats = stats.slice(-500);
  }

  fs.writeFileSync(KB_STATS_PATH, JSON.stringify(stats, null, 2) + '\n');
}

/**
 * Get KB stats summary for dashboard.
 */
export function getKBStats() {
  try {
    if (!fs.existsSync(KB_STATS_PATH)) return { total: 0, hits: 0, hitRate: '0%', tokensSaved: 0 };
    const stats = JSON.parse(fs.readFileSync(KB_STATS_PATH, 'utf-8'));

    const today = new Date().toISOString().split('T')[0];
    const todayStats = stats.filter(s => s.date.startsWith(today));

    const total = todayStats.length;
    const hits = todayStats.filter(s => s.hit).length;
    const tokensSaved = todayStats.reduce((sum, s) => sum + (s.tokens_saved_estimate || 0), 0);

    return {
      total,
      hits,
      hitRate: total > 0 ? `${Math.round(hits / total * 100)}%` : '0%',
      tokensSaved,
    };
  } catch {
    return { total: 0, hits: 0, hitRate: '0%', tokensSaved: 0 };
  }
}

/**
 * KB pre-flight check. Searches local knowledge base before making an API call.
 *
 * @param {string} query - The user query or prompt text
 * @param {string} taskType - The type of task (research_web, business_decision, etc.)
 * @returns {{ found: boolean, content?: string, source?: string }}
 */
export async function kbCheck(query, taskType = 'unknown') {
  if (!query || typeof query !== 'string') {
    return { found: false };
  }

  const keywords = extractKeywords(query);
  if (keywords.length < 2) {
    // Too few meaningful keywords to search
    return { found: false };
  }

  const kbFiles = readKBFiles(KB_DIR);
  if (kbFiles.length === 0) {
    return { found: false };
  }

  const matches = searchKB(keywords, kbFiles);

  if (matches.length > 0) {
    const topMatch = matches[0];
    const content = topMatch.excerpts.join('\n\n');
    const tokensSaved = Math.ceil(content.length / CHARS_PER_TOKEN) + 500; // Estimate saved API tokens

    logKBCheck(query, taskType, true, tokensSaved);

    return {
      found: true,
      content,
      source: topMatch.filename,
      matchCount: topMatch.matchCount,
      keywords: topMatch.matchedKeywords,
    };
  }

  logKBCheck(query, taskType, false, 0);
  return { found: false };
}

export { extractKeywords, readKBFiles, searchKB, KB_DIR };
