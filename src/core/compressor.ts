/**
 * Compressor.
 *
 * Four levels, each a superset of the previous one:
 *
 * | level        | what it removes                                            |
 * | ------------ | ---------------------------------------------------------- |
 * | `none`       | nothing except secret redaction                            |
 * | `light`      | secret redaction + long licence banners                     |
 * | `balanced`   | + comments and runs of blank lines                          |
 * | `aggressive` | + long function bodies collapsed to a signature + marker     |
 *
 * Everything is done with a *state-aware scanner* ({@link maskCode}), so a
 * `//` inside a string, a `/*` inside a regex or a `#` inside a template literal
 * is left alone. That is the one thing a naive `replace` gets wrong and the
 * reason this file is longer than it looks.
 *
 * Compression is **idempotent**: the original body is kept in
 * `FileRecord.fullContent`, and every pass recomputes from it. Running the
 * pipeline twice produces byte-identical output.
 *
 * @module core/compressor
 */

import type { CompressionLevel, FileRecord, PackConfig } from '../types.js';
import { languageById } from './languages.js';
import { redactSecrets } from './redactor.js';
import { estimateTokens } from '../utils/tokenizer.js';

/** Languages whose block syntax the brace-aware passes may touch. */
const C_LIKE_FAMILIES: ReadonlySet<string> = new Set([
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'java',
  'kotlin',
  'csharp',
  'cpp',
  'c',
  'go',
  'rust',
  'swift',
  'php',
  'scala',
  'dart',
  'solidity',
  'vue',
  'svelte',
]);

/** Keywords that open a block which must never be collapsed. */
const CONTROL_KEYWORDS = /\b(if|else|for|while|switch|try|catch|finally|do|match|when|case|using|lock)\b/;

/** Recognises the line that opens a function/method/class body. */
const BODY_OPEN_RE = /(?:function\s*[\w$]*|=>[\s\S]*\{|\)\s*\{\s*$|\)\s*:\s*[\w<>[\]|.? ]+\{\s*$|\bclass\s+[\w$]+|\bfunc\s+[\w$]*|\)\s+[\w<>[\]*& ]+\{\s*$)/;

/** Minimum block size before aggressive elision kicks in. */
const ELISION_MIN_LINES = 40;

/** Lines kept from the head of an elided block. */
const ELISION_KEEP_HEAD = 4;

/**
 * Character-state flags produced by {@link maskCode}.
 *
 * `code[i] === true` means byte `i` is real code (not inside a string, template,
 * regex or comment).
 */
export interface CodeMask {
  code: boolean[];
  comments: [start: number, end: number][];
  strings: [start: number, end: number][];
}

export interface MaskOptions {
  /** Single-line comment token, e.g. `//` or `#`. */
  lineComment?: string;
  /** Block comment pair, e.g. `['/*', '*​/']`. */
  blockComment?: readonly [string, string];
  /** Enable `'`, `"` and `` ` `` string handling (JS-family). */
  strings?: boolean;
  /** Enable regex-literal handling (JS-family only). */
  regex?: boolean;
}

/**
 * Scan `source` and classify every character.
 *
 * This is intentionally a hand-written state machine rather than a regex: it is
 * the only way to keep comments inside strings intact.
 */
export function maskCode(source: string, options: MaskOptions = {}): CodeMask {
  const { lineComment = '//', blockComment, strings = true, regex = true } = options;
  const code: boolean[] = new Array(source.length).fill(true);
  const comments: [number, number][] = [];
  const stringRanges: [number, number][] = [];

  let i = 0;
  let prevSignificant = '';
  const len = source.length;

  const mark = (from: number, to: number, asCode: boolean): void => {
    for (let k = from; k < to && k < len; k += 1) code[k] = asCode;
  };

  while (i < len) {
    const char = source[i]!;
    const next = source[i + 1] ?? '';

    // Line comment
    if (lineComment && char === lineComment[0] && lineComment.length === 1 && source.startsWith(lineComment, i)) {
      // `#` comments: only when the token is a full `#` (not `#!` shebang handling — that is fine to keep)
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? len : end;
      if (!(source.startsWith('#!', i) && i === 0)) {
        mark(i, stop, false);
        comments.push([i, stop]);
      }
      i = stop;
      continue;
    }

    if (lineComment && lineComment.length === 2 && char === lineComment[0] && next === lineComment[1]) {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? len : end;
      mark(i, stop, false);
      comments.push([i, stop]);
      i = stop;
      continue;
    }

    if (blockComment && source.startsWith(blockComment[0], i)) {
      const closeAt = source.indexOf(blockComment[1], i + blockComment[0].length);
      const stop = closeAt === -1 ? len : closeAt + blockComment[1].length;
      mark(i, stop, false);
      comments.push([i, stop]);
      i = stop;
      continue;
    }

    if (strings && (char === '"' || char === "'" || char === '`')) {
      const { end, closed } = readString(source, i, char);
      mark(i, end, false);
      stringRanges.push([i, end]);
      i = closed ? end : end;
      prevSignificant = 'string';
      continue;
    }

    if (regex && char === '/' && regexAllowedAfter(prevSignificant)) {
      const end = readRegex(source, i);
      if (end > 0) {
        mark(i, end, false);
        stringRanges.push([i, end]);
        i = end;
        prevSignificant = 'regex';
        continue;
      }
    }

    if (!/\s/.test(char)) prevSignificant = char;
    i += 1;
  }

  return { code, comments, strings: stringRanges };
}

/** Read a string literal starting at `start`; returns the exclusive end. */
function readString(source: string, start: number, quote: string): { end: number; closed: boolean } {
  let i = start + 1;
  while (i < source.length) {
    const char = source[i]!;
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === quote) return { end: i + 1, closed: true };
    if (char === '\n' && quote !== '`') return { end: i, closed: false };
    // Template literal interpolation: skip `${...}` contents as code-ish.
    if (quote === '`' && char === '$' && source[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        const inner = source[i]!;
        if (inner === '{') depth += 1;
        else if (inner === '}') depth -= 1;
        else if (inner === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return { end: source.length, closed: false };
}

/** Read a regex literal starting at `start`; returns exclusive end or 0. */
function readRegex(source: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const char = source[i]!;
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) {
      i += 1;
      while (i < source.length && /[a-z]/i.test(source[i]!)) i += 1;
      return i;
    } else if (char === '\n') {
      return 0;
    }
    i += 1;
  }
  return 0;
}

/** Whether a `/` after `previous` can begin a regex literal. */
function regexAllowedAfter(previous: string): boolean {
  if (previous === '') return true;
  return /[=(,:[!&|?{};+\-*%<>~^]/.test(previous) || previous === 'return' || previous === 'typeof' || previous === 'case';
}

/* -------------------------------------------------------------------------- */
/* Passes                                                                     */
/* -------------------------------------------------------------------------- */

/** Remove region `[start, end)` from `source`, in one pass. */
function cut(source: string, ranges: ReadonlyArray<readonly [number, number]>): string {
  if (ranges.length === 0) return source;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (start < cursor) continue;
    out += source.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  out += source.slice(cursor);
  return out;
}

/** Collapse 3+ blank lines into one and trim trailing spaces. */
export function collapseBlankLines(source: string): string {
  return source
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n');
}

/** Strip an SPDX/licence banner that exceeds `maxLines`. */
export function stripLicenseBanner(source: string, maxLines = 6): string {
  const lines = source.split('\n');
  let index = 0;
  while (index < lines.length && lines[index]!.trim() === '') index += 1;
  const first = lines[index] ?? '';
  if (!/^[ \t]*(?:\/\*|\*|#|--|<!--|"""|'''|\/\/)/.test(first)) return source;
  const start = index;
  let end = start;
  while (end < lines.length && (lines[end]!.trim() === '' || /^\s*(\*|\/\/|#|--|<!--|-->|\/\*|"""|''')/.test(lines[end]!))) {
    if (/the mit license|apache license|copyright|all rights reserved|gnu general public/i.test(lines[end]!)) {
      // keep scanning; this is a licence banner
      end += 1;
      continue;
    }
    end += 1;
    if (end - start > 40) break;
  }
  const looksLikeBanner = /license|copyright|all rights reserved/i.test(lines.slice(start, end).join(' '));
  if (!looksLikeBanner || end - start <= maxLines) return source;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

/** Remove comments, keeping shebangs and imperative comment directives. */
export function stripComments(source: string, languageId: string): string {
  const spec = languageById(languageId);
  const cLike = C_LIKE_FAMILIES.has(languageId);
  const mask = maskCode(source, {
    lineComment: spec?.comment,
    blockComment: spec?.block,
    strings: cLike || languageId === 'python',
    regex: cLike,
  });

  const ranges = mask.comments.filter(([start, end]) => {
    const text = source.slice(start, end);
    if (/^#!/.test(text)) return false;
    if (/\b(eslint|@ts-|prettier|biome|ts-expect-error|ts-ignore|noqa|type:\s*ignore|istanbul|c8 ignore|pragma:)/.test(text)) return false;
    return true;
  });

  const without = cut(source, ranges);
  // Removing a comment can leave a blank line behind; tidy that lightly.
  return without
    .split('\n')
    .filter((line, index, all) => !(line.trim() === '' && all[index - 1]?.trim() === ''))
    .join('\n');
}

/** Replace long function bodies with a signature plus elision marker. */
export function elideLongBodies(source: string, languageId: string): { text: string; elided: number } {
  if (!C_LIKE_FAMILIES.has(languageId)) return { text: source, elided: 0 };
  const spec = languageById(languageId);
  const cLike = true;
  const mask = maskCode(source, {
    lineComment: spec?.comment,
    blockComment: spec?.block,
    strings: cLike,
    regex: cLike,
  });

  const lines = lineStarts(source);
  const ranges: [number, number][] = [];
  const stack: Array<{ index: number; candidate: boolean; openLine: number }> = [];

  for (let i = 0; i < source.length; i += 1) {
    if (!mask.code[i]) continue;
    const char = source[i]!;
    if (char === '{') {
      const lineIndex = lineOf(lines, i);
      const lineStart = lines[lineIndex]!;
      const prefix = source.slice(lineStart, i);
      const candidate =
        BODY_OPEN_RE.test(prefix) &&
        !CONTROL_KEYWORDS.test(prefix) &&
        !/^\s*(\/\/|#|\*)/.test(prefix) &&
        prefix.trim().length > 0;
      stack.push({ index: i, candidate, openLine: lineIndex });
    } else if (char === '}') {
      const open = stack.pop();
      if (!open) continue;
      const closeLine = lineOf(lines, i);
      const span = closeLine - open.openLine;
      if (open.candidate && span >= ELISION_MIN_LINES) {
        const bodyStart = open.index + 1;
        const bodyEnd = i;
        const headEnd = nthLineOffset(lines, source, open.openLine + 1 + ELISION_KEEP_HEAD);
        const markerStart = Math.max(bodyStart, Math.min(bodyEnd, headEnd));
        if (markerStart < bodyEnd) ranges.push([markerStart, bodyEnd]);
      }
    }
  }

  if (ranges.length === 0) return { text: source, elided: 0 };

  // Apply from the end so earlier offsets stay valid, inserting a marker.
  let out = source;
  let elided = 0;
  for (const [start, end] of [...ranges].sort((a, b) => b[0] - a[0])) {
    const removed = out.slice(start, end);
    const removedLines = removed.split('\n').length;
    if (removedLines < 8) continue;
    const indent = /^[ \t]*/m.exec(removed.slice(removed.lastIndexOf('\n', 1) + 1))?.[0] ?? '  ';
    const marker = `\n${indent}/* \u2026 ${removedLines} lines elided \u2026 */\n`;
    out = out.slice(0, start) + marker + out.slice(end);
    elided += 1;
  }
  return { text: out, elided };
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineOf(starts: readonly number[], index: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid]! <= index) low = mid;
    else high = mid - 1;
  }
  return low;
}

function nthLineOffset(starts: readonly number[], source: string, line: number): number {
  if (line >= starts.length) return source.length;
  return starts[line]!;
}

/** Prefix every line with its number, right-aligned. */
export function withLineNumbers(source: string, startLine = 1): string {
  const lines = source.split('\n');
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, index) => `${String(startLine + index).padStart(width, ' ')} | ${line}`).join('\n');
}

/* -------------------------------------------------------------------------- */
/* Driver                                                                     */
/* -------------------------------------------------------------------------- */

/** What compression did to one file, for the report. */
export interface CompressionStats {
  /** Bytes removed across all files. */
  savedBytes: number;
  /** Secrets redacted. */
  redactions: number;
  /** Bodies elided by the aggressive pass. */
  elidedBodies: number;
  /** Files whose content changed. */
  changed: number;
}

/**
 * Compress a file body according to `level`.
 *
 * @param content the file body
 * @param languageId detected language id
 * @param level compression level
 * @param options `redact` toggles the secret pass
 */
export function compressContent(
  content: string,
  languageId: string,
  level: CompressionLevel,
  options: { redact?: boolean } = {},
): { text: string; stats: CompressionStats } {
  const original = content;
  let text = content;
  const stats: CompressionStats = { savedBytes: 0, redactions: 0, elidedBodies: 0, changed: 0 };

  if (options.redact !== false) {
    const result = redactSecrets(text);
    text = result.text;
    stats.redactions = result.count;
  }

  if (level !== 'none') {
    text = collapseBlankLines(text);
    text = stripLicenseBanner(text);
  }
  if (level === 'balanced' || level === 'aggressive') {
    text = stripComments(text, languageId);
    text = collapseBlankLines(text);
  }
  if (level === 'aggressive') {
    const { text: elided, elided: count } = elideLongBodies(text, languageId);
    text = elided;
    stats.elidedBodies = count;
    text = collapseBlankLines(text);
  }

  text = text.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  stats.savedBytes = Math.max(0, original.length - text.length);
  stats.changed = text === original ? 0 : 1;
  return { text, stats };
}

/**
 * Compress every included file in place, recomputing from `fullContent` so the
 * operation is idempotent.
 */
export function compressFiles(files: readonly FileRecord[], config: PackConfig): CompressionStats {
  const total: CompressionStats = { savedBytes: 0, redactions: 0, elidedBodies: 0, changed: 0 };

  for (const file of files) {
    if (file.dropped || file.binary || file.content === undefined) continue;
    // Keep the pristine body the first time we touch the record.
    if (file.fullContent === undefined) file.fullContent = file.content;

    const { text, stats } = compressContent(file.fullContent, file.language, config.compression, {
      redact: config.redactSecrets,
    });

    file.content = text;
    file.compressed = stats.changed === 1;
    file.redactions = stats.redactions;
    file.includedSize = Buffer.byteLength(text, 'utf8');

    total.savedBytes += stats.savedBytes;
    total.redactions += stats.redactions;
    total.elidedBodies += stats.elidedBodies;
    total.changed += stats.changed;
  }

  return total;
}

/** Result of applying a token budget. */
export interface BudgetResult {
  /** Estimated tokens after the budget was applied. */
  tokens: number;
  /** Files dropped or truncated to fit. */
  affected: number;
  /** True when the budget could not be met even after dropping optional files. */
  exceeded: boolean;
}

/**
 * Fit `files` into `maxTokens`, keeping the most important content.
 *
 * Two strategies:
 *
 * - `priority` (default): walk files high→low importance, including each in full
 *   while there is room; the first file that does not fit is truncated to the
 *   remaining budget, and the rest are dropped. Predictable, favours the files
 *   that matter.
 * - `spread`: every file gets the same share of the budget, so the bundle shows
 *   something from everywhere. Truncation happens at line boundaries.
 *
 * The function is deterministic and idempotent: it reads `fullContent` (the
 * pristine body) and recomputes, so calling it twice with the same budget
 * yields the same bundle.
 *
 * @param files mutated in place: `dropped`, `truncated` and `content` are set
 * @param maxTokens a positive token cap, or `0` for "no limit"
 */
export function enforceBudget(
  files: readonly FileRecord[],
  maxTokens: number,
  options: { strategy?: 'priority' | 'spread'; onProgress?: (file: FileRecord) => void } = {},
): BudgetResult {
  if (!maxTokens || maxTokens <= 0) {
    let tokens = 0;
    for (const file of files) {
      if (file.dropped || file.content === undefined || file.binary) continue;
      file.tokens = estimateTokens(file.content);
      tokens += file.tokens;
    }
    return { tokens, affected: 0, exceeded: false };
  }

  const strategy = options.strategy ?? 'priority';
  const candidates = files.filter((file) => !file.dropped && !file.binary && file.content !== undefined);

  // Reset any previous budget state so repeated calls are idempotent.
  for (const file of candidates) {
    file.dropped = false;
    file.dropReason = undefined;
    file.truncated = false;
    if (file.fullContent !== undefined) file.content = file.fullContent;
  }

  let used = 0;
  let affected = 0;
  const ordered = [...candidates].sort((a, b) => b.importance - a.importance);

  if (strategy === 'spread') {
    const perFile = Math.max(200, Math.floor(maxTokens / Math.max(1, ordered.length)));
    for (const file of ordered) {
      const tokens = estimateTokens(file.content ?? '');
      if (tokens <= perFile) {
        file.tokens = tokens;
        used += tokens;
        continue;
      }
      const clipped = clipToTokens(file.content ?? '', perFile);
      file.content = clipped;
      file.truncated = true;
      file.includedSize = Buffer.byteLength(clipped, 'utf8');
      file.tokens = estimateTokens(clipped);
      used += file.tokens;
      affected += 1;
      options.onProgress?.(file);
    }
    return { tokens: used, affected, exceeded: used > maxTokens };
  }

  for (const file of ordered) {
    if (used >= maxTokens) {
      file.dropped = true;
      file.dropReason = 'budget';
      affected += 1;
      continue;
    }
    const tokens = estimateTokens(file.content ?? '');
    if (used + tokens <= maxTokens) {
      file.tokens = tokens;
      used += tokens;
      continue;
    }
    const remaining = maxTokens - used;
    if (remaining < 200) {
      file.dropped = true;
      file.dropReason = 'budget';
      affected += 1;
      continue;
    }
    const clipped = clipToTokens(file.content ?? '', remaining);
    file.content = clipped;
    file.truncated = true;
    file.includedSize = Buffer.byteLength(clipped, 'utf8');
    file.tokens = estimateTokens(clipped);
    used += file.tokens;
    affected += 1;
    options.onProgress?.(file);
  }

  // Files left untouched above need their token counts recorded.
  for (const file of candidates) {
    if (file.dropped) {
      file.tokens = 0;
      continue;
    }
    if (file.tokens === undefined) file.tokens = estimateTokens(file.content ?? '');
  }

  return { tokens: used, affected, exceeded: used > maxTokens };
}

/**
 * Keep the head of `content` that fits in `maxTokens`, never cutting mid-line.
 *
 * A marker is appended so the reader knows the file continues.
 */
export function clipToTokens(content: string, maxTokens: number): string {
  const lines = content.split('\n');
  let kept = 0;
  let tokens = 0;
  const budget = Math.max(0, maxTokens - 12); // room for the marker

  for (const line of lines) {
    const cost = estimateTokens(line + '\n');
    if (tokens + cost > budget) break;
    tokens += cost;
    kept += 1;
  }

  if (kept >= lines.length) return content;
  const omitted = lines.length - kept;
  const marker = `\n/* \u2026 ${omitted} more lines omitted to fit the token budget \u2026 */\n`;
  return lines.slice(0, kept).join('\n') + marker;
}
