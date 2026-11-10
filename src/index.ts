/**
 * Public library entry point.
 *
 * Everything a consumer or a plugin needs is re-exported here, so
 * `import { packProject } from 'ai-project-packer'` works without reaching into
 * internal paths.
 *
 * ```ts
 * import { packProject, resolveConfig, type PackConfig } from 'ai-project-packer';
 *
 * const outcome = await packProject('./my-app', {
 *   overrides: { preset: 'claude', formats: ['xml'] },
 *   onProgress: (event) => console.log(event.phase, event.message),
 * });
 * console.log(outcome.report.totals.tokens);
 * ```
 *
 * @module index
 */

export type {
  Analyzer,
  AnalyzerSection,
  Bundle,
  BundleTotals,
  CompressionLevel,
  ConfigLoadResult,
  DropReason,
  FileKind,
  FileRecord,
  FileReportEntry,
  IgnoredEntry,
  LanguageSpec,
  LanguageStat,
  OutputArtifact,
  OutputFormat,
  PackConfig,
  PackOutcome,
  PackReport,
  PartialConfig,
  Phase,
  PresetDefinition,
  PresetName,
  ProgressEvent,
  ProgressHandler,
  RenderContext,
  Renderer,
  ScanResult,
  ScanTotals,
  StackInfo,
  Verbosity,
} from './types.js';

export { COMPRESSION_LEVELS, OUTPUT_FORMATS, PRESET_NAMES } from './types.js';

export {
  ConfigError,
  DEFAULTS,
  DEFAULT_OUTPUT_NAME,
  PRESETS,
  describeConfig,
  presetHelp,
  resolveConfig,
} from './core/config.js';

export { scanProject, classify, scoreFile, detectStack, assertProjectRoot } from './core/scanner.js';

export {
  clipToTokens,
  collapseBlankLines,
  compressContent,
  compressFiles,
  elideLongBodies,
  enforceBudget,
  maskCode,
  stripComments,
  stripLicenseBanner,
  withLineNumbers,
} from './core/compressor.js';
export type { BudgetResult, CodeMask, CompressionStats } from './core/compressor.js';

export { isPlaceholder, redactSecrets, SECRET_PATTERNS } from './core/redactor.js';
export type { RedactResult, RedactionRule } from './core/redactor.js';

export { detectLanguage, fenceHint, groupByLanguage, languageById, LANGUAGES } from './core/languages.js';

export { VERSION, makeBundle, makeReport, packProject, packWithConfig, renderReport, summarizeOutcome } from './core/pipeline.js';
export type { PackOptions } from './core/pipeline.js';

export { describeAnalyzers, listAnalyzers, registerAnalyzer, runAnalyzers } from './analyzers/index.js';
export type { ApiEntry, ApiValue, DepsValue, IndexValue, SummaryValue, TodoEntry, TodoValue, TreeValue } from './analyzers/index.js';

export { listRenderers, registerRenderer, rendererFor, outputFileName, escapeXml, cdata, bundledFiles, renderMarkdown, renderXml, renderJson, renderPlain, renderRepomix, renderZipBundle } from './renderers/index.js';
export { crc32, readZipEntries, renderZip } from './renderers/zip.js';
export type { ZipEntry, ZipOptions } from './renderers/zip.js';

export { contextFit, estimateCost, estimateTokenMap, estimateTokens, PRICING } from './utils/tokenizer.js';
export type { ContextFit, ModelId, TokenChunk, TokenMapResult } from './utils/tokenizer.js';

export { IgnoreMatcher, globToRegExp, matcherFromPatterns, matcherFromText } from './utils/glob.js';
export { DEFAULT_IGNORE_DIRS, extOf, isBinary, sniffBinary, walk } from './utils/fs.js';
export type { WalkEntry, WalkOptions } from './utils/fs.js';

export { parseArgs, parseSize, parseTokenBudget, toOverrides } from './cli/args.js';
export type { ParsedArgs } from './cli/args.js';
export { main } from './cli/main.js';
export { resolveRoot, run, usage } from './cli/run.js';
export type { RunInput } from './cli/run.js';
export { estimateTokensOf, describeScan, runWizard } from './cli/wizard.js';
export type { WizardAnswers } from './cli/wizard.js';
