/**
 * APEX Context Brief Enforcer
 *
 * Generates compressed context briefs for subagents instead of passing
 * full conversation history and full CLAUDE.md. Maximum 500 tokens per brief.
 *
 * Wired into container-runner.ts: called automatically before every subagent spawn.
 */

import fs from 'fs';
import path from 'path';
import { kbCheck, KB_DIR, readKBFiles } from './kb-gate.js';

const CHARS_PER_TOKEN = 4;
const MAX_BRIEF_TOKENS = 500;
const MAX_BRIEF_CHARS = MAX_BRIEF_TOKENS * CHARS_PER_TOKEN; // 2000 chars

/**
 * Estimate token count from text length.
 */
function estimateTokens(text) {
  return Math.ceil((text || '').length / CHARS_PER_TOKEN);
}

/**
 * Get the relevant KB file paths for a given task.
 * Only returns files that match keywords in the task description.
 */
export function getRelevantKBFiles(task, businesses = []) {
  const kbFiles = readKBFiles(KB_DIR);
  if (kbFiles.length === 0) return [];

  const taskLower = (task || '').toLowerCase();
  const businessLower = businesses.map(b => (b || '').toLowerCase());

  return kbFiles.filter(file => {
    const contentLower = file.content.toLowerCase();
    const fileNameLower = file.filename.toLowerCase();

    // Check if file relates to the task
    const taskWords = taskLower.split(/\s+/).filter(w => w.length >= 4);
    const taskRelevance = taskWords.filter(w => contentLower.includes(w)).length;

    // Check if file relates to specified businesses
    const businessRelevance = businessLower.some(b =>
      contentLower.includes(b) || fileNameLower.includes(b)
    );

    return taskRelevance >= 2 || businessRelevance;
  }).map(f => f.path);
}

/**
 * Build a compressed context brief for a subagent.
 *
 * @param {string} task - What the subagent must do
 * @param {string[]} relevantBusinesses - Business names relevant to this task
 * @param {Object[]} priorFindings - Previous relevant findings [{summary, source}]
 * @param {Object} constraints - { budgetRemaining, model, maxTokens }
 * @returns {{ brief: string, tokenCount: number, kbFilePaths: string[] }}
 */
export function buildBrief(task, relevantBusinesses = [], priorFindings = [], constraints = {}) {
  const sections = [];

  // Mission — always 1 sentence
  sections.push('Mission: Personal AI assistant managing business operations and daily tasks.');

  // Business context — only relevant businesses, max 3 bullets
  if (relevantBusinesses.length > 0) {
    const businessLines = relevantBusinesses.slice(0, 3).map(b => `- ${b}`);
    sections.push(`Business context:\n${businessLines.join('\n')}`);
  }

  // Known facts from KB — max 5 items
  const kbFiles = readKBFiles(KB_DIR);
  const taskLower = (task || '').toLowerCase();
  const knownFacts = [];

  for (const file of kbFiles) {
    if (knownFacts.length >= 5) break;
    const contentLower = file.content.toLowerCase();
    const paragraphs = file.content.split(/\n\n+/);

    for (const para of paragraphs) {
      if (knownFacts.length >= 5) break;
      const paraLower = para.toLowerCase();
      const taskWords = taskLower.split(/\s+/).filter(w => w.length >= 4);
      const matches = taskWords.filter(w => paraLower.includes(w)).length;
      if (matches >= 2) {
        // Truncate to 100 chars
        knownFacts.push(`- ${para.slice(0, 100).replace(/\n/g, ' ')}${para.length > 100 ? '...' : ''}`);
      }
    }
  }

  if (knownFacts.length > 0) {
    sections.push(`Known facts:\n${knownFacts.join('\n')}`);
  }

  // Constraints
  const budgetRemaining = constraints.budgetRemaining || 'unknown';
  const model = constraints.model || 'claude-haiku-4-5-20251001';
  const maxTokens = constraints.maxTokens || 1024;
  sections.push(`Constraints: budget=$${budgetRemaining}, model=${model}, max_tokens=${maxTokens}`);

  // Prior findings — max 5 items, compressed
  if (priorFindings.length > 0) {
    const findings = priorFindings.slice(0, 5).map(f => {
      const summary = (f.summary || f).toString().slice(0, 80);
      return `- ${summary}${f.source ? ` (${f.source})` : ''}`;
    });
    sections.push(`Prior findings:\n${findings.join('\n')}`);
  }

  // Task — exactly 1 sentence
  const taskLine = (task || 'No task specified').split('\n')[0].slice(0, 200);
  sections.push(`Task: ${taskLine}`);

  // Output format
  sections.push('Output format: Return structured findings as bullet points. Be concise.');

  // Assemble brief
  let brief = `APEX CONTEXT BRIEF\n==================\n${sections.join('\n\n')}\n==================`;

  // If over budget, trim lower-priority sections
  let tokenCount = estimateTokens(brief);
  if (tokenCount > MAX_BRIEF_TOKENS) {
    // Remove prior findings first
    if (priorFindings.length > 0) {
      const idx = sections.findIndex(s => s.startsWith('Prior findings'));
      if (idx !== -1) sections.splice(idx, 1);
    }
    brief = `APEX CONTEXT BRIEF\n==================\n${sections.join('\n\n')}\n==================`;
    tokenCount = estimateTokens(brief);
  }

  if (tokenCount > MAX_BRIEF_TOKENS) {
    // Remove known facts
    const idx = sections.findIndex(s => s.startsWith('Known facts'));
    if (idx !== -1) sections.splice(idx, 1);
    brief = `APEX CONTEXT BRIEF\n==================\n${sections.join('\n\n')}\n==================`;
    tokenCount = estimateTokens(brief);
  }

  if (tokenCount > MAX_BRIEF_TOKENS) {
    // Last resort: truncate the whole thing
    brief = brief.slice(0, MAX_BRIEF_CHARS);
    tokenCount = MAX_BRIEF_TOKENS;
  }

  // Get relevant KB file paths for selective mounting
  const kbFilePaths = getRelevantKBFiles(task, relevantBusinesses);

  return {
    brief,
    tokenCount,
    kbFilePaths,
  };
}

export { estimateTokens, MAX_BRIEF_TOKENS };
