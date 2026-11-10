/**
 * CLI argument parsing.
 *
 * A hand-rolled parser instead of `commander`/`yargs`: the flag set is small,
 * the help text is part of the UX, and parsing errors need to be reported with
 * the exact flag the user typed. Unknown flags are an error, not silently
 * ignored, so a typo never produces a mysterious bundle.
 *
 * @module cli/args
 */

import type { CompressionLevel, OutputFormat, PartialConfig, PresetName, Verbosity } from '../types.js';
import { COMPRESSION_LEVELS, OUTPUT_FORMATS, PRESET_NAMES } from '../types.js';

export interface ParsedArgs {
  /** Positional arguments after the flags. */
  positionals: string[];
  /** Flag values, keyed by canonical name. */
  flags: Map<string, string | boolean | string[]>;
  /** Flags the parser did not recognise. */
  unknown: string[];
  /** Values that failed validation. */
  errors: string[];
  /** `--help` or `-h`. */
  help: boolean;
  /** `--version` or `-v`. */
  version: boolean;
  /** `--yes` or `-y`. */
  yes: boolean;
}

/** Flags that never take a value. */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'help',
  'version',
  'yes',
  'hidden',
  'no-hidden',
  'binary',
  'no-gitignore',
  'no-redact',
  'no-report',
  'no-tree',
  'no-summary',
  'no-meta',
  'toc',
  'line-numbers',
  'verbose',
  'quiet',
  'no-color',
  'color',
  'dry-run',
  'list-analyzers',
  'list-formats',
  'list-presets',
  'non-interactive',
  'open',
  'no-manifest',
]);

/** Long-flag aliases. */
const ALIASES: Readonly<Record<string, string>> = {
  h: 'help',
  v: 'version',
  y: 'yes',
  o: 'out',
  f: 'format',
  p: 'preset',
  c: 'compression',
  n: 'name',
  i: 'ignore',
  t: 'max-tokens',
  s: 'max-size',
  V: 'verbose',
  q: 'quiet',
};

/**
 * Parse argv.
 *
 * Supports `--flag value`, `--flag=value`, repeated flags (`--ignore a --ignore b`),
 * comma-separated lists for `--format`, `--` to end flag parsing, and short
 * aliases from {@link ALIASES}.
 *
 * @param argv arguments *after* `node script` (i.e. `process.argv.slice(2)`)
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | boolean | string[]>();
  const positionals: string[] = [];
  const unknown: string[] = [];
  const errors: string[] = [];
  let help = false;
  let version = false;
  let yes = false;
  let endOfFlags = false;

  const set = (name: string, value: string | boolean): void => {
    const existing = flags.get(name);
    if (existing === undefined) {
      flags.set(name, value);
    } else if (Array.isArray(existing)) {
      if (typeof value === 'string') existing.push(value);
      else existing.push(String(value));
    } else if (Array.isArray(value)) {
      flags.set(name, [...(existing ? [String(existing)] : []), ...value]);
    } else {
      flags.set(name, [String(existing), String(value)]);
    }
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]!;

    if (endOfFlags) {
      positionals.push(raw);
      continue;
    }
    if (raw === '--') {
      endOfFlags = true;
      continue;
    }

    if (raw.startsWith('--')) {
      const eq = raw.indexOf('=');
      let name = eq === -1 ? raw.slice(2) : raw.slice(2, eq);
      let value: string | boolean | null = eq === -1 ? null : raw.slice(eq + 1);
      name = canonical(name);
      if (!isKnownFlag(name)) {
        unknown.push(raw);
        continue;
      }
      if (BOOLEAN_FLAGS.has(name)) {
        if (value === null) {
          value = true;
        } else if (value === 'false') {
          value = false;
        } else if (value === 'true') {
          value = true;
        } else {
          errors.push(`--${name} does not take a value`);
          value = true;
        }
      } else if (value === null) {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith('-') && next !== '-')) {
          errors.push(`--${name} requires a value`);
          continue;
        }
        value = next;
        i += 1;
      }
      set(name, value);
      continue;
    }

    if (raw.startsWith('-') && raw.length > 1) {
      const letters = raw.slice(1).split('');
      let consumedValue = false;
      for (let j = 0; j < letters.length; j += 1) {
        const letter = letters[j]!;
        const name = canonical(letter);
        if (!isKnownFlag(name)) {
          unknown.push(`-${letter}`);
          continue;
        }
        if (BOOLEAN_FLAGS.has(name)) {
          set(name, true);
          continue;
        }
        // `-o value` / `-ovalue`
        const inline = letters.slice(j + 1).join('');
        if (inline) {
          set(name, inline);
          consumedValue = true;
          break;
        }
        const next = argv[i + 1];
        if (next === undefined) {
          errors.push(`-${letter} requires a value`);
          break;
        }
        set(name, next);
        i += 1;
        consumedValue = true;
        break;
      }
      void consumedValue;
      continue;
    }

    positionals.push(raw);
  }

  help = flags.has('help');
  version = flags.has('version');
  yes = flags.has('yes');

  return { positionals, flags, unknown, errors, help, version, yes };
}

function canonical(name: string): string {
  if (ALIASES[name]) return ALIASES[name]!;
  return name;
}

const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  ...BOOLEAN_FLAGS,
  'out',
  'format',
  'preset',
  'compression',
  'name',
  'ignore',
  'ignore-dir',
  'max-tokens',
  'max-size',
  'config',
  'exclude',
]);

function isKnownFlag(name: string): boolean {
  return KNOWN_FLAGS.has(name);
}

/** Read a flag as a string, following the "last write wins" rule. */
export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[value.length - 1];
  return String(value);
}

/** Read a flag as a string list (repeated flags or comma-separated values). */
export function flagList(args: ParsedArgs, name: string): string[] {
  const value = args.flags.get(name);
  if (value === undefined) return [];
  const parts = Array.isArray(value) ? value : [String(value)];
  return parts.flatMap((part) => String(part).split(',').map((item) => item.trim()).filter(Boolean));
}

/** Read a flag as a boolean. */
export function flagBool(args: ParsedArgs, name: string): boolean {
  const value = args.flags.get(name);
  if (value === undefined) return false;
  if (Array.isArray(value)) return true;
  return value === true || value === 'true';
}

/**
 * Turn CLI flags into a {@link PartialConfig}.
 *
 * Validation lives here so the pipeline never sees an invalid value: a bad
 * `--format` or `--preset` becomes an entry in `errors` and is skipped.
 */
export function toOverrides(args: ParsedArgs): { overrides: PartialConfig; errors: string[] } {
  const overrides: PartialConfig = {};
  const errors: string[] = [...args.errors];
  if (args.unknown.length > 0) errors.push(`unknown flag(s): ${args.unknown.join(', ')}`);

  const preset = flagString(args, 'preset');
  if (preset !== undefined) {
    if ((PRESET_NAMES as readonly string[]).includes(preset)) overrides.preset = preset as PresetName;
    else errors.push(`unknown preset "${preset}" (expected one of ${PRESET_NAMES.join(', ')})`);
  }

  const formats = flagList(args, 'format');
  if (formats.length > 0) {
    const valid: OutputFormat[] = [];
    for (const format of formats) {
      if ((OUTPUT_FORMATS as readonly string[]).includes(format)) valid.push(format as OutputFormat);
      else errors.push(`unknown format "${format}" (expected one of ${OUTPUT_FORMATS.join(', ')})`);
    }
    if (valid.length > 0) overrides.formats = [...new Set(valid)];
  }

  const compression = flagString(args, 'compression');
  if (compression !== undefined) {
    if ((COMPRESSION_LEVELS as readonly string[]).includes(compression)) {
      overrides.compression = compression as CompressionLevel;
    } else {
      errors.push(`unknown compression "${compression}" (expected one of ${COMPRESSION_LEVELS.join(', ')})`);
    }
  }

  const out = flagString(args, 'out');
  if (out !== undefined) overrides.outputDir = out;

  const name = flagString(args, 'name');
  if (name !== undefined) overrides.outputName = name;

  const ignore = flagList(args, 'ignore');
  if (ignore.length > 0) overrides.ignore = ignore;

  const ignoreDirs = flagList(args, 'ignore-dir');
  if (ignoreDirs.length > 0) overrides.ignoreDirs = ignoreDirs;

  const maxTokens = flagString(args, 'max-tokens');
  if (maxTokens !== undefined) {
    const parsed = parseTokenBudget(maxTokens);
    if (parsed === null) errors.push(`invalid --max-tokens value "${maxTokens}"`);
    else overrides.maxTokens = parsed;
  }

  const maxSize = flagString(args, 'max-size');
  if (maxSize !== undefined) {
    const parsed = parseSize(maxSize);
    if (parsed === null) errors.push(`invalid --max-size value "${maxSize}"`);
    else overrides.maxFileSize = parsed;
  }

  if (flagBool(args, 'hidden')) overrides.includeHidden = true;
  if (flagBool(args, 'no-hidden')) overrides.includeHidden = false;
  if (flagBool(args, 'binary')) overrides.includeBinary = true;
  if (flagBool(args, 'no-gitignore')) overrides.respectGitignore = false;
  if (flagBool(args, 'no-redact')) overrides.redactSecrets = false;
  if (flagBool(args, 'no-report')) overrides.includeReport = false;
  if (flagBool(args, 'no-tree')) overrides.includeTree = false;
  if (flagBool(args, 'no-summary')) overrides.includeSummary = false;
  if (flagBool(args, 'no-meta')) overrides.includeMeta = false;
  if (flagBool(args, 'no-manifest')) overrides.writeManifest = false;
  if (flagBool(args, 'toc')) overrides.includeToc = true;
  if (flagBool(args, 'line-numbers')) overrides.lineNumbers = true;
  if (flagBool(args, 'quiet')) overrides.verbosity = 'quiet' satisfies Verbosity;
  if (flagBool(args, 'verbose')) overrides.verbosity = 'verbose' satisfies Verbosity;
  if (flagBool(args, 'no-color')) overrides.color = false;
  if (flagBool(args, 'color')) overrides.color = true;

  return { overrides, errors };
}

/** `110k`, `110000` or `1.5m` → a token count. */
export function parseTokenBudget(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(k|m)?$/i.exec(value.trim());
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base) || base <= 0) return null;
  const unit = (match[2] ?? '').toLowerCase();
  const multiplier = unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1;
  return Math.round(base * multiplier);
}

/** `2mb`, `512kb`, `1048576` → a byte count. */
export function parseSize(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|k|mb|m|gb|g)?$/i.exec(value.trim());
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base) || base <= 0) return null;
  const unit = (match[2] ?? '').toLowerCase();
  const table: Record<string, number> = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3 };
  return Math.round(base * (table[unit] ?? 1));
}
