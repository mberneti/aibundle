/**
 * Project scanner.
 *
 * Turns a directory into a ranked {@link ScanResult}: walk, filter, classify,
 * score, read. Everything downstream (compressor, analyzers, renderers) consumes
 * the result and never touches the filesystem again, which keeps the pipeline
 * deterministic and easy to test.
 *
 * ## Ranking
 *
 * `importance` is a 0–100 heuristic. It is *not* a claim about code quality —
 * it answers one question: if the token budget forces a cut, which files best
 * let a model understand this project? Entry points, manifests and the root
 * README outrank a random component; tests and styles outrank nothing but
 * assets. Every decision is recorded in `reasons` so the report can show its
 * work.
 *
 * @module core/scanner
 */

import path from "node:path";

import type {
  FileKind,
  FileRecord,
  IgnoredEntry,
  LanguageStat,
  PackConfig,
  ScanResult,
  ScanTotals,
  StackInfo,
} from "../types.js";
import { detectLanguage, groupByLanguage } from "./languages.js";
import {
  DEFAULT_IGNORE_DIRS,
  LOW_SIGNAL_EXTENSIONS,
  extOf,
  countLines,
  isBinary,
  isDirectory,
  normalizeText,
  readTextFile,
  walk,
} from "../utils/fs.js";
import {
  matcherFromText,
  matcherFromPatterns,
  IgnoreMatcher,
} from "../utils/glob.js";
import { fsp } from "../utils/fs.js";

/** Filenames that are always worth reading, whatever their score. */
const ENTRY_POINT_NAMES: ReadonlySet<string> = new Set([
  "index.ts",
  "index.tsx",
  "index.js",
  "index.jsx",
  "index.mjs",
  "main.ts",
  "main.tsx",
  "main.js",
  "main.jsx",
  "app.ts",
  "app.tsx",
  "app.js",
  "app.jsx",
  "server.ts",
  "server.js",
  "entry.ts",
  "entry.js",
  "src/main.ts",
  "src/main.tsx",
  "src/index.ts",
  "src/index.tsx",
  "__init__.py",
  "main.py",
  "app.py",
  "manage.py",
  "cmd/main.go",
  "lib.rs",
  "main.rs",
]);

/** Manifests and lockfiles: small, high signal. */
const MANIFEST_NAMES: ReadonlySet<string> = new Set([
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "nuxt.config.ts",
  "svelte.config.js",
  "angular.json",
  "vue.config.js",
  "webpack.config.js",
  "rollup.config.js",
  "esbuild.config.js",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "setup.cfg",
  "pipfile",
  "cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "gemfile",
  "mix.exs",
  "pubspec.yaml",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "makefile",
  "justfile",
  ".env.example",
  "requirements-dev.txt",
]);

const README_RE =
  /^(readme|changelog|contributing|architecture|design|overview|license)(\.|$)/i;
const TEST_RE =
  /(\.|-|_)(test|spec|e2e)(\.|-|_)|(__tests__|\/tests?\/|\/e2e\/|\/spec\/)/i;
const STYLE_RE = /\.(css|scss|sass|less|styl|pcss)$/i;
const DOC_RE = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
const CONFIG_RE =
  /(\.config\.|\.rc$|\.json$|\.ya?ml$|\.toml$|\.ini$|\.env$|\.properties$)/i;

/** Extensions that are almost always generated noise. */
const NOISE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".map",
  ".lock",
  ".log",
  ".snap",
]);

export interface ScanOptions {
  /** Progress callback, called with a phase/message pair. */
  onProgress?: (message: string, current?: number, total?: number) => void;
}

/**
 * Scan `config.root`.
 *
 * @param config a fully resolved configuration
 */
export async function scanProject(
  config: PackConfig,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const matchers: IgnoreMatcher[] = [];

  if (config.respectGitignore) {
    for (const name of [".gitignore", ".aibundleignore"]) {
      const candidate = path.join(config.root, name);
      try {
        const text = await fsp.readFile(candidate, "utf8");
        matchers.push(matcherFromText(text, { root: config.root }));
      } catch {
        /* no ignore file — fine */
      }
    }
  }
  if (config.ignore.length > 0)
    matchers.push(matcherFromPatterns(config.ignore, { root: config.root }));

  const matcher = {
    matches(relativePath: string, isDir = false): boolean {
      return matchers.some((m) => m.matches(relativePath, isDir));
    },
  };

  options.onProgress?.("walking the project tree");
  const walked = await walk(config.root, {
    ignoreDirs: [
      ...DEFAULT_IGNORE_DIRS,
      ...config.ignoreDirs,
      relativeOutputDir(config),
    ],
    matcher,
    maxFileSize: config.maxFileSize,
    includeHidden: config.includeHidden,
  });

  const ignored: IgnoredEntry[] = [];
  const candidates: FileRecord[] = [];

  for (const entry of walked) {
    if (entry.skipped === "too-large") {
      ignored.push({ path: entry.relativePath, reason: "too-large" });
      continue;
    }
    const ext = entry.ext;
    if (NOISE_EXTENSIONS.has(ext)) {
      ignored.push({ path: entry.relativePath, reason: "low-signal" });
      continue;
    }
    if (LOW_SIGNAL_EXTENSIONS.has(ext)) {
      ignored.push({ path: entry.relativePath, reason: "low-signal" });
      continue;
    }
    if (entry.size === 0) {
      ignored.push({ path: entry.relativePath, reason: "empty" });
      continue;
    }

    const spec = detectLanguage(entry.relativePath);
    candidates.push({
      path: entry.relativePath,
      absolutePath: entry.absolutePath,
      size: entry.size,
      lines: 0,
      language: spec.id,
      languageName: spec.name,
      kind: classify(entry.relativePath, spec.id),
      importance: 0,
      reasons: [],
    });
  }

  options.onProgress?.(
    `reading ${candidates.length} files`,
    0,
    candidates.length,
  );

  const kept: FileRecord[] = [];
  let read = 0;
  for (const record of candidates) {
    const binary = await isBinary(record.absolutePath, {
      ext: extOf(record.path),
      size: record.size,
    });
    if (binary) {
      record.binary = true;
      if (!config.includeBinary) {
        record.dropped = true;
        record.dropReason = "binary";
        ignored.push({ path: record.path, reason: "binary" });
      }
      kept.push(record);
      read += 1;
      continue;
    }

    try {
      const raw = await readTextFile(record.absolutePath);
      const content = normalizeText(raw);
      record.content = content;
      record.lines = countLines(content);
    } catch {
      record.dropped = true;
      record.dropReason = "low-signal";
      ignored.push({ path: record.path, reason: "low-signal" });
    }

    read += 1;
    if (read % 200 === 0)
      options.onProgress?.(`reading files`, read, candidates.length);
    kept.push(record);
  }

  options.onProgress?.("ranking files by importance");
  for (const record of kept) {
    const { score, reasons } = scoreFile(record);
    record.importance = score;
    record.reasons = reasons;
  }

  // Rank: importance first, then size (bigger files carry more context), then path.
  kept.sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    if (b.size !== a.size) return b.size - a.size;
    return a.path.localeCompare(b.path);
  });

  const included = kept.filter((file) => !file.dropped);
  const totals: ScanTotals = {
    discovered: walked.length,
    included: included.length,
    bytes: kept.reduce((sum, file) => sum + file.size, 0),
    includedBytes: included.reduce((sum, file) => sum + file.size, 0),
    lines: included.reduce((sum, file) => sum + file.lines, 0),
  };

  const languages: LanguageStat[] = groupByLanguage(included).map((bucket) => ({
    language: bucket.language,
    name: bucket.name,
    files: bucket.files,
    bytes: bucket.bytes,
    lines: bucket.lines,
  }));

  const stack = detectStack(kept);

  return {
    root: config.root,
    files: kept,
    ignored: capIgnored(ignored),
    totals,
    languages,
    stack,
  };
}

/** Where the output directory sits relative to the root, for ignore purposes. */
function relativeOutputDir(config: PackConfig): string {
  const rel = path.relative(config.root, config.outputDir);
  return rel && !rel.startsWith("..") ? rel.split(path.sep)[0]! : "";
}

/** Coarse file classification. */
export function classify(relativePath: string, languageId: string): FileKind {
  const base = path.basename(relativePath).toLowerCase();
  const posix = relativePath.toLowerCase();

  if (MANIFEST_NAMES.has(base)) return "config";
  if (README_RE.test(base)) return "doc";
  if (TEST_RE.test(posix)) return "test";
  if (STYLE_RE.test(base)) return "style";
  if (DOC_RE.test(base)) return "doc";
  if (CONFIG_RE.test(base)) return "config";
  if (languageId === "markdown") return "doc";
  if (
    languageId === "css" ||
    languageId === "scss" ||
    languageId === "sass" ||
    languageId === "less"
  )
    return "style";
  if (
    languageId === "json" ||
    languageId === "yaml" ||
    languageId === "toml" ||
    languageId === "ini" ||
    languageId === "gitignore"
  )
    return "config";
  if (languageId === "text") return "other";
  if (languageId === "html" || languageId === "xml") return "source";
  return "source";
}

/** Score a single file. Returns the score and the reasons behind it. */
export function scoreFile(file: FileRecord): {
  score: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  const posix = file.path.toLowerCase();
  const base = path.basename(posix);
  const depth = posix.split("/").length - 1;
  let score = 30;

  if (ENTRY_POINT_NAMES.has(base) || ENTRY_POINT_NAMES.has(posix)) {
    score += 26;
    reasons.push("entry point");
  }
  if (MANIFEST_NAMES.has(base)) {
    score += 22;
    reasons.push("manifest / config");
  }
  if (README_RE.test(base)) {
    score += depth === 0 ? 22 : 10;
    reasons.push(depth === 0 ? "root readme" : "documentation");
  }
  if (TEST_RE.test(posix)) {
    score -= 14;
    reasons.push("test file");
  }
  if (file.kind === "style") {
    score -= 6;
    reasons.push("styles");
  }
  if (file.kind === "config" && !MANIFEST_NAMES.has(base)) {
    score += 4;
    reasons.push("configuration");
  }
  if (file.kind === "source") {
    score += 6;
    reasons.push("source code");
  }

  // Shallow files are structure; deep files are usually leaves.
  if (depth <= 1 && file.kind === "source") {
    score += 8;
    reasons.push("near the root");
  }
  if (depth >= 5) {
    score -= 4;
    reasons.push("deeply nested");
  }

  // Size nudges: a 5-line helper is less informative than a 300-line module.
  if (file.kind === "source") {
    if (file.size < 400) score -= 6;
    else if (file.size > 20_000) score += 5;
    else if (file.size > 3_000) score += 3;
  }
  if (file.size > 200_000) {
    score -= 12;
    reasons.push("very large");
  }

  // Test fixtures and mocks are noise more often than signal.
  if (/(^|\/)(__mocks__|__snapshots__|fixtures?)\//.test(posix)) {
    score -= 16;
    reasons.push("fixture / mock");
  }
  // Docker/CI/k8s carry operational context.
  if (
    /(^|\/)(\.github|\.gitlab|\.circleci)\//.test(posix) ||
    (/(dockerfile|docker-compose|\.ya?ml$)/.test(base) &&
      /(^|\/)(k8s|deploy|helm|charts?)\//.test(posix))
  ) {
    score += 6;
    reasons.push("CI / deployment");
  }

  return { score: Math.max(1, Math.min(100, score)), reasons };
}

/**
 * Detect the technologies in use, with the evidence for each.
 *
 * Detection reads only what the scanner already collected, so it stays honest:
 * a stack entry always points at a real file or dependency.
 */
export function detectStack(files: readonly FileRecord[]): StackInfo[] {
  const found = new Map<string, StackInfo>();
  const add = (id: string, label: string, evidence: string): void => {
    if (!found.has(id)) found.set(id, { id, label, evidence });
  };

  for (const file of files) {
    const base = path.basename(file.path).toLowerCase();
    const posix = file.path.toLowerCase();

    if (base === "package.json" && file.content) {
      try {
        const pkg = JSON.parse(file.content) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          scripts?: Record<string, string>;
        };
        const deps = {
          ...(pkg.dependencies ?? {}),
          ...(pkg.devDependencies ?? {}),
        };
        const dep = (name: string): boolean =>
          Object.prototype.hasOwnProperty.call(deps, name);

        if (dep("typescript"))
          add("typescript", "TypeScript", "typescript in package.json");
        if (dep("react")) add("react", "React", "react in package.json");
        if (dep("next")) add("nextjs", "Next.js", "next in package.json");
        if (dep("vue")) add("vue", "Vue", "vue in package.json");
        if (dep("nuxt")) add("nuxt", "Nuxt", "nuxt in package.json");
        if (dep("svelte")) add("svelte", "Svelte", "svelte in package.json");
        if (dep("@angular/core"))
          add("angular", "Angular", "@angular/core in package.json");
        if (dep("astro")) add("astro", "Astro", "astro in package.json");
        if (dep("vite")) add("vite", "Vite", "vite in package.json");
        if (dep("webpack"))
          add("webpack", "Webpack", "webpack in package.json");
        if (dep("tailwindcss"))
          add("tailwind", "Tailwind CSS", "tailwindcss in package.json");
        if (dep("redux") || dep("@reduxjs/toolkit"))
          add("redux", "Redux", "redux in package.json");
        if (dep("zustand"))
          add("zustand", "Zustand", "zustand in package.json");
        if (dep("@tanstack/react-query"))
          add("react-query", "TanStack Query", "react-query in package.json");
        if (dep("react-router") || dep("react-router-dom"))
          add("react-router", "React Router", "react-router in package.json");
        if (dep("express"))
          add("express", "Express", "express in package.json");
        if (dep("fastify"))
          add("fastify", "Fastify", "fastify in package.json");
        if (dep("@nestjs/core"))
          add("nestjs", "NestJS", "@nestjs/core in package.json");
        if (dep("jest")) add("jest", "Jest", "jest in package.json");
        if (dep("vitest")) add("vitest", "Vitest", "vitest in package.json");
        if (dep("playwright") || dep("@playwright/test"))
          add("playwright", "Playwright", "playwright in package.json");
        if (dep("cypress"))
          add("cypress", "Cypress", "cypress in package.json");
        if (dep("prisma") || dep("@prisma/client"))
          add("prisma", "Prisma", "prisma in package.json");
        if (dep("graphql"))
          add("graphql", "GraphQL", "graphql in package.json");
        if (dep("axios")) add("axios", "Axios", "axios in package.json");
        if (dep("zod")) add("zod", "Zod", "zod in package.json");
        if (dep("leaflet") || dep("mapbox-gl"))
          add("maps", "Mapping", "map library in package.json");
        if (dep("three")) add("three", "Three.js", "three in package.json");
        if (dep("electron"))
          add("electron", "Electron", "electron in package.json");
        if (dep("react-native"))
          add("react-native", "React Native", "react-native in package.json");
        if (dep("expo")) add("expo", "Expo", "expo in package.json");
        if (
          dep("@digikala") ||
          Object.keys(deps).some((name) => name.startsWith("@digikala/"))
        ) {
          add("digikala", "Digikala packages", "@digikala/* in package.json");
        }
        const scripts = pkg.scripts ?? {};
        if (Object.keys(scripts).length > 0)
          add(
            "npm-scripts",
            "npm scripts",
            `scripts: ${Object.keys(scripts).slice(0, 6).join(", ")}`,
          );
        add("node", "Node.js", "package.json present");
      } catch {
        add("node", "Node.js", "package.json present (unparseable)");
      }
    }

    if (
      base === "pyproject.toml" ||
      base === "requirements.txt" ||
      base === "setup.py"
    )
      add("python", "Python", file.path);
    if (base === "cargo.toml") add("rust", "Rust", file.path);
    if (base === "go.mod") add("go", "Go", file.path);
    if (
      base === "pom.xml" ||
      base === "build.gradle" ||
      base === "build.gradle.kts"
    )
      add("jvm", "JVM (Java/Kotlin)", file.path);
    if (base === "gemfile") add("ruby", "Ruby", file.path);
    if (base === "composer.json") add("php", "PHP", file.path);
    if (base === "pubspec.yaml") add("dart", "Dart / Flutter", file.path);
    if (
      base === "dockerfile" ||
      base === "docker-compose.yml" ||
      base === "docker-compose.yaml" ||
      base === "compose.yml"
    ) {
      add("docker", "Docker", file.path);
    }
    if (posix.startsWith(".github/workflows/"))
      add("github-actions", "GitHub Actions", file.path);
    if (base.endsWith(".tf")) add("terraform", "Terraform", file.path);
    if (file.language === "tsx" || file.language === "jsx")
      add("react", "React", `${file.path} (${file.language})`);
    if (file.language === "typescript")
      add("typescript", "TypeScript", `${file.path} (.ts)`);
  }

  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Cap the ignored list so a runaway `.gitignore` cannot bloat the report. */
function capIgnored(entries: IgnoredEntry[], limit = 300): IgnoredEntry[] {
  if (entries.length <= limit) return entries;
  return entries.slice(0, limit);
}

/** True when `target` is a directory that exists — small helper for the CLI. */
export async function assertProjectRoot(root: string): Promise<void> {
  if (!(await isDirectory(root))) {
    throw new Error(`not a directory: ${root}`);
  }
}
