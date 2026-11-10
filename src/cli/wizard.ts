/**
 * The interactive wizard.
 *
 * Good UX here means three things: never ask what can be detected, always show a
 * sensible default with the reason behind it, and make the whole thing skippable
 * (`--yes`, or a non-TTY). The wizard scans first and uses the real numbers in
 * the questions, so "keep the files under ~110k tokens" is backed by an actual
 * estimate for *this* project.
 *
 * @module cli/wizard
 */

import path from 'node:path';

import type { CompressionLevel, OutputFormat, PackConfig, PartialConfig, PresetName, ScanResult } from '../types.js';
import { COMPRESSION_LEVELS, OUTPUT_FORMATS, PRESET_NAMES } from '../types.js';
import { PRESETS } from '../core/config.js';
import { CancelledError, askConfirm, askSelect, askText, heading, isInteractive, writeLine, type Choice, type PromptStreams } from '../utils/prompt.js';
import { color, formatBytes, formatCount, table } from '../utils/style.js';
import { estimateTokens, contextFit } from '../utils/tokenizer.js';

/** Answers the wizard produced, ready to merge as overrides. */
export interface WizardAnswers {
  overrides: PartialConfig;
  /** Whether the user chose to continue at all. */
  confirmed: boolean;
}

/** A short, readable description of what a scan contains. */
export function describeScan(scan: ScanResult): string {
  const rows: Array<[string, string]> = [
    ['Files', `${scan.totals.included} included from ${scan.totals.discovered} discovered`],
    ['Size', formatBytes(scan.totals.includedBytes)],
    ['Lines', formatCount(scan.totals.lines)],
    ['~Tokens', formatCount(estimateTokensOf(scan))],
  ];
  if (scan.stack.length > 0) rows.push(['Stack', scan.stack.slice(0, 6).map((entry) => entry.label).join(', ')]);
  if (scan.languages.length > 0) {
    rows.push(['Languages', scan.languages.slice(0, 5).map((entry) => `${entry.name} (${entry.files})`).join(', ')]);
  }
  return table(rows);
}

/** Estimated tokens for everything the scan would include. */
export function estimateTokensOf(scan: ScanResult): number {
  let total = 0;
  for (const file of scan.files) {
    if (file.dropped || file.binary || file.content === undefined) continue;
    total += file.tokens ?? estimateTokens(file.content);
  }
  return total;
}

/**
 * Run the wizard against an already-scanned project.
 *
 * The scan is passed in (rather than the config) because the questions depend on
 * the numbers, and scanning twice would be wasteful.
 */
export async function runWizard(
  config: PackConfig,
  scan: ScanResult,
  options: PromptStreams & { assumeYes?: boolean } = {},
): Promise<WizardAnswers> {
  const overrides: PartialConfig = {};

  if (options.assumeYes || !isInteractive(options)) {
    return { overrides, confirmed: true };
  }

  writeLine('');
  writeLine(heading('ai-project-packer', options));
  writeLine('');
  writeLine(describeScan(scan));
  writeLine('');

  // 1. Preset
  const presetChoices: Choice<PresetName>[] = PRESET_NAMES.map((name) => ({
    value: name,
    label: PRESETS[name].label,
    hint: PRESETS[name].description,
  }));
  const preset = await askSelect<PresetName>('Which target should the bundle be tuned for?', presetChoices, {
    ...options,
    defaultIndex: Math.max(0, PRESET_NAMES.indexOf(config.preset)),
  });
  if (preset !== config.preset) overrides.preset = preset;

  // 2. Formats
  const formatChoices: Choice<OutputFormat>[] = [
    { value: 'markdown', label: 'Markdown', hint: 'single .md file \u2014 works everywhere' },
    { value: 'xml', label: 'XML', hint: '<documents> wrapper \u2014 best for Claude' },
    { value: 'json', label: 'JSON', hint: 'structured, for tooling' },
    { value: 'plain', label: 'Plain text', hint: 'no markup at all' },
    { value: 'repomix', label: 'Repomix-compatible', hint: 'familiar repomix layout' },
    { value: 'zip', label: 'ZIP archive', hint: 'every format plus the raw files' },
  ];
  const defaultFormats = config.formats
    .map((format) => OUTPUT_FORMATS.indexOf(format))
    .filter((index) => index >= 0);
  const formats = await askSelect<OutputFormat>('Which outputs do you want?', formatChoices, {
    ...options,
    multi: true,
    defaultIndex: defaultFormats[0] ?? 0,
    defaults: defaultFormats.length > 0 ? defaultFormats : [0],
  });
  if (formats.length > 0) overrides.formats = formats;

  // 3. Compression
  const compressionChoices: Choice<CompressionLevel>[] = [
    { value: 'none', label: 'None', hint: 'keep files exactly as they are' },
    { value: 'light', label: 'Light', hint: 'redact secrets, drop licence banners' },
    { value: 'balanced', label: 'Balanced', hint: '+ strip comments, collapse blank lines' },
    { value: 'aggressive', label: 'Aggressive', hint: '+ collapse long function bodies' },
  ];
  const compression = await askSelect<CompressionLevel>('How much compression?', compressionChoices, {
    ...options,
    defaultIndex: Math.max(0, COMPRESSION_LEVELS.indexOf(config.compression)),
  });
  if (compression !== config.compression) overrides.compression = compression;

  // 4. Token budget, offered with the real number
  const estimate = estimateTokensOf(scan);
  const fits = contextFit(estimate);
  writeLine('');
  writeLine(
    `   ${color.dim('Estimated bundle:')} ~${formatCount(estimate)} tokens \u00b7 fits ` +
      fits
        .map((entry) => `${entry.model} ${entry.fits ? color.green('\u2714') : color.red('\u2716')}`)
        .join('  '),
  );
  const budgetChoices: Choice<number>[] = [
    { value: 0, label: 'No limit', hint: 'include everything that fits the size cap' },
    { value: 110_000, label: '~110k tokens', hint: 'leaves room for a long answer on a 128k window' },
    { value: 60_000, label: '~60k tokens', hint: 'comfortable for a 128k window with history' },
    { value: 700_000, label: '~700k tokens', hint: 'for a 1M-token window' },
  ];
  const budget = await askSelect<number>('Should the bundle fit a token budget?', budgetChoices, {
    ...options,
    defaultIndex: config.maxTokens > 0 ? 1 : 0,
  });
  if (budget !== config.maxTokens) overrides.maxTokens = budget;

  // 5. Output location and name
  const outputDir = await askText('Output directory', path.relative(process.cwd(), config.outputDir) || config.outputDir, options);
  if (outputDir) overrides.outputDir = outputDir;
  const outputName = await askText('Base file name', config.outputName, options);
  if (outputName && outputName !== config.outputName) overrides.outputName = outputName;

  // 6. Hidden files and secrets
  const hidden = await askConfirm('Include hidden files (.env, dotfiles)?', config.includeHidden, options);
  if (hidden !== config.includeHidden) overrides.includeHidden = hidden;

  const redact = await askConfirm('Redact detected secrets before writing?', config.redactSecrets, options);
  if (redact !== config.redactSecrets) overrides.redactSecrets = redact;

  writeLine('');
  const confirmed = await askConfirm('Run with these settings?', true, options);
  return { overrides, confirmed };
}

/** Print the wizard header without asking anything (used by `--dry-run`). */
export function previewScan(scan: ScanResult, config: PackConfig): string {
  const lines: string[] = [];
  lines.push(heading('preview'));
  lines.push(describeScan(scan));
  lines.push('');
  lines.push(table([['Formats', config.formats.join(', ')], ['Compression', config.compression], ['Output', config.outputDir]]));
  return lines.join('\n');
}

export { CancelledError };
