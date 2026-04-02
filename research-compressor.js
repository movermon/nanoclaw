/**
 * APEX Research Compression Pipeline
 *
 * Runs after ANY research task completes — web search, web fetch,
 * competitor analysis, market research. Compresses raw findings
 * before they are stored or passed anywhere.
 *
 * Rule: NEVER store raw research results. Compressed only.
 */

import fs from 'fs';
import path from 'path';

const COMPRESSION_STATS_PATH = path.resolve(process.cwd(), 'compression-stats.json');
const CHARS_PER_TOKEN = 4;
const MAX_BULLETS = 20;

/**
 * Strip HTML tags from text.
 */
function stripHTML(text) {
  return text
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '');
}

/**
 * Strip markdown formatting.
 */
function stripMarkdown(text) {
  return text
    .replace(/^#{1,6}\s+/gm, '')        // Headers
    .replace(/\*\*([^*]+)\*\*/g, '$1')   // Bold
    .replace(/\*([^*]+)\*/g, '$1')       // Italic
    .replace(/__([^_]+)__/g, '$1')       // Bold
    .replace(/_([^_]+)_/g, '$1')         // Italic
    .replace(/~~([^~]+)~~/g, '$1')       // Strikethrough
    .replace(/`([^`]+)`/g, '$1')         // Inline code
    .replace(/```[\s\S]*?```/g, '')      // Code blocks
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Links — keep text, drop URL
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, ''); // Images
}

/**
 * Reduce full URLs to domain only.
 * "https://www.example.com/path/to/page?q=1" -> "example.com"
 */
function urlToDomain(text) {
  return text.replace(/https?:\/\/(?:www\.)?([^\/\s?#]+)[^\s]*/g, '[$1]');
}

/**
 * Extract key facts from text. Returns array of fact strings.
 */
function extractFacts(text) {
  // Split into sentences
  const sentences = text
    .split(/[.!?]\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 15 && s.length < 300);

  // Score sentences by information density
  const scored = sentences.map(s => {
    let score = 0;
    // Contains numbers (data, stats, dates)
    if (/\d/.test(s)) score += 3;
    // Contains comparison words
    if (/\b(more|less|better|worse|higher|lower|increased|decreased|growth|decline)\b/i.test(s)) score += 2;
    // Contains business terms
    if (/\b(revenue|profit|customer|market|price|cost|sale|product|service|competitor)\b/i.test(s)) score += 2;
    // Contains action words
    if (/\b(launched|announced|released|partnered|acquired|expanded|closed|opened)\b/i.test(s)) score += 2;
    // Penalize filler
    if (/\b(however|therefore|furthermore|additionally|moreover)\b/i.test(s)) score -= 1;
    if (/\b(it is|there are|this is|that is)\b/i.test(s)) score -= 1;
    // Penalize very short or very long
    if (s.length < 30) score -= 1;
    if (s.length > 200) score -= 1;

    return { text: s, score };
  });

  // Sort by score descending and take top facts
  scored.sort((a, b) => b.score - a.score);

  return scored
    .filter(s => s.score >= 1) // Minimum quality threshold
    .slice(0, MAX_BULLETS * 2) // Take 2x to allow deduplication
    .map(s => s.text);
}

/**
 * Deduplicate facts. If two facts share >60% of their words, keep the better one.
 */
function deduplicateFacts(facts) {
  const unique = [];

  for (const fact of facts) {
    const factWords = new Set(fact.toLowerCase().split(/\s+/).filter(w => w.length >= 3));
    let isDuplicate = false;

    for (const existing of unique) {
      const existingWords = new Set(existing.toLowerCase().split(/\s+/).filter(w => w.length >= 3));
      const intersection = [...factWords].filter(w => existingWords.has(w));
      const overlap = intersection.length / Math.min(factWords.size, existingWords.size);

      if (overlap > 0.6) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      unique.push(fact);
    }
  }

  return unique;
}

/**
 * Log compression stats.
 */
function logCompressionStats(topic, originalTokens, compressedTokens, ratio) {
  let stats = [];
  try {
    if (fs.existsSync(COMPRESSION_STATS_PATH)) {
      stats = JSON.parse(fs.readFileSync(COMPRESSION_STATS_PATH, 'utf-8'));
    }
  } catch { /* fresh */ }

  stats.push({
    date: new Date().toISOString(),
    topic: (topic || '').slice(0, 100),
    originalTokens,
    compressedTokens,
    ratio,
  });

  // Keep last 200 entries
  if (stats.length > 200) {
    stats = stats.slice(-200);
  }

  fs.writeFileSync(COMPRESSION_STATS_PATH, JSON.stringify(stats, null, 2) + '\n');
}

/**
 * Get compression stats summary for dashboard.
 */
export function getCompressionStats() {
  try {
    if (!fs.existsSync(COMPRESSION_STATS_PATH)) return { total: 0, avgRatio: '0x', totalTokensSaved: 0 };
    const stats = JSON.parse(fs.readFileSync(COMPRESSION_STATS_PATH, 'utf-8'));

    const today = new Date().toISOString().split('T')[0];
    const todayStats = stats.filter(s => s.date.startsWith(today));

    const total = todayStats.length;
    const avgRatio = total > 0
      ? (todayStats.reduce((sum, s) => sum + s.ratio, 0) / total).toFixed(1)
      : '0';
    const totalTokensSaved = todayStats.reduce((sum, s) => sum + (s.originalTokens - s.compressedTokens), 0);

    return { total, avgRatio: `${avgRatio}x`, totalTokensSaved };
  } catch {
    return { total: 0, avgRatio: '0x', totalTokensSaved: 0 };
  }
}

/**
 * Compress raw research findings into structured bullet points.
 *
 * @param {string} rawFindings - The raw research text (HTML, markdown, plain text)
 * @param {string} topic - The research topic
 * @param {string} businessRelevance - Which business this relates to
 * @returns {{ compressed: string, originalTokens: number, compressedTokens: number, ratio: number, bulletCount: number }}
 */
export async function compressResearch(rawFindings, topic = '', businessRelevance = '') {
  if (!rawFindings || typeof rawFindings !== 'string') {
    return { compressed: '', originalTokens: 0, compressedTokens: 0, ratio: 1, bulletCount: 0 };
  }

  const originalTokens = Math.ceil(rawFindings.length / CHARS_PER_TOKEN);

  // 1. Strip HTML and markdown formatting
  let text = stripHTML(rawFindings);
  text = stripMarkdown(text);

  // 2. Reduce URLs to domains
  text = urlToDomain(text);

  // 3. Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();

  // 4. Extract key facts
  const facts = extractFacts(text);

  // 5. Deduplicate
  const uniqueFacts = deduplicateFacts(facts);

  // 6. Format as structured bullet points, max 20
  const bullets = uniqueFacts.slice(0, MAX_BULLETS);

  // 7. Build compressed output with source attribution
  const header = topic ? `## ${topic}` : '## Research Findings';
  const businessLine = businessRelevance ? `Business: ${businessRelevance}\n` : '';
  const compressed = [
    header,
    businessLine,
    ...bullets.map(b => `- ${b}`),
    '',
    `Compressed: ${new Date().toISOString().split('T')[0]}`,
  ].join('\n').trim();

  const compressedTokens = Math.ceil(compressed.length / CHARS_PER_TOKEN);
  const ratio = compressedTokens > 0 ? Math.round(originalTokens / compressedTokens * 10) / 10 : 1;

  // 8. Log compression stats
  logCompressionStats(topic, originalTokens, compressedTokens, ratio);

  return {
    compressed,
    originalTokens,
    compressedTokens,
    ratio,
    bulletCount: bullets.length,
  };
}

export { stripHTML, stripMarkdown, urlToDomain, COMPRESSION_STATS_PATH };
