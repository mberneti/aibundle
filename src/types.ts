/**
 * Central type contracts for ai-project-packer.
 *
 * Everything else imports its shapes from here, so this file is the fastest way
 * to understand the data flow:
 *
 * ```text
 * config  ->  scan  ->  compress  ->  analyze  ->  render  ->  write  ->  report
 * PackConfig  ScanResult  FileRecord   AnalyzerSection   Renderer   OutputArtifact
 * ```
 *
 * The types are explicit on purpose: they are the extension points. Adding a
 * renderer, an analyzer or a language only requires satisfying one interface
 * below.
 *
 * @module types
 */

/* -------------------------------------------------------------------------- */
/* Enumerations                                                               */
/* -------------------------------------------------------------------------- */

/** Bundle formats the CLI can emit. */
export type OutputFormat = 'markdown' | 'xml' | 'json' | 'plain' | 'repomix' | 'zip';

/** All output formats, in the order the CLI lists them. */
export const OUTPUT_FORMATS: readonly OutputFormat[] = [
  'markdown',
  'xml',
  'json',
  'plain',
  'repomix',
  'zip',
] as const;

/** How hard the compressor works on each file. */
export type CompressionLevel = 'none' | 'light' | 'balanced' | 'aggressive';

/** All compression levels, cheapest first. */
export const COMPRESSION_LEVELS: readonly CompressionLevel[] = [
  'none',
  'light',
  'balanced',
  'aggressive',
] as const;

/** Tuning bundles for common chat targets. */
export type PresetName = 'chat' | 'claude' | 'openai' | 'gemini' | 'archive';

/** All preset names. */
export const PRESET_NAMES: readonly PresetName[] = [
  'chat',
  'claude',
  'openai',
  'gemini',
  'archive',
] as const;

/** Coarse classification of a file, used for ranking and rendering order. */
export type FileKind = 'source' | 'config' | 'doc' | 'test' | 'style' | 'asset' | 'other';

/** Log verbosity. */
export type Verbosity = 'quiet' | 'normal' | 'verbose';

/** Why a file never made it into the bundle. */
export type DropReason =
  | 'ignored'
  | 'binary'
  | 'too-large'
  | 'low-signal'
  | 'budget'
  | 'empty'
  | 'duplicate';

/** How the compressor picks what to keep when a token budget is in force. */
export type BudgetStrategy = 'priority' | 'spread';

/* -------------------------------------------------------------------------- */
/* Languages                                                                  */
/* -------------------------------------------------------------------------- */

/** Per-language metadata: detection plus the hints the compressor needs. */
export interface LanguageSpec {
  /** Stable identifier used in config and reports, e.g. `tsx`. */
  readonly id: string;
  /** Human-readable name for the report. */
  readonly name: string;
  /** Lowercase extensions including the leading dot. */
  readonly extensions: readonly string[];
  /** Exact lowercase filenames, e.g. `dockerfile`. */
  readonly filenames?: readonly string[];
  /** Single-line comment token, if the language has one. */
  readonly comment?: string;
  /** Block comment open/close pair, if the language has one. */
  readonly block?: readonly [open: string, close: string];
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/** The single, fully-resolved configuration used by every stage. */
export interface PackConfig {
  /** Absolute project root. */
  root: string;
  /** Preset the config was derived from. */
  preset: PresetName;
  /** Formats to emit; always non-empty after resolution. */
  formats: OutputFormat[];
  /** Absolute output directory. */
  outputDir: string;
  /** Basename of generated artefacts, without extension. */
  outputName: string;
  /** Extra ignore patterns (gitignore syntax). */
  ignore: string[];
  /** Extra directory names to skip, on top of the built-in list. */
  ignoreDirs: string[];
  /** Include dotfiles such as `.env` and `.eslintrc`. */
  includeHidden: boolean;
  /** Include binary files as manifest-only entries. */
  includeBinary: boolean;
  /** Hard cap per file; larger files are listed but not inlined. */
  maxFileSize: number;
  /** Soft cap for the whole bundle in estimated tokens (0 = unlimited). */
  maxTokens: number;
  /** Compression level. */
  compression: CompressionLevel;
  /** Emit the directory tree section. */
  includeTree: boolean;
  /** Emit the auto-generated project summary. */
  includeSummary: boolean;
  /** Emit metadata blocks. */
  includeMeta: boolean;
  /** Emit a table of contents. */
  includeToc: boolean;
  /** Emit the per-file "why included / why dropped" report. */
  includeReport: boolean;
  /** Prepend line numbers inside code fences. */
  lineNumbers: boolean;
  /** Language hint used when detection fails. */
  fallbackLanguage: string;
  /** Also write an `manifest.json` next to the bundle. */
  writeManifest: boolean;
  /** How to spend a token budget. */
  budgetStrategy: BudgetStrategy;
  /** Log verbosity. */
  verbosity: Verbosity;
  /** `null` means "auto-detect from TTY and NO_COLOR". */
  color: boolean | null;
  /** Honour `.gitignore`. */
  respectGitignore: boolean;
  /** Redact obvious secrets before they leave the machine. */
  redactSecrets: boolean;
  /** Strip comments during compression. */
  stripComments: boolean;
  /** Collapse blank lines during compression. */
  collapseBlankLines: boolean;
  /** Shorten long function bodies to signature + marker. */
  truncateBodies: boolean;
  /** Longest directory listing kept in the summary analyzer. */
  summaryMaxFiles: number;
}

/** A partial configuration as supplied by a user or a config file. */
export type PartialConfig = Partial<PackConfig> & {
  preset?: PresetName;
  formats?: OutputFormat[];
};

/** Result of resolving configuration for a run. */
export interface ConfigLoadResult {
  config: PackConfig;
  /** Files that contributed values, highest precedence last. */
  sources: string[];
  /** Non-fatal problems worth showing to the user. */
  problems: string[];
}

/** Definition of a named preset. */
export interface PresetDefinition {
  readonly label: string;
  readonly description: string;
  readonly formats: readonly OutputFormat[];
  readonly options: PartialConfig;
}

/* -------------------------------------------------------------------------- */
/* Scanning                                                                   */
/* -------------------------------------------------------------------------- */

/** One file discovered by the scanner, enriched as it moves down the pipeline. */
export interface FileRecord {
  /** POSIX-style path relative to the project root. */
  path: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** Size in bytes. */
  size: number;
  /** Number of lines. */
  lines: number;
  /** Detected language id, e.g. `tsx`. */
  language: string;
  /** Display name of the language. */
  languageName: string;
  /** Coarse classification. */
  kind: FileKind;
  /** Heuristic importance score in `0..100`; drives ordering and budgets. */
  importance: number;
  /** Why the file ranked where it did, for the transparency section. */
  reasons: string[];
  /** Content as it will appear in the bundle (post-compression). */
  content?: string;
  /**
   * The pristine body, kept so compression and budgeting can be recomputed
   * idempotently. Set by the compressor; never rendered.
   */
  fullContent?: string;
  /** Byte size of the content actually included after compression. */
  includedSize?: number;
  /** Estimated tokens of the included content. */
  tokens?: number;
  /** Set when compression changed the content. */
  compressed?: boolean;
  /** Number of secrets redacted from this file. */
  redactions?: number;
  /** Set when the file was cut short because of a size/token budget. */
  truncated?: boolean;
  /** Set when the file is excluded from the bundle entirely. */
  dropped?: boolean;
  /** Machine-readable reason for `dropped`. */
  dropReason?: DropReason;
  /** True when the file was detected as binary. */
  binary?: boolean;
}

/** Aggregate language statistics. */
export interface LanguageStat {
  language: string;
  name: string;
  files: number;
  bytes: number;
  lines: number;
}

/** A path the scanner skipped, with the reason. */
export interface IgnoredEntry {
  path: string;
  reason: DropReason;
}

/** A detected technology, with the evidence that proves it. */
export interface StackInfo {
  id: string;
  label: string;
  evidence: string;
}

/** Totals for a scan. */
export interface ScanTotals {
  /** Files seen on disk before filtering. */
  discovered: number;
  /** Files kept for the bundle. */
  included: number;
  /** Bytes of every discovered file. */
  bytes: number;
  /** Bytes of the included files (after compression, once compressed). */
  includedBytes: number;
  /** Lines across the included files. */
  lines: number;
}

/** Everything the scanner produced. */
export interface ScanResult {
  root: string;
  /** Files kept, sorted by importance (highest first). */
  files: FileRecord[];
  /** Paths that were skipped, capped for sanity. */
  ignored: IgnoredEntry[];
  totals: ScanTotals;
  languages: LanguageStat[];
  stack: StackInfo[];
}

/* -------------------------------------------------------------------------- */
/* Analysis                                                                   */
/* -------------------------------------------------------------------------- */

/** Context handed to analyzers and renderers. */
export interface RenderContext {
  config: PackConfig;
  scan: ScanResult;
}

/**
 * An extension point: takes the scan, produces a typed value, and knows how to
 * render it. `TValue` is inferred, which is what makes the registry usable
 * without casts.
 */
export interface Analyzer<TValue> {
  id: string;
  title: string;
  run(scan: ScanResult, config: PackConfig): TValue;
  render(value: TValue, ctx: RenderContext): string;
}

/**
 * A materialised analyzer result. `render` is bound to the value, so renderers
 * can iterate sections without knowing any analyzer's type.
 */
export interface AnalyzerSection {
  id: string;
  title: string;
  value: unknown;
  render(ctx: RenderContext): string;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

/** Totals of a finished bundle, shown in reports and the run summary. */
export interface BundleTotals {
  files: number;
  included: number;
  dropped: number;
  bytes: number;
  includedBytes: number;
  tokens: number;
  redactions: number;
  truncated: number;
  compressionSavedBytes: number;
}

/** Everything a renderer needs. */
export interface Bundle {
  config: PackConfig;
  scan: ScanResult;
  sections: AnalyzerSection[];
  totals: BundleTotals;
  startedAt: string;
  durationMs: number;
}

/** A renderer turns a bundle into one output artefact. */
export interface Renderer {
  id: OutputFormat;
  label: string;
  /** File extension including the dot. */
  extension: string;
  /** MIME type, used by the manifest. */
  mime: string;
  /** `string` for text formats, `Buffer` for binary ones such as zip. */
  render(bundle: Bundle): string | Buffer;
}

/* -------------------------------------------------------------------------- */
/* Output                                                                     */
/* -------------------------------------------------------------------------- */

/** One file written to disk. */
export interface OutputArtifact {
  format: OutputFormat;
  /** Absolute path that was written. */
  path: string;
  bytes: number;
  /** Estimated tokens; `0` for archives. */
  tokens: number;
}

/** Honest, machine-readable report of a run. */
export interface PackReport {
  version: string;
  generatedAt: string;
  root: string;
  preset: PresetName;
  compression: CompressionLevel;
  formats: OutputFormat[];
  configSources: string[];
  problems: string[];
  totals: BundleTotals;
  stack: StackInfo[];
  files: FileReportEntry[];
  ignored: IgnoredEntry[];
}

/** Per-file line of the run report. */
export interface FileReportEntry {
  path: string;
  language: string;
  kind: FileKind;
  importance: number;
  included: boolean;
  tokens: number;
  dropReason?: DropReason;
  redactions?: number;
  truncated?: boolean;
  reasons: string[];
}

/** Result of a full pack run. */
export interface PackOutcome {
  report: PackReport;
  bundle: Bundle;
  outputs: OutputArtifact[];
}

/* -------------------------------------------------------------------------- */
/* Progress                                                                   */
/* -------------------------------------------------------------------------- */

/** Pipeline phase names. */
export type Phase = 'discover' | 'read' | 'compress' | 'analyze' | 'render' | 'write';

/** A progress notification; the CLI turns these into a live status line. */
export interface ProgressEvent {
  phase: Phase;
  message: string;
  current?: number;
  total?: number;
}

/** Callback the pipeline uses to report progress. */
export type ProgressHandler = (event: ProgressEvent) => void;
