/**
 * Gitignore-compatible ignore matching.
 *
 * Implements the subset of the gitignore grammar that matters in practice:
 * comments, negation (`!`), directory-only patterns (trailing `/`), anchoring
 * to the repo root (leading `/`), `*`, `?` and `**`. A matcher instance is
 * built from ordered pattern lists and answers `matches(relativePath, isDir)`.
 *
 * The last matching pattern wins, exactly as git does.
 *
 * @module utils/glob
 */

/** One compiled pattern. */
interface Rule {
  negated: boolean;
  dirOnly: boolean;
  regex: RegExp;
  source: string;
}

export interface IgnoreMatcherOptions {
  /** Base directory the matcher was created for (used for root-relative rules). */
  root?: string;
}

export class IgnoreMatcher {
  private readonly rules: Rule[];

  constructor(patterns: Iterable<string>, options: IgnoreMatcherOptions = {}) {
    // `options.root` is part of the public signature for future root-relative
    // rules; no rule kind needs it yet, so it is intentionally not stored.
    void options;
    this.rules = [];
    for (const raw of patterns) {
      const rule = compile(raw);
      if (rule) this.rules.push(rule);
    }
  }

  get size(): number {
    return this.rules.length;
  }

  /**
   * Whether `relativePath` (posix separators, no leading slash) is ignored.
   *
   * @param relativePath path relative to the matcher root
   * @param isDir whether the path names a directory
   */
  matches(relativePath: string, isDir = false): boolean {
    const target = normalise(relativePath);
    let ignored = false;
    for (const rule of this.rules) {
      // A directory-only rule (`coverage/`) ignores the directory *and*
      // everything inside it. For a file path we therefore test the rule
      // against each ancestor directory as well as against the path itself.
      const hit = rule.dirOnly && !isDir
        ? matchesAncestor(rule.regex, target)
        : rule.regex.test(target);
      if (hit) ignored = !rule.negated;
    }
    return ignored;
  }
}

function normalise(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Whether `regex` matches the path itself or any of its ancestor directories. */
function matchesAncestor(regex: RegExp, target: string): boolean {
  if (regex.test(target)) return true;
  let index = target.indexOf('/');
  while (index !== -1) {
    if (regex.test(target.slice(0, index))) return true;
    index = target.indexOf('/', index + 1);
  }
  return false;
}

function compile(raw: string): Rule | null {
  let pattern = raw.trim();
  if (!pattern || pattern.startsWith('#')) return null;

  let negated = false;
  if (pattern.startsWith('!')) {
    negated = true;
    pattern = pattern.slice(1);
  }

  let dirOnly = false;
  if (pattern.endsWith('/')) {
    dirOnly = true;
    pattern = pattern.replace(/\/+$/, '');
  }

  if (!pattern) return null;

  const anchored = pattern.startsWith('/') || pattern.slice(0, -1).includes('/');
  pattern = pattern.replace(/^\//, '');

  const regex = globToRegExp(pattern, anchored);
  return { negated, dirOnly, regex, source: raw };
}

function escapeRegexChar(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Translate a gitignore glob into a regular expression.
 *
 * `**` matches across separators, `*` and `?` do not. An unanchored pattern
 * matches at any depth; an anchored one matches from the root only.
 */
export function globToRegExp(pattern: string, anchored: boolean): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === '*') {
      const next = pattern[i + 1];
      if (next === '*') {
        // `**/` -> any number of leading directories; `**` -> anything.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        out += '\\[';
      } else {
        const body = pattern.slice(i + 1, close).replace(/^!/, '^');
        out += `[${body}]`;
        i = close;
      }
    } else {
      out += escapeRegexChar(char);
    }
  }

  const prefix = anchored ? '^' : '^(?:.*/)?';
  return new RegExp(`${prefix}${out}(?:/.*)?$`);
}

/** Convenience: build a matcher from `.gitignore` text. */
export function matcherFromText(text: string, options?: IgnoreMatcherOptions): IgnoreMatcher {
  const lines = text.split(/\r?\n/).map((line) => (line.includes(' #') ? line.slice(0, line.indexOf(' #')) : line));
  return new IgnoreMatcher(lines, options);
}

/** Convenience: build a matcher from a flat pattern array. */
export function matcherFromPatterns(patterns: readonly string[], options?: IgnoreMatcherOptions): IgnoreMatcher {
  return new IgnoreMatcher(patterns, options);
}
