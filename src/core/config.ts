/**
 * Configuration: defaults, presets, layered resolution and validation.
 *
 * Precedence, lowest first:
 *
 * ```text
 *   DEFAULTS  <  preset  <  project config file  <  user config file  <  CLI flags
 * ```
 *
 * A config file is JSON (`ai-project-packer.json`, `.aipackrc.json`, or an
 * `aipack` key inside `package.json`). Unknown keys are reported as problems
 * rather than silently ignored, because a typo in a config file is otherwise
 * invisible.
 *
 * @module core/config
 */

import path from 'node:path';
import { readJson, exists } from '../utils/fs.js';
import type {
  CompressionLevel,
  OutputFormat,
  PackConfig,
  PartialConfig,
  PresetDefinition,
  PresetName,
  ConfigLoadResult,
} from '../types.js';
import { COMPRESSION_LEVELS, OUTPUT_FORMATS, PRESET_NAMES } from '../types.js';

/** Default output basename used for every generated artefact. */
export const DEFAULT_OUTPUT_NAME = 'project-context';

/** Config file names searched in the project root, in order. */
export const CONFIG_FILENAMES: readonly string[] = [
  'ai-project-packer.json',
  'aipack.config.json',
  '.aipackrc.json',
  '.aipackrc',
];

/** Presets, tuned for the target chat product. */
export const PRESETS: Readonly<Record<PresetName, PresetDefinition>> = {
  chat: {
    label: 'General chat',
    description: 'Balanced Markdown bundle that fits any chat UI and keeps the full tree.',
    formats: ['markdown'],
    options: { compression: 'balanced', maxTokens: 0, includeTree: true, includeSummary: true, includeToc: false },
  },
  claude: {
    label: 'Claude (XML)',
    description: 'XML <documents> wrapper that Claude reads with the least ambiguity.',
    formats: ['xml', 'markdown'],
    options: { compression: 'balanced', maxTokens: 0, includeTree: true, includeSummary: true, includeToc: true },
  },
  openai: {
    label: 'OpenAI (Markdown)',
    description: 'Markdown tuned to a 128k window, trimmed to leave room for the answer.',
    formats: ['markdown'],
    options: { compression: 'balanced', maxTokens: 110_000, includeTree: true, includeSummary: true, includeToc: true },
  },
  gemini: {
    label: 'Gemini (large window)',
    description: 'Keeps more of the project, including larger files, for a 1M-token window.',
    formats: ['markdown', 'xml'],
    options: { compression: 'light', maxTokens: 700_000, maxFileSize: 4 * 1024 * 1024 },
  },
  archive: {
    label: 'Full archive',
    description: 'Everything, uncompressed, plus JSON, XML and a zip for storage or hand-off.',
    formats: ['markdown', 'json', 'xml', 'zip'],
    options: { compression: 'none', maxTokens: 0, maxFileSize: 5 * 1024 * 1024, includeReport: true },
  },
};

/** The built-in defaults every run starts from. */
export const DEFAULTS: Omit<PackConfig, 'root'> = {
  preset: 'chat',
  formats: ['markdown'],
  outputDir: 'aipack-out',
  outputName: DEFAULT_OUTPUT_NAME,
  ignore: [],
  ignoreDirs: [],
  includeHidden: false,
  includeBinary: false,
  maxFileSize: 1.5 * 1024 * 1024,
  maxTokens: 0,
  compression: 'balanced',
  includeTree: true,
  includeSummary: true,
  includeMeta: true,
  includeToc: false,
  includeReport: true,
  lineNumbers: false,
  fallbackLanguage: 'text',
  writeManifest: true,
  budgetStrategy: 'priority',
  verbosity: 'normal',
  color: null,
  respectGitignore: true,
  redactSecrets: true,
  stripComments: true,
  collapseBlankLines: true,
  truncateBodies: true,
  summaryMaxFiles: 400,
};

/** A single validation problem found while resolving config. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Keys a config file may set. */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'preset',
  'formats',
  'outputDir',
  'outputName',
  'ignore',
  'ignoreDirs',
  'includeHidden',
  'includeBinary',
  'maxFileSize',
  'maxTokens',
  'compression',
  'includeTree',
  'includeSummary',
  'includeMeta',
  'includeToc',
  'includeReport',
  'lineNumbers',
  'fallbackLanguage',
  'writeManifest',
  'budgetStrategy',
  'verbosity',
  'color',
  'respectGitignore',
  'redactSecrets',
  'stripComments',
  'collapseBlankLines',
  'truncateBodies',
  'summaryMaxFiles',
]);

/**
 * Read configuration for `root`, layering preset, config files and overrides.
 *
 * @param root absolute project root
 * @param overrides CLI flags, highest precedence
 * @param options `configFile` forces a specific file; `projectConfigOnly` skips package.json
 */
export async function resolveConfig(
  root: string,
  overrides: PartialConfig = {},
  options: { configFile?: string; projectConfigOnly?: boolean } = {},
): Promise<ConfigLoadResult> {
  const problems: string[] = [];
  const sources: string[] = [];

  const fromFiles: PartialConfig = {};
  const candidates: string[] = [];

  if (options.configFile) {
    candidates.push(path.resolve(options.configFile));
  } else {
    for (const name of CONFIG_FILENAMES) candidates.push(path.join(root, name));
    if (!options.projectConfigOnly) {
      const pkgPath = path.join(root, 'package.json');
      if (await exists(pkgPath)) {
        const pkg = await readJson<{ aipack?: PartialConfig }>(pkgPath, {});
        if (pkg.aipack && typeof pkg.aipack === 'object') {
          Object.assign(fromFiles, sanitize(pkg.aipack, `${pkgPath}#aipack`, problems));
          sources.push(`${pkgPath}#aipack`);
        }
      }
      // User-level config, if present.
      const home = process.env.HOME;
      if (home) candidates.push(path.join(home, '.aipackrc.json'));
    }
  }

  for (const candidate of candidates) {
    if (!(await exists(candidate))) continue;
    const data = await readJson<PartialConfig | null>(candidate, null);
    if (!data || typeof data !== 'object') {
      problems.push(`ignored ${candidate}: not a JSON object`);
      continue;
    }
    Object.assign(fromFiles, sanitize(data, candidate, problems));
    sources.push(candidate);
  }

  const cleanedOverrides = sanitize(overrides, 'command line', problems, { tolerateUnknown: true });

  const presetName = pickPreset(cleanedOverrides.preset ?? fromFiles.preset ?? DEFAULTS.preset, problems);
  const preset = PRESETS[presetName];

  const merged: PartialConfig = {
    ...preset.options,
    // The preset's own format list is the base; a config file or a CLI flag still wins.
    formats: [...preset.formats],
    ...fromFiles,
    ...cleanedOverrides,
    preset: presetName,
  };

  const config = finalise(root, merged, problems);
  sources.unshift(`preset:${presetName}`);
  sources.push('defaults');

  return { config, sources, problems };
}

function pickPreset(value: unknown, problems: string[]): PresetName {
  if (typeof value === 'string' && (PRESET_NAMES as readonly string[]).includes(value)) {
    return value as PresetName;
  }
  if (value !== undefined) problems.push(`unknown preset "${String(value)}" \u2014 using "chat"`);
  return 'chat';
}

/** Drop unknown keys and coerce obvious type errors, recording what happened. */
function sanitize(
  input: PartialConfig,
  source: string,
  problems: string[],
  options: { tolerateUnknown?: boolean } = {},
): PartialConfig {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (!CONFIG_KEYS.has(key)) {
      if (!options.tolerateUnknown) problems.push(`ignored unknown key "${key}" in ${source}`);
      continue;
    }
    out[key] = value;
  }
  return out as PartialConfig;
}

/** Turn the merged partial config into a complete, validated {@link PackConfig}. */
function finalise(root: string, merged: PartialConfig, problems: string[]): PackConfig {
  const compression = normaliseCompression(merged.compression, problems);
  const formats = normaliseFormats(merged.formats, problems);

  const config: PackConfig = {
    root,
    preset: merged.preset ?? DEFAULTS.preset,
    formats,
    outputDir: path.resolve(root, merged.outputDir ?? DEFAULTS.outputDir),
    outputName: normaliseName(merged.outputName ?? DEFAULTS.outputName),
    ignore: toArray(merged.ignore),
    ignoreDirs: toArray(merged.ignoreDirs),
    includeHidden: bool(merged.includeHidden, DEFAULTS.includeHidden),
    includeBinary: bool(merged.includeBinary, DEFAULTS.includeBinary),
    maxFileSize: positive(merged.maxFileSize, DEFAULTS.maxFileSize),
    maxTokens: nonNegative(merged.maxTokens, DEFAULTS.maxTokens),
    compression,
    includeTree: bool(merged.includeTree, DEFAULTS.includeTree),
    includeSummary: bool(merged.includeSummary, DEFAULTS.includeSummary),
    includeMeta: bool(merged.includeMeta, DEFAULTS.includeMeta),
    includeToc: bool(merged.includeToc, DEFAULTS.includeToc),
    includeReport: bool(merged.includeReport, DEFAULTS.includeReport),
    lineNumbers: bool(merged.lineNumbers, DEFAULTS.lineNumbers),
    fallbackLanguage: typeof merged.fallbackLanguage === 'string' && merged.fallbackLanguage ? merged.fallbackLanguage : DEFAULTS.fallbackLanguage,
    writeManifest: bool(merged.writeManifest, DEFAULTS.writeManifest),
    budgetStrategy: merged.budgetStrategy === 'spread' ? 'spread' : 'priority',
    verbosity: merged.verbosity === 'quiet' || merged.verbosity === 'verbose' ? merged.verbosity : 'normal',
    color: typeof merged.color === 'boolean' ? merged.color : null,
    respectGitignore: bool(merged.respectGitignore, DEFAULTS.respectGitignore),
    redactSecrets: bool(merged.redactSecrets, DEFAULTS.redactSecrets),
    stripComments: bool(merged.stripComments, DEFAULTS.stripComments),
    collapseBlankLines: bool(merged.collapseBlankLines, DEFAULTS.collapseBlankLines),
    truncateBodies: bool(merged.truncateBodies, DEFAULTS.truncateBodies),
    summaryMaxFiles: positive(merged.summaryMaxFiles, DEFAULTS.summaryMaxFiles),
  };

  if (config.outputDir === root) {
    throw new ConfigError('output directory cannot be the project root');
  }
  if (config.formats.length === 0) config.formats = ['markdown'];
  if (config.maxTokens > 0 && !Number.isFinite(config.maxTokens)) {
    throw new ConfigError('maxTokens must be a finite number');
  }
  return config;
}

function normaliseCompression(value: unknown, problems: string[]): CompressionLevel {
  if (typeof value === 'string' && (COMPRESSION_LEVELS as readonly string[]).includes(value)) {
    return value as CompressionLevel;
  }
  if (value !== undefined) problems.push(`unknown compression level "${String(value)}" \u2014 using "balanced"`);
  return DEFAULTS.compression;
}

function normaliseFormats(value: unknown, problems: string[]): OutputFormat[] {
  if (value === undefined) return [...DEFAULTS.formats];
  const list = toArray(value as string | string[]);
  const valid: OutputFormat[] = [];
  for (const item of list) {
    if ((OUTPUT_FORMATS as readonly string[]).includes(item)) valid.push(item as OutputFormat);
    else problems.push(`unknown format "${item}" \u2014 ignored`);
  }
  const unique = [...new Set(valid)];
  return unique.length > 0 ? unique : [...DEFAULTS.formats];
}

function normaliseName(value: string): string {
  const cleaned = value.replace(/[\\/]/g, '-').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || DEFAULT_OUTPUT_NAME;
}

function toArray(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  return [String(value)];
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function positive(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegative(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Preset metadata for the CLI help screen. */
export function presetHelp(): string {
  return PRESET_NAMES.map((name) => {
    const preset = PRESETS[name];
    return `  ${name.padEnd(9)} ${preset.description}`;
  }).join('\n');
}

/** A compact, human-readable config summary for `--verbose`. */
export function describeConfig(config: PackConfig): string {
  return [
    `root=${config.root}`,
    `preset=${config.preset}`,
    `formats=${config.formats.join(',')}`,
    `compression=${config.compression}`,
    `maxTokens=${config.maxTokens || 'unlimited'}`,
    `maxFileSize=${config.maxFileSize}`,
    `hidden=${config.includeHidden}`,
    `gitignore=${config.respectGitignore}`,
    `redact=${config.redactSecrets}`,
    `output=${path.relative(config.root, config.outputDir) || '.'}`,
  ].join('  ');
}
