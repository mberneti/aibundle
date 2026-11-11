/**
 * CLI entry point.
 *
 * Kept tiny on purpose: parse, dispatch to the informational flags, then hand off
 * to {@link run}. Exit codes are meaningful so CI can rely on them:
 *
 * | code | meaning                                        |
 * | ---- | ---------------------------------------------- |
 * | 0    | success                                        |
 * | 1    | runtime failure (bad path, scan error)         |
 * | 2    | usage error (unknown flag, invalid value)      |
 * | 130  | cancelled by the user (Ctrl-C)                 |
 *
 * @module cli/main
 */

import { parseArgs, toOverrides, flagString, flagBool } from "./args.js";
import {
  listAnalyzersText,
  listFormats,
  printSummary,
  resolveRoot,
  run,
  usage,
} from "./run.js";
import { PRESETS } from "../core/config.js";
import { VERSION } from "../core/pipeline.js";
import { CancelledError } from "../utils/prompt.js";
import { setColorEnabled, color, statusLine } from "../utils/style.js";
import type { Verbosity } from "../types.js";

/** Parse and execute. Returns the intended process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.help || (argv.length === 0 && !process.stdin.isTTY)) {
    process.stdout.write(usage() + "\n");
    return 0;
  }
  if (args.version) {
    process.stdout.write(VERSION + "\n");
    return 0;
  }

  if (flagBool(args, "no-color")) setColorEnabled(false);
  if (flagBool(args, "color")) setColorEnabled(true);

  // Informational flags exit before any scanning happens.
  if (flagBool(args, "list-presets")) {
    process.stdout.write(
      Object.entries(PRESETS)
        .map(
          ([name, preset]) =>
            `  ${color.cyan(name.padEnd(9))} ${preset.description}`,
        )
        .join("\n") + "\n",
    );
    return 0;
  }
  if (flagBool(args, "list-formats")) {
    process.stdout.write(listFormats() + "\n");
    return 0;
  }
  if (flagBool(args, "list-analyzers")) {
    process.stdout.write(listAnalyzersText() + "\n");
    return 0;
  }

  const { overrides, errors } = toOverrides(args);

  const verbosity: Verbosity = flagBool(args, "quiet")
    ? "quiet"
    : flagBool(args, "verbose")
      ? "verbose"
      : "normal";
  overrides.verbosity = verbosity;

  if (errors.length > 0) {
    for (const error of errors)
      process.stderr.write(statusLine("error", error) + "\n");
    process.stderr.write(color.dim("Run `aibundle --help` for usage.\n"));
    return 2;
  }

  let root: string;
  try {
    root = resolveRoot(args.positionals[0]);
  } catch (error) {
    process.stderr.write(statusLine("error", (error as Error).message) + "\n");
    return 1;
  }

  const configFile = flagString(args, "config");

  try {
    const outcome = await run({
      root,
      overrides,
      ...(configFile !== undefined ? { configFile } : {}),
      assumeYes: args.yes,
      dryRun: flagBool(args, "dry-run"),
      verbosity,
      printPaths: flagBool(args, "open"),
    });
    printSummary(outcome, {
      root,
      overrides,
      assumeYes: args.yes,
      dryRun: flagBool(args, "dry-run"),
      verbosity,
      printPaths: flagBool(args, "open"),
    });
    return 0;
  } catch (error) {
    if (error instanceof CancelledError) {
      process.stderr.write("\n" + statusLine("warn", "Cancelled.") + "\n");
      return 130;
    }
    process.stderr.write(statusLine("error", (error as Error).message) + "\n");
    if (flagBool(args, "verbose") && error instanceof Error && error.stack) {
      process.stderr.write(color.dim(error.stack) + "\n");
    }
    return 1;
  }
}
