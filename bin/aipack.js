#!/usr/bin/env node
/**
 * Executable shim.
 *
 * The whole implementation lives in TypeScript under `src/`, compiled to
 * `dist/`. This file is the only JavaScript that ships in `bin/`, so
 * `npm link` and `npx` work as soon as `npm run build` has run once.
 *
 * If the compiled output is missing we print an actionable message instead of
 * a raw MODULE_NOT_FOUND stack trace.
 */

const entry = "../dist/src/cli/main.js";

import(new URL(entry, import.meta.url).href)
  .then((mod) => mod.main(process.argv.slice(2)))
  .catch((error) => {
    if (error && error.code === "ERR_MODULE_NOT_FOUND") {
      console.error("aibundle: compiled output not found.");
      console.error(
        "Run `npm run build` first (or `npm install`, which builds automatically).",
      );
    } else {
      console.error("aibundle: unexpected failure");
      console.error(error);
    }
    process.exitCode = 1;
  });
