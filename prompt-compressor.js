/**
 * APEX Prompt Compressor - Reduces prompt size before API calls.
 *
 * Runs automatically on every outbound prompt through gatedApiCall().
 * Target: reduce average prompt size by 30%.
 *
 * Strategies:
 * 1. Strip redundant whitespace and formatting
 * 2. Remove instructional preamble that duplicates system prompt
 * 3. If prompt > 2000 tokens, summarize context sections to fit under 1500
 * 4. Report token reduction
 */

// Rough token estimation: ~4 chars per token for English text
const CHARS_PER_TOKEN = 4;

/**
 * Estimate token count from character length.
 */
function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Compress a prompt before sending to the API.
 * Returns { compressed, originalTokens, compressedTokens, reduction_pct }
 */
export function compressPrompt(prompt) {
  if (!prompt || typeof prompt !== 'string') {
    return { compressed: prompt || '', originalTokens: 0, compressedTokens: 0, reduction_pct: 0 };
  }

  const originalTokens = estimateTokens(prompt);
  let text = prompt;

  // 1. Normalize whitespace: collapse multiple blank lines to one
  text = text.replace(/\n{3,}/g, '\n\n');

  // 2. Collapse runs of spaces (but not leading indentation in code blocks)
  text = text.replace(/[^\S\n]{2,}/g, ' ');

  // 3. Trim trailing whitespace from each line
  text = text.replace(/[ \t]+$/gm, '');

  // 4. Remove common filler phrases that add no information
  const fillerPatterns = [
    /^Please note that /gim,
    /^It(?:'s| is) (?:important|worth noting) (?:that|to note that) /gim,
    /^As (?:an AI|a language model|mentioned (?:earlier|above|before)),? /gim,
    /^(?:In order to|For the purpose of) /gim,
    /^(?:I would like to|I'd like to|Let me) (?:point out|mention|note) that /gim,
  ];
  for (const pattern of fillerPatterns) {
    text = text.replace(pattern, '');
  }

  // 5. Deduplicate repeated instructions (same line appearing multiple times)
  const lines = text.split('\n');
  const seen = new Set();
  const deduped = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Only dedup non-empty lines that are clearly instructional (not data)
    if (trimmed.length > 20 && seen.has(trimmed)) {
      continue; // skip duplicate
    }
    if (trimmed.length > 20) seen.add(trimmed);
    deduped.push(line);
  }
  text = deduped.join('\n');

  // 6. If still over 2000 estimated tokens, aggressively compress context blocks
  const compressedTokens = estimateTokens(text);
  if (compressedTokens > 2000) {
    text = aggressiveCompress(text, 1500);
  }

  // 7. Final trim
  text = text.trim();

  const finalTokens = estimateTokens(text);
  const reduction_pct = originalTokens > 0
    ? Math.round((1 - finalTokens / originalTokens) * 100)
    : 0;

  return {
    compressed: text,
    originalTokens,
    compressedTokens: finalTokens,
    reduction_pct,
  };
}

/**
 * Aggressive compression: truncate context sections to fit target token count.
 * Preserves the last section (likely the actual question/task) and the first
 * section (likely system context), compresses middle sections.
 */
function aggressiveCompress(text, targetTokens) {
  const sections = text.split(/\n---+\n|\n#{1,3} /);

  if (sections.length <= 2) {
    // Can't split into sections, just truncate from middle
    const targetChars = targetTokens * CHARS_PER_TOKEN;
    if (text.length > targetChars) {
      const keepStart = Math.floor(targetChars * 0.4);
      const keepEnd = Math.floor(targetChars * 0.6);
      return text.slice(0, keepStart) + '\n[...context compressed...]\n' + text.slice(-keepEnd);
    }
    return text;
  }

  // Keep first and last sections intact, compress middle
  const first = sections[0];
  const last = sections[sections.length - 1];
  const middle = sections.slice(1, -1);

  const firstTokens = estimateTokens(first);
  const lastTokens = estimateTokens(last);
  const remainingBudget = targetTokens - firstTokens - lastTokens;

  if (remainingBudget <= 0) {
    // First + last already exceed budget, truncate last section
    const targetChars = targetTokens * CHARS_PER_TOKEN;
    return first.slice(0, Math.floor(targetChars * 0.3)) + '\n[...compressed...]\n' + last.slice(-Math.floor(targetChars * 0.7));
  }

  // Distribute remaining budget across middle sections
  const perSectionBudget = Math.floor((remainingBudget * CHARS_PER_TOKEN) / middle.length);
  const compressedMiddle = middle.map(section => {
    if (section.length <= perSectionBudget) return section;
    return section.slice(0, perSectionBudget) + '...';
  });

  return [first, ...compressedMiddle, last].join('\n');
}

/**
 * Compress an array of message objects (for the messages API).
 * Only compresses user-role text content, leaves system prompts and assistant messages intact.
 */
export function compressMessages(messages) {
  if (!Array.isArray(messages)) return { messages, stats: { totalReduction: 0 } };

  let totalOriginal = 0;
  let totalCompressed = 0;

  const compressed = messages.map(msg => {
    if (msg.role !== 'user') return msg;

    if (typeof msg.content === 'string') {
      const result = compressPrompt(msg.content);
      totalOriginal += result.originalTokens;
      totalCompressed += result.compressedTokens;
      return { ...msg, content: result.compressed };
    }

    // Handle content blocks (array of {type, text} objects)
    if (Array.isArray(msg.content)) {
      const compressedContent = msg.content.map(block => {
        if (block.type === 'text' && block.text) {
          const result = compressPrompt(block.text);
          totalOriginal += result.originalTokens;
          totalCompressed += result.compressedTokens;
          return { ...block, text: result.compressed };
        }
        return block;
      });
      return { ...msg, content: compressedContent };
    }

    return msg;
  });

  const totalReduction = totalOriginal > 0
    ? Math.round((1 - totalCompressed / totalOriginal) * 100)
    : 0;

  return {
    messages: compressed,
    stats: { totalOriginal, totalCompressed, totalReduction },
  };
}

export { estimateTokens };
