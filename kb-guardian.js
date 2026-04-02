/**
 * APEX KB Guardian
 *
 * Runs on a schedule every 6 hours to enforce knowledge base hygiene:
 * 1. Archive oversized KB files (>150 lines)
 * 2. Deduplicate cross-file content
 * 3. Send weekly KB health summary
 *
 * Scheduled in src/index.ts.
 */

import fs from 'fs';
import path from 'path';

import { getKBStats } from './kb-gate.js';
import { getCompressionStats } from './research-compressor.js';

const KB_DIR = path.resolve(process.cwd(), 'groups/main/knowledge');
const ARCHIVE_DIR = path.join(KB_DIR, 'archive');
const GUARDIAN_LOG_PATH = path.resolve(process.cwd(), 'kb-guardian-log.json');

const MAX_LINES = 150;

/**
 * Read all .md files in a directory (non-recursive, skips archive).
 */
function readMainKBFiles() {
  const files = [];
  if (!fs.existsSync(KB_DIR)) return files;

  const entries = fs.readdirSync(KB_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const fullPath = path.join(KB_DIR, entry.name);
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      files.push({ name: entry.name, path: fullPath, content, lines, lineCount: lines.length });
    } catch { /* skip */ }
  }
  return files;
}

/**
 * Archive old entries from oversized files.
 * Takes the oldest entries (from the top of the file, after any header)
 * and moves them to the archive directory.
 */
function archiveOversizedFiles(files) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const archived = [];

  for (const file of files) {
    if (file.lineCount <= MAX_LINES) continue;

    const lines = file.lines;

    // Find header end (first blank line after title, or first 5 lines)
    let headerEnd = 0;
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      if (lines[i].startsWith('#') || lines[i].trim() === '') {
        headerEnd = i + 1;
      } else {
        break;
      }
    }

    const header = lines.slice(0, headerEnd);
    const body = lines.slice(headerEnd);

    // Calculate how many lines to archive (bring file to 100 lines to provide buffer)
    const targetBodyLines = 100 - headerEnd;
    const linesToArchive = body.length - targetBodyLines;

    if (linesToArchive <= 0) continue;

    // Archive the oldest entries (from the top of the body)
    const archivedContent = body.slice(0, linesToArchive).join('\n');
    const remainingContent = [...header, ...body.slice(linesToArchive)].join('\n');

    // Write archive file
    const datestamp = new Date().toISOString().split('T')[0];
    const archiveFilename = `${file.name.replace('.md', '')}-${datestamp}.md`;
    const archivePath = path.join(ARCHIVE_DIR, archiveFilename);
    fs.writeFileSync(archivePath, `# Archived from ${file.name} on ${datestamp}\n\n${archivedContent}\n`);

    // Update original file
    fs.writeFileSync(file.path, remainingContent);

    archived.push({
      file: file.name,
      linesArchived: linesToArchive,
      archivePath: archiveFilename,
    });
  }

  return archived;
}

/**
 * Find and remove duplicate facts across KB files.
 * If the same paragraph appears in 2+ files, keep it in the most relevant file
 * (determined by filename matching the paragraph content).
 */
function deduplicateAcrossFiles(files) {
  const removed = [];

  // Build a map of paragraphs to files
  const paragraphMap = new Map(); // paragraph -> [{ file, index }]

  for (const file of files) {
    const paragraphs = file.content.split(/\n\n+/);
    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i].trim();
      if (para.length < 30) continue; // Skip short paragraphs
      if (para.startsWith('#')) continue; // Skip headers

      const key = para.toLowerCase().replace(/\s+/g, ' ');
      if (!paragraphMap.has(key)) {
        paragraphMap.set(key, []);
      }
      paragraphMap.get(key).push({ file: file.name, path: file.path, index: i });
    }
  }

  // Find duplicates and remove from less-relevant files
  for (const [key, locations] of paragraphMap) {
    if (locations.length < 2) continue;

    // Keep in the file whose name best matches the paragraph content
    const paraWords = key.split(/\s+/).filter(w => w.length >= 4);
    let bestMatch = locations[0];
    let bestScore = 0;

    for (const loc of locations) {
      const fileNameLower = loc.file.toLowerCase().replace('.md', '').replace(/[-_]/g, ' ');
      const score = paraWords.filter(w => fileNameLower.includes(w)).length;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = loc;
      }
    }

    // Remove from all files except the best match
    for (const loc of locations) {
      if (loc === bestMatch) continue;

      try {
        let content = fs.readFileSync(loc.path, 'utf-8');
        const paragraphs = content.split(/\n\n+/);
        // Find and remove the duplicate paragraph
        const dupIdx = paragraphs.findIndex(p =>
          p.trim().toLowerCase().replace(/\s+/g, ' ') === key
        );
        if (dupIdx !== -1) {
          paragraphs.splice(dupIdx, 1);
          fs.writeFileSync(loc.path, paragraphs.join('\n\n'));
          removed.push({ file: loc.file, keptIn: bestMatch.file, snippet: key.slice(0, 60) });
        }
      } catch { /* skip */ }
    }
  }

  return removed;
}

/**
 * Get KB health summary for reporting.
 */
export function getKBHealth() {
  const files = readMainKBFiles();
  const kbStats = getKBStats();
  const compressionStats = getCompressionStats();

  const fileHealth = files.map(f => ({
    name: f.name,
    lines: f.lineCount,
    overLimit: f.lineCount > MAX_LINES,
  }));

  const totalLines = files.reduce((sum, f) => sum + f.lineCount, 0);
  const oversizedCount = files.filter(f => f.lineCount > MAX_LINES).length;

  return {
    fileCount: files.length,
    totalLines,
    oversizedCount,
    files: fileHealth,
    kbHitRate: kbStats.hitRate,
    kbTokensSaved: kbStats.tokensSaved,
    compressionRatio: compressionStats.avgRatio,
    compressionTokensSaved: compressionStats.totalTokensSaved,
  };
}

/**
 * Run the guardian check. Called every 6 hours.
 */
export async function runGuardian() {
  const startTime = Date.now();
  const files = readMainKBFiles();

  // 1. Archive oversized files
  const archived = archiveOversizedFiles(files);

  // 2. Deduplicate across files (reload after archiving)
  const freshFiles = readMainKBFiles();
  const deduped = deduplicateAcrossFiles(freshFiles);

  // 3. Log results
  const result = {
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    archived,
    deduplicated: deduped,
    filesChecked: files.length,
  };

  let log = [];
  try {
    if (fs.existsSync(GUARDIAN_LOG_PATH)) {
      log = JSON.parse(fs.readFileSync(GUARDIAN_LOG_PATH, 'utf-8'));
    }
  } catch { /* fresh */ }

  log.push(result);
  if (log.length > 100) log = log.slice(-100);
  fs.writeFileSync(GUARDIAN_LOG_PATH, JSON.stringify(log, null, 2) + '\n');

  return result;
}

/**
 * Format KB health as a Telegram message (for weekly Sunday summary).
 */
export function formatKBHealthMessage() {
  const health = getKBHealth();

  const lines = [
    `\u{1f4da} *KB Health Report*`,
    ``,
    `*Files:* ${health.fileCount} (${health.totalLines} total lines)`,
    `*Oversized:* ${health.oversizedCount} files over ${MAX_LINES} lines`,
    ``,
    `*KB Hit Rate:* ${health.kbHitRate}`,
    `*KB Tokens Saved:* ${health.kbTokensSaved.toLocaleString()}`,
    `*Compression Ratio:* ${health.compressionRatio}`,
    `*Compression Tokens Saved:* ${health.compressionTokensSaved.toLocaleString()}`,
    ``,
    `*File Details:*`,
  ];

  for (const f of health.files) {
    const indicator = f.overLimit ? '\u{26a0}\u{fe0f}' : '\u{2705}';
    lines.push(`${indicator} ${f.name}: ${f.lines} lines`);
  }

  return lines.join('\n');
}

export { KB_DIR, ARCHIVE_DIR, MAX_LINES };
