/**
 * End-to-end tests.
 *
 * Each test builds a real project in a temp directory and runs the real
 * pipeline: scan -> compress -> analyze -> render -> write. The assertions are
 * written against *observable behaviour* (what lands in the output files, what
 * the report claims) rather than internal state, so they stay meaningful as the
 * implementation changes.
 *
 * @module test/e2e.test
 */

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";

import { packProject } from "../src/core/pipeline.js";
import { resolveConfig } from "../src/core/config.js";
import { scanProject } from "../src/core/scanner.js";
import {
  renderJson,
  renderMarkdown,
  renderXml,
  renderZipBundle,
} from "../src/renderers/index.js";
import { readZipEntries } from "../src/renderers/zip.js";
import { estimateTokens } from "../src/utils/tokenizer.js";
import { EXPECTED_FILES, REACT_TS_PROJECT, makeProject } from "./helpers.js";
import type { Bundle, PackOutcome } from "../src/types.js";

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  await Promise.all(cleanups.map((fn) => fn()));
});

async function project(
  files: Record<string, string> = REACT_TS_PROJECT,
): Promise<string> {
  const created = await makeProject(files);
  cleanups.push(created.cleanup);
  return created.root;
}

async function pack(
  files: Record<string, string> = REACT_TS_PROJECT,
  overrides = {},
): Promise<PackOutcome> {
  const root = await project(files);
  return packProject(root, {
    overrides: { formats: ["markdown"], ...overrides },
  });
}

describe("scanning a real project", () => {
  it("finds the source files and skips node_modules and dist", async () => {
    const root = await project();
    const { config } = await resolveConfig(root, {});
    const scan = await scanProject(config);
    const paths = scan.files.map((file) => file.path);
    for (const expected of EXPECTED_FILES)
      assert.ok(paths.includes(expected), `missing ${expected}`);
    assert.ok(
      !paths.some((entry) => entry.includes("node_modules")),
      "node_modules must never be scanned",
    );
    assert.ok(
      !paths.some((entry) => entry.startsWith("dist/")),
      "dist must never be scanned",
    );
  });

  it("detects the stack and the languages with evidence", async () => {
    const root = await project();
    const { config } = await resolveConfig(root, {});
    const scan = await scanProject(config);
    const ids = scan.stack.map((entry) => entry.id);
    assert.ok(ids.includes("react"));
    assert.ok(ids.includes("typescript"));
    assert.ok(
      scan.languages.some(
        (entry) => entry.language === "tsx" && entry.files >= 2,
      ),
    );
  });

  it("ranks an entry point above a nested test file", async () => {
    const root = await project();
    const { config } = await resolveConfig(root, {});
    const scan = await scanProject(config);
    const app = scan.files.find((file) => file.path === "src/main.tsx")!;
    const test = scan.files.find((file) => file.path.includes("__tests__"))!;
    assert.ok(
      app.importance > test.importance,
      `${app.importance} should beat ${test.importance}`,
    );
  });

  it("never re-scans its own output directory, even on a second run", async () => {
    const root = await project();
    const first = await packProject(root, {
      overrides: { formats: ["markdown"] },
    });
    const second = await packProject(root, {
      overrides: { formats: ["markdown"] },
    });
    assert.equal(second.bundle.totals.included, first.bundle.totals.included);
    assert.ok(
      !second.bundle.scan.files.some((file) =>
        file.path.includes("aibundle-out"),
      ),
    );
  });

  it("is deterministic: the same project twice gives the same token count", async () => {
    const root = await project();
    const one = await packProject(root, {
      overrides: { formats: ["markdown"] },
    });
    const two = await packProject(root, {
      overrides: { formats: ["markdown"] },
    });
    assert.equal(one.bundle.totals.tokens, two.bundle.totals.tokens);
  });
});

describe("compression and redaction", () => {
  it("redacts a real-looking secret before it reaches the bundle", async () => {
    const outcome = await pack(REACT_TS_PROJECT, { compression: "balanced" });
    const md = renderMarkdown(outcome.bundle);
    assert.match(md, /redacted:openai-key/);
    assert.ok(
      !md.includes("sk-live-abcdefghijklmnopqrstuvwxyz0123456789"),
      "the secret must not survive",
    );
    assert.ok(!md.includes("AIzaSy"), "no google key may leak");
    assert.ok(outcome.report.totals.redactions >= 1);
  });

  it("keeps placeholders readable", async () => {
    const outcome = await pack(REACT_TS_PROJECT, { compression: "none" });
    const md = renderMarkdown(outcome.bundle);
    assert.match(md, /process\.env\.OTHER/);
  });

  it("strips comments at balanced and keeps them at none", async () => {
    const balanced = await pack(REACT_TS_PROJECT, { compression: "balanced" });
    const verbatim = await pack(REACT_TS_PROJECT, { compression: "none" });
    assert.ok(
      renderMarkdown(balanced.bundle).length <
        renderMarkdown(verbatim.bundle).length,
    );
    assert.match(renderMarkdown(verbatim.bundle), /TODO: add routing/);
  });

  it("reports the TODO/FIXME markers it found", async () => {
    const outcome = await pack(REACT_TS_PROJECT, { compression: "none" });
    const md = renderMarkdown(outcome.bundle);
    assert.match(md, /TODO\/FIXME markers/);
    assert.match(md, /TODO: add routing/);
  });
});

describe("renderers", () => {
  it("produces markdown with the expected sections and no placeholder artefacts", async () => {
    const outcome = await pack(REACT_TS_PROJECT, { includeToc: true });
    const md = renderMarkdown(outcome.bundle);
    assert.match(md, /^# .*AI context bundle/m);
    assert.match(md, /## Project summary/);
    assert.match(md, /## Directory tree/);
    assert.match(md, /## Files/);
    assert.match(md, /```tsx\n/);
    assert.ok(
      !md.includes("[object Object]"),
      "analyzers must be rendered, not stringified",
    );
    assert.ok(
      !md.includes("undefined"),
      "no undefined may leak into the bundle",
    );
  });

  it("produces well-formed XML with one document per file", async () => {
    const outcome = await pack(REACT_TS_PROJECT);
    const xml = renderXml(outcome.bundle);
    assert.match(xml, /^<\?xml version="1\.0"/);
    assert.match(xml, /<context_bundle /);
    assert.match(xml, /<documents count="\d+">/);
    assert.match(xml, /<document path="src\/App\.tsx"/);
    assert.ok(xml.includes("]]>") === true);
    assert.equal(
      count(xml, "<document ") - count(xml, "</document>"),
      0,
      "documents must be balanced",
    );
    assert.ok(!xml.includes("[object Object]"));
  });

  it("produces JSON that round-trips and matches the totals", async () => {
    const outcome = await pack(REACT_TS_PROJECT);
    const parsed = JSON.parse(renderJson(outcome.bundle)) as {
      schema: string;
      totals: { tokens: number; included: number };
      files: Array<{ path: string; content: string }>;
      sections: Array<{ id: string }>;
    };
    assert.equal(parsed.schema, "aibundle/bundle@2");
    assert.equal(parsed.totals.included, outcome.bundle.totals.included);
    assert.ok(parsed.files.some((file) => file.path === "src/App.tsx"));
    assert.ok(parsed.sections.some((section) => section.id === "summary"));
    assert.ok(parsed.totals.tokens > 0);
  });

  it("produces a valid zip holding every format plus the raw files", async () => {
    const outcome = await pack(REACT_TS_PROJECT, {
      formats: ["markdown", "zip"],
    });
    const archive = renderZipBundle(outcome.bundle);
    const entries = readZipEntries(archive);
    const names = entries.map((entry) => entry.path);
    assert.ok(names.includes("project-context.md"));
    assert.ok(names.includes("project-context.xml"));
    assert.ok(names.includes("project-context.json"));
    assert.ok(names.includes("manifest.json"));
    assert.ok(names.includes("files/src/App.tsx"));
    assert.ok(names.every((name) => !name.includes("..")));
  });
});

describe("token budgeting", () => {
  it("meets a tight budget and explains what it cut", async () => {
    const big: Record<string, string> = { ...REACT_TS_PROJECT };
    for (let i = 0; i < 12; i += 1) {
      big[`src/generated/Module${i}.ts`] =
        `export const VALUE_${i} = "${"x".repeat(4000)}";\n`;
    }
    const outcome = await pack(big, { maxTokens: 3000 });
    assert.ok(
      outcome.bundle.totals.tokens <= 3400,
      `expected a trimmed bundle, got ${outcome.bundle.totals.tokens}`,
    );
    assert.ok(
      outcome.bundle.totals.truncated > 0 || outcome.bundle.totals.dropped > 0,
    );
    assert.match(renderMarkdown(outcome.bundle), /omitted|budget/);
  });

  it("leaves the bundle unlimited when maxTokens is 0", async () => {
    const outcome = await pack(REACT_TS_PROJECT, { maxTokens: 0 });
    assert.ok(outcome.bundle.totals.included >= EXPECTED_FILES.length);
  });
});

describe("written artefacts", () => {
  it("writes every requested format plus the manifest and report", async () => {
    const root = await project();
    const outcome = await packProject(root, {
      overrides: { formats: ["markdown", "json", "zip"], outputDir: "out" },
    });
    const files = await fsp.readdir(path.join(root, "out"));
    assert.ok(files.includes("project-context.md"));
    assert.ok(files.includes("project-context.json"));
    assert.ok(files.includes("project-context.zip"));
    assert.ok(files.includes("project-context.manifest.json"));
    assert.ok(files.includes("REPORT.md"));
    assert.equal(outcome.outputs.length, 3);
    for (const output of outcome.outputs) {
      const stat = await fsp.stat(output.path);
      assert.ok(stat.size > 0, `${output.path} must not be empty`);
    }
  });

  it("writes an honest report naming what it dropped", async () => {
    const root = await project();
    await packProject(root, {
      overrides: { formats: ["markdown"], outputDir: "out", maxTokens: 800 },
    });
    const report = await fsp.readFile(
      path.join(root, "out", "REPORT.md"),
      "utf8",
    );
    assert.match(report, /aibundle run report/);
    assert.match(report, /Estimated tokens/);
    assert.match(report, /Secrets redacted/);
    assert.match(report, /\| File \| Kind \|/);
  });

  it("writes nothing on a dry run but still returns a full report", async () => {
    const root = await project();
    const outcome = await packProject(root, {
      overrides: { formats: ["markdown"], outputDir: "out" },
      write: false,
    });
    assert.equal(outcome.outputs.length, 0);
    assert.ok(outcome.report.totals.included > 0);
    await assert.rejects(() => fsp.readdir(path.join(root, "out")));
  });

  it("reports the token estimate consistently with the rendered markdown", async () => {
    const outcome = await pack(REACT_TS_PROJECT);
    const md = renderMarkdown(outcome.bundle);
    const mdTokens = estimateTokens(md);
    const fileTokens = estimateTokens(md.split("## Files")[0] ?? "");
    assert.ok(
      outcome.bundle.totals.tokens < mdTokens,
      "the bundle total counts file bodies only",
    );
    assert.ok(fileTokens > 0);
  });
});

describe("bundle shape", () => {
  it("exposes a bundle that matches the documented contract", async () => {
    const outcome = await pack(REACT_TS_PROJECT);
    const bundle: Bundle = outcome.bundle;
    assert.ok(bundle.config.root.length > 0);
    assert.ok(bundle.scan.files.length > 0);
    assert.ok(bundle.sections.length >= 4);
    assert.equal(typeof bundle.durationMs, "number");
    assert.ok(bundle.startedAt.includes("T"));
    for (const section of bundle.sections) {
      assert.equal(typeof section.id, "string");
      assert.equal(typeof section.render, "function");
      assert.ok(
        section.render({ config: bundle.config, scan: bundle.scan }).length >=
          0,
      );
    }
  });
});

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
