/**
 * Pipeline: the orchestrator.
 *
 * ```text
 * resolve config -> scan -> compress -> enforce budget -> analyze -> render -> write -> report
 * ```
 *
 * Each stage is a separate module and the pipeline only sequences them, which is
 * what keeps every stage independently testable. It also means the expensive
 * parts (scan, compress) can be run once and rendered into six formats without
 * being repeated.
 *
 * @module core/pipeline
 */

import path from "node:path";

import type {
  Bundle,
  BundleTotals,
  ConfigLoadResult,
  FileReportEntry,
  OutputArtifact,
  PackConfig,
  PackOutcome,
  PackReport,
  PartialConfig,
  ProgressHandler,
  ScanResult,
} from "../types.js";
import { resolveConfig } from "./config.js";
import {
  compressFiles,
  enforceBudget,
  type CompressionStats,
} from "./compressor.js";
import { scanProject } from "./scanner.js";
import { runAnalyzers } from "../analyzers/index.js";
import { outputFileName, rendererFor } from "../renderers/index.js";
import { estimateTokens } from "../utils/tokenizer.js";
import { ensureDir } from "../utils/fs.js";
import { formatBytes, formatCount } from "../utils/style.js";
import { writeFileSafe } from "../utils/fs.js";

/** Version stamped into reports and manifests. */
export const VERSION = "2.0.0";

export interface PackOptions {
  /** Overrides merged on top of the config files (CLI flags). */
  overrides?: PartialConfig;
  /** Explicit config file path. */
  configFile?: string;
  /** Receives progress notifications. */
  onProgress?: ProgressHandler;
  /** Set to `false` to build the bundle without writing anything (dry run). */
  write?: boolean;
}

/**
 * Resolve configuration, run the whole pipeline, write the artefacts and return
 * a full outcome. This is the function the CLI calls.
 */
export async function packProject(
  root: string,
  options: PackOptions = {},
): Promise<PackOutcome> {
  const load = await resolveConfig(root, options.overrides ?? {}, {
    configFile: options.configFile,
  });
  return packWithConfig(load, options);
}

/** Same as {@link packProject} but takes an already-resolved configuration. */
export async function packWithConfig(
  load: ConfigLoadResult,
  options: Omit<PackOptions, "overrides" | "configFile"> = {},
): Promise<PackOutcome> {
  const { config } = load;
  const emit = options.onProgress ?? ((): void => undefined);
  const startedAt = new Date().toISOString();
  const start = Date.now();

  emit({ phase: "discover", message: "scanning the project" });
  const scan = await scanProject(config, {
    onProgress: (message, current, total) =>
      emit({ phase: "discover", message, current, total }),
  });

  emit({
    phase: "compress",
    message: `compressing (${config.compression})`,
    current: 0,
    total: scan.totals.included,
  });
  const compression = compressFiles(scan.files, config);

  emit({
    phase: "compress",
    message:
      config.maxTokens > 0
        ? `fitting into ~${formatCount(config.maxTokens)} tokens`
        : "no token budget set",
  });
  const budget = enforceBudget(scan.files, config.maxTokens, {
    strategy: config.budgetStrategy,
  });

  emit({ phase: "analyze", message: "running analyzers" });
  const sections = runAnalyzers(scan, config);

  const bundle = makeBundle(
    config,
    scan,
    sections,
    compression,
    startedAt,
    Date.now() - start,
  );

  const outputs: OutputArtifact[] = [];
  if (options.write !== false) {
    emit({
      phase: "render",
      message: `rendering ${config.formats.length} format(s)`,
    });
    for (const format of config.formats) {
      const renderer = rendererFor(format);
      const rendered = renderer.render(bundle);
      const target = path.join(
        config.outputDir,
        outputFileName(format, config.outputName),
      );
      await ensureDir(config.outputDir);
      await writeFileSafe(target, rendered);
      const bytes = Buffer.isBuffer(rendered)
        ? rendered.byteLength
        : Buffer.byteLength(rendered, "utf8");
      outputs.push({
        format,
        path: target,
        bytes,
        tokens:
          format === "zip"
            ? 0
            : estimateTokens(typeof rendered === "string" ? rendered : ""),
      });
      emit({
        phase: "write",
        message: `wrote ${path.basename(target)} (${formatBytes(bytes)})`,
      });
    }

    if (config.writeManifest) {
      const manifestPath = path.join(
        config.outputDir,
        `${config.outputName}.manifest.json`,
      );
      await writeFileSafe(
        manifestPath,
        JSON.stringify(makeReport(bundle, load, outputs), null, 2) + "\n",
      );
      emit({ phase: "write", message: `wrote ${path.basename(manifestPath)}` });
    }

    if (config.includeReport) {
      const reportPath = path.join(config.outputDir, "REPORT.md");
      await writeFileSafe(
        reportPath,
        renderReport(makeReport(bundle, load, outputs)) + "\n",
      );
      emit({ phase: "write", message: `wrote ${path.basename(reportPath)}` });
    }
  }

  emit({
    phase: "write",
    message: "done",
    current: outputs.length,
    total: outputs.length,
  });

  const report = makeReport(bundle, load, outputs);
  void budget;
  return { report, bundle, outputs };
}

/** Build the bundle object out of the finished scan. */
export function makeBundle(
  config: PackConfig,
  scan: ScanResult,
  sections: Bundle["sections"],
  compression: CompressionStats,
  startedAt: string,
  durationMs: number,
): Bundle {
  const included = scan.files.filter(
    (file) => !file.dropped && !file.binary && file.content !== undefined,
  );
  const dropped = scan.files.filter((file) => file.dropped);
  const tokens = included.reduce(
    (sum, file) => sum + (file.tokens ?? estimateTokens(file.content ?? "")),
    0,
  );
  const includedBytes = included.reduce(
    (sum, file) =>
      sum +
      (file.includedSize ?? Buffer.byteLength(file.content ?? "", "utf8")),
    0,
  );

  const totals: BundleTotals = {
    files: scan.files.length,
    included: included.length,
    dropped: dropped.length,
    bytes: scan.totals.bytes,
    includedBytes,
    tokens,
    redactions: compression.redactions,
    truncated: included.filter((file) => file.truncated).length,
    compressionSavedBytes: compression.savedBytes,
  };

  return { config, scan, sections, totals, startedAt, durationMs };
}

/** Assemble the honest, machine-readable run report. */
export function makeReport(
  bundle: Bundle,
  load: ConfigLoadResult,
  outputs: OutputArtifact[],
): PackReport {
  const files: FileReportEntry[] = bundle.scan.files.map((file) => {
    const entry: FileReportEntry = {
      path: file.path,
      language: file.language,
      kind: file.kind,
      importance: file.importance,
      included: !file.dropped,
      tokens: file.tokens ?? 0,
      reasons: file.reasons,
    };
    if (file.dropReason !== undefined) entry.dropReason = file.dropReason;
    if (file.redactions !== undefined) entry.redactions = file.redactions;
    if (file.truncated !== undefined) entry.truncated = file.truncated;
    return entry;
  });

  return {
    version: VERSION,
    generatedAt: bundle.startedAt,
    root: bundle.scan.root,
    preset: bundle.config.preset,
    compression: bundle.config.compression,
    formats:
      outputs.length > 0
        ? outputs.map((output) => output.format)
        : bundle.config.formats,
    configSources: load.sources,
    problems: load.problems,
    totals: bundle.totals,
    stack: bundle.scan.stack,
    files,
    ignored: bundle.scan.ignored,
  };
}

/**
 * Human-readable `REPORT.md`.
 *
 * This is the honesty artefact: it states what was included, what was cut, which
 * secrets were redacted and how the token estimate was reached. It is written
 * next to the bundle so the person can check the numbers before pasting anything
 * into a chat.
 */
export function renderReport(report: PackReport): string {
  const out: string[] = [];
  out.push("# aibundle run report");
  out.push("");
  out.push(`- **Generated:** ${report.generatedAt}`);
  out.push(`- **Project root:** \`${report.root}\``);
  out.push(
    `- **Preset:** \`${report.preset}\` \u00b7 **Compression:** \`${report.compression}\``,
  );
  out.push(
    `- **Formats:** ${report.formats.map((format) => `\`${format}\``).join(", ")}`,
  );
  out.push(`- **Generator:** aibundle v${report.version}`);
  out.push("");

  out.push("## Totals");
  out.push("");
  out.push("| Metric | Value |");
  out.push("| --- | ---: |");
  out.push(`| Files discovered | ${report.totals.files} |`);
  out.push(`| Files included | ${report.totals.included} |`);
  out.push(`| Files dropped | ${report.totals.dropped} |`);
  out.push(
    `| Bytes before compression | ${formatBytes(report.totals.bytes)} |`,
  );
  out.push(
    `| Bytes after compression | ${formatBytes(report.totals.includedBytes)} |`,
  );
  out.push(
    `| Compression saved | ${formatBytes(report.totals.compressionSavedBytes)} |`,
  );
  out.push(`| Estimated tokens | ${formatCount(report.totals.tokens)} |`);
  out.push(`| Secrets redacted | ${report.totals.redactions} |`);
  out.push(`| Files truncated | ${report.totals.truncated} |`);
  out.push("");

  if (report.stack.length > 0) {
    out.push("## Detected stack");
    out.push("");
    for (const entry of report.stack)
      out.push(`- **${entry.label}** — ${entry.evidence}`);
    out.push("");
  }

  if (report.configSources.length > 0 || report.problems.length > 0) {
    out.push("## Configuration");
    out.push("");
    if (report.configSources.length > 0)
      out.push(
        `Sources: ${report.configSources.map((source) => `\`${source}\``).join(" \u2192 ")}`,
      );
    if (report.problems.length > 0) {
      out.push("");
      out.push("Problems:");
      for (const problem of report.problems) out.push(`- ${problem}`);
    }
    out.push("");
  }

  out.push("## Files");
  out.push("");
  out.push("| File | Kind | Included | ~Tokens | Score | Redactions | Notes |");
  out.push("| --- | --- | :---: | ---: | ---: | ---: | --- |");
  for (const file of report.files.slice(0, 500)) {
    const notes: string[] = [];
    if (file.truncated) notes.push("truncated");
    if (file.dropReason) notes.push(file.dropReason);
    out.push(
      `| \`${file.path}\` | ${file.kind} | ${file.included ? "\u2714" : "\u2716"} | ${file.tokens} | ${file.importance} | ${file.redactions ?? 0} | ${notes.join(", ") || file.reasons.join(", ")} |`,
    );
  }
  if (report.files.length > 500)
    out.push(`| _\u2026 ${report.files.length - 500} more_ | | | | | | |`);
  out.push("");

  if (report.ignored.length > 0) {
    out.push("## Skipped paths");
    out.push("");
    const byReason = new Map<string, number>();
    for (const entry of report.ignored)
      byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);
    for (const [reason, count] of [...byReason.entries()].sort(
      (a, b) => b[1] - a[1],
    )) {
      out.push(`- **${reason}**: ${count}`);
    }
    out.push("");
  }

  return out.join("\n").trimEnd();
}

/**
 * Compact summary rows for the terminal — what the CLI prints when the run ends.
 */
export function summarizeOutcome(
  outcome: PackOutcome,
): Array<[string, string]> {
  const { report, bundle } = outcome;
  return [
    ["Project", report.root],
    ["Preset", `${report.preset}  compression: ${report.compression}`],
    [
      "Files",
      `${report.totals.included} included, ${report.totals.dropped} dropped, ${report.totals.files} discovered`,
    ],
    [
      "Size",
      `${formatBytes(report.totals.includedBytes)} (saved ${formatBytes(report.totals.compressionSavedBytes)})`,
    ],
    [
      "~Tokens",
      `${formatCount(report.totals.tokens)}  in ${bundle.durationMs}ms`,
    ],
    [
      "Secrets",
      report.totals.redactions > 0
        ? `${report.totals.redactions} redacted`
        : "none found",
    ],
    ["Output", bundle.config.outputDir],
  ];
}
