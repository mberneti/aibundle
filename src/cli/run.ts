/**
 * CLI runner: usage, help, progress rendering and the run itself.
 *
 * The UX contract this file implements:
 * - progress is a single rewritten status line, so a long scan stays calm;
 * - the end of a run prints a compact, copy-pasteable summary;
 * - every message goes to stderr for progress and stdout for the final summary,
 *   so `aibundle . > summary.txt` captures only the summary;
 * - a Ctrl-C is honoured immediately and leaves no half-written state behind.
 *
 * @module cli/run
 */

import path from "node:path";

import type {
  PackConfig,
  PackOutcome,
  ProgressEvent,
  PartialConfig,
} from "../types.js";
import { COMPRESSION_LEVELS, OUTPUT_FORMATS, PRESET_NAMES } from "../types.js";
import { PRESETS, describeConfig, resolveConfig } from "../core/config.js";
import { packWithConfig, summarizeOutcome, VERSION } from "../core/pipeline.js";
import { listAnalyzers } from "../analyzers/index.js";
import { listRenderers } from "../renderers/index.js";
import { scanProject } from "../core/scanner.js";
import { CancelledError, isInteractive } from "../utils/prompt.js";
import { runWizard } from "./wizard.js";
import {
  color,
  formatBytes,
  formatCount,
  setColorEnabled,
  statusLine,
  table,
} from "../utils/style.js";
import { existsSync } from "../utils/fs.js";

/** Everything `run` needs, already parsed and validated. */
export interface RunInput {
  /** Project root, absolute. */
  root: string;
  overrides: PartialConfig;
  configFile?: string;
  assumeYes: boolean;
  dryRun: boolean;
  verbosity: "quiet" | "normal" | "verbose";
  /** `--open`: print the output directory as the last line for scripting. */
  printPaths: boolean;
}

/** Small progress renderer that rewrites one line while working. */
class ProgressLine {
  private lastLength = 0;
  private enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  update(event: ProgressEvent): void {
    if (!this.enabled) return;
    const counter =
      event.total && event.current !== undefined
        ? ` ${event.current}/${event.total}`
        : "";
    const text = `${color.cyan("\u203a")} ${event.phase.padEnd(9)} ${event.message}${color.dim(counter)}`;
    const visible = Math.min(text.length, (process.stderr.columns ?? 80) - 1);
    process.stderr.write(
      "\r" + " ".repeat(this.lastLength) + "\r" + text.slice(0, visible),
    );
    this.lastLength = visible;
  }

  clear(): void {
    if (!this.enabled || this.lastLength === 0) return;
    process.stderr.write("\r" + " ".repeat(this.lastLength) + "\r");
    this.lastLength = 0;
  }
}

/** The `--help` screen. */
export function usage(): string {
  const lines: string[] = [];
  lines.push(`${color.bold("ai-project-packer")} ${color.dim(`v${VERSION}`)}`);
  lines.push(
    "Turn any code project into token-optimised, compressed context bundles for AI chats.",
  );
  lines.push("");
  lines.push(color.bold("USAGE"));
  lines.push("  aibundle [path] [options]");
  lines.push("");
  lines.push(color.bold("EXAMPLES"));
  lines.push(
    "  aibundle                        # interactive wizard in the current directory",
  );
  lines.push(
    "  aibundle ./my-app -y            # non-interactive, sensible defaults",
  );
  lines.push("  aibundle . --preset claude --toc");
  lines.push("  aibundle . -f markdown,zip -c aggressive -t 110k");
  lines.push(
    "  aibundle . --dry-run --verbose  # scan and report, write nothing",
  );
  lines.push("");
  lines.push(color.bold("OPTIONS"));
  const rows: Array<[string, string]> = [
    ["-p, --preset <name>", `one of ${PRESET_NAMES.join(", ")}`],
    ["-f, --format <list>", `comma-separated: ${OUTPUT_FORMATS.join(", ")}`],
    ["-c, --compression <lvl>", `one of ${COMPRESSION_LEVELS.join(", ")}`],
    ["-o, --out <dir>", "output directory (default: aibundle-out)"],
    ["-n, --name <base>", "base file name (default: project-context)"],
    ["-t, --max-tokens <n>", "token budget, e.g. 110k (0 = unlimited)"],
    ["-s, --max-size <size>", "per-file size cap, e.g. 2mb"],
    [
      "-i, --ignore <pattern>",
      "extra ignore pattern (repeatable, gitignore syntax)",
    ],
    ["    --ignore-dir <name>", "extra directory name to skip (repeatable)"],
    ["    --config <file>", "explicit config file"],
    ["    --hidden", "include dotfiles"],
    ["    --binary", "keep binary files as manifest entries"],
    ["    --no-gitignore", "do not honour .gitignore"],
    ["    --no-redact", "disable secret redaction"],
    ["    --no-report", "skip the REPORT.md appendix"],
    ["    --no-tree", "skip the directory tree section"],
    ["    --no-summary", "skip the auto summary section"],
    ["    --no-meta", "skip metadata blocks"],
    ["    --no-manifest", "skip the manifest.json sidecar"],
    ["    --toc", "include a table of contents"],
    ["    --line-numbers", "prefix line numbers inside code fences"],
    ["    --dry-run", "scan and report without writing anything"],
    ["    --list-presets", "show the presets and exit"],
    ["    --list-formats", "show the output formats and exit"],
    ["    --list-analyzers", "show the registered analyzers and exit"],
    ["    --no-color / --color", "force styling off/on"],
    ["-q, --quiet / -V, --verbose", "less or more output"],
    ["-y, --yes", "skip the wizard, accept defaults"],
    ["-h, --help", "this screen"],
    ["-v, --version", "print the version"],
  ];
  lines.push(
    ...rows.map(
      ([flag, description]) => `  ${flag.padEnd(26)} ${color.dim(description)}`,
    ),
  );
  lines.push("");
  lines.push(color.bold("PRESETS"));
  for (const name of PRESET_NAMES) {
    lines.push(`  ${color.cyan(name.padEnd(9))} ${PRESETS[name].description}`);
  }
  return lines.join("\n");
}

/** Extras such as `--list-formats`. */
export function listFormats(): string {
  return listRenderers()
    .map(
      (renderer) =>
        `  ${renderer.id.padEnd(10)} ${color.dim(renderer.label)}  -> ${renderer.extension}`,
    )
    .join("\n");
}

export function listAnalyzersText(): string {
  return listAnalyzers()
    .map(
      (analyzer) => `  ${analyzer.id.padEnd(10)} ${color.dim(analyzer.title)}`,
    )
    .join("\n");
}

/** Run one pack. Throws {@link CancelledError} when the user aborts. */
export async function run(input: RunInput): Promise<PackOutcome> {
  const progress = new ProgressLine(
    input.verbosity !== "quiet" && isInteractive(),
  );

  try {
    // The wizard needs the scan, so resolve config and scan before asking.
    const load = await resolveConfig(input.root, input.overrides, {
      configFile: input.configFile,
    });

    if (input.overrides.color !== undefined)
      setColorEnabled(Boolean(input.overrides.color));

    if (input.dryRun) {
      progress.update({ phase: "discover", message: "dry run: scanning only" });
      const scan = await scanProject(load.config);
      progress.clear();
      return dryRunOutcome(load.config, scan);
    }

    if (!input.assumeYes && isInteractive()) {
      progress.update({
        phase: "discover",
        message: "scanning before the wizard",
      });
      const scan = await scanProject(load.config);
      progress.clear();
      const answers = await runWizard(load.config, scan);
      if (!answers.confirmed) throw new CancelledError("wizard declined");
      const merged = await resolveConfig(
        input.root,
        { ...input.overrides, ...answers.overrides },
        { configFile: input.configFile },
      );
      Object.assign(load, merged);
    }

    const outcome = await packWithConfig(load, {
      onProgress: (event) => progress.update(event),
      write: true,
    });
    progress.clear();
    return outcome;
  } finally {
    progress.clear();
  }
}

/** A `--dry-run` outcome: a real report, no files written. */
async function dryRunOutcome(
  config: PackConfig,
  scan: Awaited<ReturnType<typeof scanProject>>,
): Promise<PackOutcome> {
  const { makeBundle, makeReport } = await import("../core/pipeline.js");
  const { runAnalyzers } = await import("../analyzers/index.js");
  const { compressFiles, enforceBudget } =
    await import("../core/compressor.js");

  const compression = compressFiles(scan.files, config);
  enforceBudget(scan.files, config.maxTokens, {
    strategy: config.budgetStrategy,
  });
  const sections = runAnalyzers(scan, config);
  const startedAt = new Date().toISOString();
  const bundle = makeBundle(config, scan, sections, compression, startedAt, 0);
  const load = await resolveConfig(config.root, {}, {});
  const report = makeReport(bundle, { ...load, config }, []);
  return { report, bundle, outputs: [] };
}

/** Pretty end-of-run summary. */
export function printSummary(outcome: PackOutcome, input: RunInput): void {
  if (input.verbosity === "quiet") return;
  const rows = summarizeOutcome(outcome);

  process.stdout.write("\n");
  process.stdout.write(
    statusLine("success", color.bold("Bundle ready")) + "\n",
  );
  process.stdout.write(table(rows) + "\n");

  if (outcome.outputs.length > 0) {
    process.stdout.write("\n");
    process.stdout.write(statusLine("step", "Written files") + "\n");
    for (const output of outcome.outputs) {
      process.stdout.write(
        `   ${color.dim("\u2022")} ${color.cyan(path.basename(output.path))}  ${color.dim(formatBytes(output.bytes))}${output.tokens ? color.dim(`  ~${formatCount(output.tokens)} tokens`) : ""}\n`,
      );
    }
  } else if (input.dryRun) {
    process.stdout.write(
      "\n" + statusLine("warn", "Dry run: nothing was written.") + "\n",
    );
  }

  if (outcome.report.problems.length > 0) {
    process.stdout.write("\n");
    for (const problem of outcome.report.problems)
      process.stdout.write(statusLine("warn", problem) + "\n");
  }

  if (input.verbosity === "verbose") {
    process.stdout.write(
      "\n" + color.dim(describeConfig(outcome.bundle.config)) + "\n",
    );
    const analyzers = listAnalyzers()
      .map((analyzer) => analyzer.id)
      .join(", ");
    process.stdout.write(color.dim(`analyzers: ${analyzers}`) + "\n");
  }

  if (input.printPaths) {
    for (const output of outcome.outputs)
      process.stdout.write(output.path + "\n");
  }
}

/** Resolve the project root from a positional argument. */
export function resolveRoot(positional: string | undefined): string {
  const candidate = path.resolve(positional ?? process.cwd());
  if (!existsSync(candidate)) {
    throw new Error(`path does not exist: ${candidate}`);
  }
  return candidate;
}
