/**
 * Analyzers.
 *
 * Each analyzer is a small, pure function over the scan that produces a typed
 * value plus a renderer for it. Registering a new one is a single
 * {@link registerAnalyzer} call — see `docs/EXTENDING.md`.
 *
 * The registry returns {@link AnalyzerSection} objects with `render` already
 * bound to the produced value, which is what lets the Markdown/XML/plain
 * renderers iterate sections without knowing any analyzer's concrete type.
 *
 * @module analyzers
 */

import path from 'node:path';

import type { Analyzer, AnalyzerSection, PackConfig, RenderContext, ScanResult, FileRecord } from '../types.js';
import { color, formatBytes, formatCount, padEnd, truncate } from '../utils/style.js';

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

const registry: Analyzer<unknown>[] = [];

/**
 * Register an analyzer.
 *
 * A `registry.register` call inside {@link registerAnalyzer} monomorphises the
 * generic away via the wrapping arrow function, so the array stays
 * `Analyzer<unknown>[]` without casts at the call site.
 */
export function registerAnalyzer<TValue>(analyzer: Analyzer<TValue>): void {
  registry.push(analyzer as unknown as Analyzer<unknown>);
}

/** All registered analyzers, in registration order. */
export function listAnalyzers(): ReadonlyArray<Analyzer<unknown>> {
  return registry;
}

/**
 * Run every enabled analyzer.
 *
 * @param scan the scan result
 * @param config resolved configuration
 */
export function runAnalyzers(scan: ScanResult, config: PackConfig): AnalyzerSection[] {
  const enabled = listAnalyzers().filter((analyzer) => {
    if (analyzer.id === 'tree') return config.includeTree;
    if (analyzer.id === 'summary') return config.includeSummary;
    return true;
  });

  return enabled.map((analyzer) => {
    const value = analyzer.run(scan, config);
    return {
      id: analyzer.id,
      title: analyzer.title,
      value,
      render(ctx: RenderContext): string {
        return analyzer.render(value, ctx);
      },
    };
  });
}

/* -------------------------------------------------------------------------- */
/* 1. Project summary                                                         */
/* -------------------------------------------------------------------------- */

/** The computed summary: a short, human-readable description of the project. */
export interface SummaryValue {
  root: string;
  totalFiles: number;
  includedFiles: number;
  bytes: number;
  lines: number;
  languages: Array<{ language: string; name: string; files: number; bytes: number; lines: number }>;
  stack: Array<{ id: string; label: string; evidence: string }>;
  kinds: Array<{ kind: string; files: number; bytes: number }>;
  topFiles: Array<{ path: string; importance: number; reasons: string[] }>;
  entryPoints: string[];
  manifests: string[];
  notes: string[];
}

/** Paths that look like the first file a reader should open. */
function findEntryPoints(files: readonly FileRecord[]): string[] {
  const preferred = ['src/main.tsx', 'src/main.ts', 'src/index.tsx', 'src/index.ts', 'src/app.tsx', 'src/App.tsx', 'app/page.tsx', 'main.py', 'cmd/main.go', 'src/lib.rs'];
  const found = new Set<string>();
  for (const candidate of preferred) {
    const hit = files.find((file) => file.path.toLowerCase() === candidate.toLowerCase());
    if (hit) found.add(hit.path);
  }
  if (found.size < 3) {
    for (const file of files) {
      if (found.size >= 5) break;
      if (/(^|\/)(index|main|app)\.(tsx?|jsx?|py|go|rs)$/.test(file.path) && !/test|spec/.test(file.path)) found.add(file.path);
    }
  }
  return [...found].slice(0, 5);
}

/** Manifests worth naming in the summary. */
function findManifests(files: readonly FileRecord[]): string[] {
  const names = ['package.json', 'tsconfig.json', 'pyproject.toml', 'requirements.txt', 'cargo.toml', 'go.mod', 'pom.xml', 'composer.json', 'gemfile', 'dockerfile', 'docker-compose.yml', 'makefile'];
  return files.filter((file) => names.includes(path.basename(file.path).toLowerCase())).map((file) => file.path).slice(0, 8);
}

const summaryAnalyzer: Analyzer<SummaryValue> = {
  id: 'summary',
  title: 'Project summary',
  run(scan, config) {
    const included = scan.files.filter((file) => !file.dropped);
    const kinds = new Map<string, { kind: string; files: number; bytes: number }>();
    for (const file of included) {
      const entry = kinds.get(file.kind) ?? { kind: file.kind, files: 0, bytes: 0 };
      entry.files += 1;
      entry.bytes += file.size;
      kinds.set(file.kind, entry);
    }

    const notes: string[] = [];
    const tests = included.filter((file) => file.kind === 'test').length;
    const sources = included.filter((file) => file.kind === 'source').length;
    if (sources > 0 && tests === 0) notes.push('no test files were found — the bundle is source-only');
    if (scan.ignored.filter((entry) => entry.reason === 'too-large').length > 0) {
      notes.push(`${scan.ignored.filter((entry) => entry.reason === 'too-large').length} file(s) exceeded the size cap and were listed but not inlined`);
    }
    if (!included.some((file) => /readme/i.test(path.basename(file.path)))) notes.push('no README was found in the project root');
    if (config.compression === 'none') notes.push('compression is off — the bundle holds the files verbatim');

    return {
      root: path.basename(scan.root),
      totalFiles: scan.totals.discovered,
      includedFiles: scan.totals.included,
      bytes: scan.totals.includedBytes,
      lines: scan.totals.lines,
      languages: scan.languages,
      stack: scan.stack,
      kinds: [...kinds.values()].sort((a, b) => b.bytes - a.bytes),
      topFiles: included.slice(0, 12).map((file) => ({ path: file.path, importance: file.importance, reasons: file.reasons })),
      entryPoints: findEntryPoints(included),
      manifests: findManifests(included),
      notes,
    };
  },
  render(value, ctx) {
    const { config } = ctx;
    const lines: string[] = [];
    lines.push(`**Project:** \`${value.root}\``);
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('| --- | --- |');
    lines.push(`| Files discovered | ${value.totalFiles} |`);
    lines.push(`| Files included | ${value.includedFiles} |`);
    lines.push(`| Total included size | ${formatBytes(value.bytes)} |`);
    lines.push(`| Total lines | ${formatCount(value.lines)} |`);
    lines.push('');

    if (value.stack.length > 0) {
      lines.push('**Detected stack**');
      lines.push('');
      for (const entry of value.stack) lines.push(`- **${entry.label}** — ${entry.evidence}`);
      lines.push('');
    }

    if (value.languages.length > 0) {
      lines.push('**Languages**');
      lines.push('');
      lines.push('| Language | Files | Bytes | Lines |');
      lines.push('| --- | ---: | ---: | ---: |');
      for (const entry of value.languages.slice(0, 12)) {
        lines.push(`| ${entry.name} | ${entry.files} | ${formatBytes(entry.bytes)} | ${formatCount(entry.lines)} |`);
      }
      lines.push('');
    }

    if (value.kinds.length > 0) {
      lines.push('**File kinds**');
      lines.push('');
      lines.push(value.kinds.map((entry) => `${entry.kind}: ${entry.files}`).join(' \u00b7 '));
      lines.push('');
    }

    if (value.entryPoints.length > 0) {
      lines.push('**Likely entry points**');
      lines.push('');
      for (const entry of value.entryPoints) lines.push(`- \`${entry}\``);
      lines.push('');
    }

    if (value.manifests.length > 0) {
      lines.push('**Manifests & configuration**');
      lines.push('');
      for (const entry of value.manifests) lines.push(`- \`${entry}\``);
      lines.push('');
    }

    if (config.includeReport && value.topFiles.length > 0) {
      lines.push('**Highest-signal files** (by importance score)');
      lines.push('');
      lines.push('| File | Score | Why |');
      lines.push('| --- | ---: | --- |');
      for (const entry of value.topFiles) {
        lines.push(`| \`${entry.path}\` | ${entry.importance} | ${entry.reasons.join(', ') || 'baseline'} |`);
      }
      lines.push('');
    }

    if (value.notes.length > 0) {
      lines.push('**Notes**');
      lines.push('');
      for (const note of value.notes) lines.push(`- ${note}`);
      lines.push('');
    }

    return lines.join('\n').trimEnd();
  },
};

/* -------------------------------------------------------------------------- */
/* 2. Directory tree                                                          */
/* -------------------------------------------------------------------------- */

/** One directory in the rendered tree. */
interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  file?: FileRecord;
  isDir: boolean;
}

/** The tree plus its stats. */
export interface TreeValue {
  root: TreeNode;
  fileCount: number;
  dirCount: number;
}

function emptyNode(name: string, isDir: boolean): TreeNode {
  return { name, children: new Map(), isDir };
}

const treeAnalyzer: Analyzer<TreeValue> = {
  id: 'tree',
  title: 'Directory tree',
  run(scan) {
    const root = emptyNode(path.basename(scan.root), true);
    let fileCount = 0;
    const dirs = new Set<string>();

    for (const file of scan.files) {
      if (file.dropped) continue;
      const parts = file.path.split('/');
      let cursor = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const name = parts[i]!;
        dirs.add(parts.slice(0, i + 1).join('/'));
        if (!cursor.children.has(name)) cursor.children.set(name, emptyNode(name, true));
        cursor = cursor.children.get(name)!;
      }
      const leafName = parts[parts.length - 1]!;
      const leaf = emptyNode(leafName, false);
      leaf.file = file;
      cursor.children.set(leafName, leaf);
      fileCount += 1;
    }

    return { root, fileCount, dirCount: dirs.size };
  },
  render(value) {
    const lines: string[] = [];
    lines.push(`\`\`\`text`);
    lines.push(`${value.root.name}/`);
    renderChildren(value.root, '', lines, 0);
    lines.push('```');
    return lines.join('\n');
  },
};

function renderChildren(node: TreeNode, prefix: string, lines: string[], depth: number): void {
  const children = [...node.children.values()].sort(compareNodes);
  children.forEach((child, index) => {
    const last = index === children.length - 1;
    const connector = last ? '\u2514\u2500\u2500 ' : '\u251c\u2500\u2500 ';
    const suffix = child.isDir ? '/' : child.file ? `  (${formatBytes(child.file.size)})` : '';
    lines.push(`${prefix}${connector}${child.name}${suffix}`);
    if (child.isDir && depth < 6) {
      renderChildren(child, prefix + (last ? '    ' : '\u2502   '), lines, depth + 1);
    } else if (child.isDir) {
      lines.push(`${prefix}${last ? '    ' : '\u2502   '}\u2514\u2500\u2500 ${child.children.size} entries (not expanded)`);
    }
  });
}

function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/* -------------------------------------------------------------------------- */
/* 3. Dependency graph                                                        */
/* -------------------------------------------------------------------------- */

/** What the dependency analyzer found. */
export interface DepsValue {
  /** Local (relative) import edges, deduplicated. */
  edges: Array<{ from: string; to: string }>;
  /** External packages and how many files import them. */
  external: Array<{ name: string; importers: number; files: string[] }>;
  /** Files nothing imports (module roots / entry points). */
  roots: string[];
  /** Files that import the most. */
  hubs: Array<{ path: string; imports: number }>;
  /** Imports that resolve to nothing inside the project. */
  unresolved: Array<{ from: string; specifier: string }>;
}

const IMPORT_RES: ReadonlyArray<{ regex: RegExp; group: number }> = [
  { regex: /\bimport\s+(?:type\s+)?(?:[\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g, group: 1 },
  { regex: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, group: 1 },
  { regex: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, group: 1 },
  { regex: /^\s*import\s+['"]([^'"]+)['"]/gm, group: 1 },
  { regex: /^\s*from\s+([.\w]+)\s+import\b/gm, group: 1 },
  { regex: /\bexport\s+(?:type\s+)?(?:[\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g, group: 1 },
];

/** Extract every module specifier in a file body. */
export function extractImports(content: string): string[] {
  const found = new Set<string>();
  for (const { regex } of IMPORT_RES) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const specifier = match[1];
      if (specifier && !specifier.includes('\n')) found.add(specifier);
    }
  }
  return [...found];
}

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.vue', '.svelte', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

/** Resolve a relative specifier against the set of known files. */
export function resolveSpecifier(fromPath: string, specifier: string, known: ReadonlySet<string>): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
  const baseDir = path.posix.dirname(fromPath);
  const joined = path.posix.normalize(path.posix.join(baseDir, specifier));
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = joined + suffix;
    if (known.has(candidate)) return candidate;
  }
  return null;
}

const depsAnalyzer: Analyzer<DepsValue> = {
  id: 'deps',
  title: 'Dependency graph',
  run(scan) {
    const included = scan.files.filter((file) => !file.dropped && file.content !== undefined);
    const known = new Set(included.map((file) => file.path));
    const edges: Array<{ from: string; to: string }> = [];
    const externalMap = new Map<string, { name: string; importers: number; files: string[] }>();
    const unresolved: Array<{ from: string; specifier: string }> = [];
    const importedBy = new Map<string, number>();
    const importsOf = new Map<string, number>();
    const seenEdge = new Set<string>();

    for (const file of included) {
      if (!/\.(tsx?|jsx?|mjs|cjs|vue|svelte|py|go|rs)$/.test(file.path)) continue;
      const specifiers = extractImports(file.content ?? '');
      importsOf.set(file.path, specifiers.length);

      for (const specifier of specifiers) {
        if (specifier.startsWith('.') || specifier.startsWith('/')) {
          const resolved = resolveSpecifier(file.path, specifier, known);
          if (resolved) {
            const key = `${file.path}\u0000${resolved}`;
            if (!seenEdge.has(key)) {
              seenEdge.add(key);
              edges.push({ from: file.path, to: resolved });
              importedBy.set(resolved, (importedBy.get(resolved) ?? 0) + 1);
            }
          } else {
            unresolved.push({ from: file.path, specifier });
          }
          continue;
        }
        const packageName = toPackageName(specifier);
        if (!packageName) continue;
        const entry = externalMap.get(packageName) ?? { name: packageName, importers: 0, files: [] };
        entry.importers += 1;
        if (entry.files.length < 8) entry.files.push(file.path);
        externalMap.set(packageName, entry);
      }
    }

    return {
      edges: edges.slice(0, 2000),
      external: [...externalMap.values()].sort((a, b) => b.importers - a.importers).slice(0, 60),
      roots: included.filter((file) => /\.(tsx?|jsx?|mjs|cjs)$/.test(file.path) && !importedBy.has(file.path)).map((file) => file.path).slice(0, 40),
      hubs: [...importsOf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([file, count]) => ({ path: file, imports: count })),
      unresolved: dedupeUnresolved(unresolved).slice(0, 40),
    };
  },
  render(value) {
    const lines: string[] = [];
    if (value.external.length > 0) {
      lines.push('**External dependencies**');
      lines.push('');
      lines.push('| Package | Import sites |');
      lines.push('| --- | ---: |');
      for (const entry of value.external.slice(0, 25)) lines.push(`| \`${entry.name}\` | ${entry.importers} |`);
      lines.push('');
    }
    if (value.hubs.length > 0) {
      lines.push('**Most-importing files**');
      lines.push('');
      for (const entry of value.hubs.slice(0, 10)) lines.push(`- \`${entry.path}\` — ${entry.imports} imports`);
      lines.push('');
    }
    if (value.roots.length > 0) {
      lines.push('**Module roots** (nothing in the bundle imports these)');
      lines.push('');
      for (const entry of value.roots.slice(0, 12)) lines.push(`- \`${entry}\``);
      lines.push('');
    }
    if (value.edges.length > 0) {
      lines.push('**Internal import edges** (first 60)');
      lines.push('');
      lines.push('```text');
      for (const edge of value.edges.slice(0, 60)) lines.push(`${edge.from} \u2192 ${edge.to}`);
      if (value.edges.length > 60) lines.push(`\u2026 and ${value.edges.length - 60} more edges`);
      lines.push('```');
      lines.push('');
    }
    if (value.unresolved.length > 0) {
      lines.push('**Unresolved relative imports**');
      lines.push('');
      for (const entry of value.unresolved.slice(0, 10)) lines.push(`- \`${entry.specifier}\` from \`${entry.from}\``);
      lines.push('');
    }
    return lines.join('\n').trimEnd();
  },
};

function toPackageName(specifier: string): string | null {
  if (specifier.startsWith('node:') || specifier.startsWith('bun:') || specifier.startsWith('deno:')) return specifier;
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return null;
  if (specifier.length === 0 || specifier.length > 120) return null;
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] ?? null;
}

function dedupeUnresolved(entries: ReadonlyArray<{ from: string; specifier: string }>): Array<{ from: string; specifier: string }> {
  const seen = new Set<string>();
  const out: Array<{ from: string; specifier: string }> = [];
  for (const entry of entries) {
    const key = `${entry.from}\u0000${entry.specifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 4. API surface                                                             */
/* -------------------------------------------------------------------------- */

/** One exported symbol. */
export interface ApiEntry {
  file: string;
  kind: 'function' | 'class' | 'component' | 'const' | 'type' | 'interface' | 'enum' | 'export';
  name: string;
  signature?: string;
}

/** What the API analyzer found. */
export interface ApiValue {
  entries: ApiEntry[];
  counts: Record<string, number>;
  routeHints: Array<{ file: string; route: string; method?: string }>;
}

const EXPORT_PATTERNS: ReadonlyArray<{ kind: ApiEntry['kind']; regex: RegExp }> = [
  { kind: 'class', regex: /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'function', regex: /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(\([^)]*\))/gm },
  { kind: 'component', regex: /^\s*export\s+(?:default\s+)?(?:const|function)\s+([A-Z][\w$]*)\s*(?:=\s*\([^)]*\)|\([^)]*\))/gm },
  { kind: 'const', regex: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'interface', regex: /^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'type', regex: /^\s*export\s+type\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'enum', regex: /^\s*export\s+enum\s+([A-Za-z_$][\w$]*)/gm },
];

const ROUTE_RE = /(?:app|router)\.(get|post|put|patch|delete|use|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi;

const apiAnalyzer: Analyzer<ApiValue> = {
  id: 'api',
  title: 'API surface',
  run(scan) {
    const entries: ApiEntry[] = [];
    const routeHints: Array<{ file: string; route: string; method?: string }> = [];
    const counts: Record<string, number> = {};

    for (const file of scan.files) {
      if (file.dropped || !file.content) continue;
      if (!/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/.test(file.path)) continue;
      const body = file.content;

      for (const { kind, regex } of EXPORT_PATTERNS) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(body)) !== null) {
          const name = match[1]!;
          const signature = kind === 'function' ? `${name}${match[2] ?? '()'}` : name;
          entries.push({ file: file.path, kind, name, signature });
          counts[kind] = (counts[kind] ?? 0) + 1;
          if (entries.length > 900) break;
        }
      }

      ROUTE_RE.lastIndex = 0;
      let route: RegExpExecArray | null;
      while ((route = ROUTE_RE.exec(body)) !== null) {
        routeHints.push({ file: file.path, method: route[1]!.toUpperCase(), route: route[2]! });
      }
      if (routeHints.length > 120) break;
    }

    return { entries, counts, routeHints };
  },
  render(value) {
    const lines: string[] = [];
    if (Object.keys(value.counts).length > 0) {
      lines.push('**Export counts**');
      lines.push('');
      lines.push(Object.entries(value.counts).map(([kind, count]) => `${kind}: ${count}`).join(' \u00b7 '));
      lines.push('');
    }

    const byFile = new Map<string, ApiEntry[]>();
    for (const entry of value.entries) {
      const list = byFile.get(entry.file) ?? [];
      list.push(entry);
      byFile.set(entry.file, list);
    }

    if (byFile.size > 0) {
      lines.push('**Exports by file** (public surface only)');
      lines.push('');
      lines.push('| File | Kind | Symbol |');
      lines.push('| --- | --- | --- |');
      for (const [file, entries] of [...byFile.entries()].slice(0, 40)) {
        for (const entry of entries.slice(0, 12)) {
          lines.push(`| \`${file}\` | ${entry.kind} | \`${entry.signature ?? entry.name}\` |`);
        }
      }
      lines.push('');
    }

    if (value.routeHints.length > 0) {
      lines.push('**Route hints**');
      lines.push('');
      for (const hint of value.routeHints.slice(0, 30)) {
        lines.push(`- \`${hint.method ?? 'USE'} ${hint.route}\` — \`${hint.file}\``);
      }
      lines.push('');
    }

    return lines.join('\n').trimEnd();
  },
};

/* -------------------------------------------------------------------------- */
/* 5. TODOs and markers                                                       */
/* -------------------------------------------------------------------------- */

/** A marker found in the code. */
export interface TodoEntry {
  file: string;
  line: number;
  tag: string;
  text: string;
}

/** What the todo analyzer found. */
export interface TodoValue {
  entries: TodoEntry[];
  byTag: Record<string, number>;
}

const TODO_RE = /\b(TODO|FIXME|HACK|XXX|BUG|NOTE|OPTIMIZE|DEPRECATED|REVIEW)\b\s*[:\-]?\s*(.{0,120})/g;

const todosAnalyzer: Analyzer<TodoValue> = {
  id: 'todos',
  title: 'TODO/FIXME markers',
  run(scan) {
    const entries: TodoEntry[] = [];
    const byTag: Record<string, number> = {};

    for (const file of scan.files) {
      if (file.dropped || !file.content) continue;
      if (!/\.(tsx?|jsx?|mts|cts|mjs|cjs|py|go|rs|java|kt|rb|php|cs|c|cc|cpp|swift|sh)$/.test(file.path)) continue;
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        TODO_RE.lastIndex = 0;
        const line = lines[i]!;
        let match: RegExpExecArray | null;
        while ((match = TODO_RE.exec(line)) !== null) {
          const tag = match[1]!.toUpperCase();
          entries.push({ file: file.path, line: i + 1, tag, text: (match[2] ?? '').trim().replace(/\*\/\s*$/, '').trim() });
          byTag[tag] = (byTag[tag] ?? 0) + 1;
          if (entries.length > 500) break;
        }
        if (entries.length > 500) break;
      }
      if (entries.length > 500) break;
    }

    return { entries, byTag };
  },
  render(value) {
    if (value.entries.length === 0) return '_No TODO/FIXME markers were found._';
    const lines: string[] = [];
    lines.push(Object.entries(value.byTag).map(([tag, count]) => `${tag}: ${count}`).join(' \u00b7 '));
    lines.push('');
    for (const entry of value.entries.slice(0, 60)) {
      lines.push(`- **${entry.tag}** \`${entry.file}:${entry.line}\` — ${entry.text || '(no description)'}`);
    }
    if (value.entries.length > 60) lines.push(`- \u2026 and ${value.entries.length - 60} more`);
    return lines.join('\n');
  },
};

/* -------------------------------------------------------------------------- */
/* 6. File index                                                              */
/* -------------------------------------------------------------------------- */

/** What the index analyzer found. */
export interface IndexValue {
  files: Array<{
    path: string;
    kind: string;
    language: string;
    bytes: string;
    lines: number;
    tokens: number;
    importance: number;
    included: boolean;
  }>;
  dropped: Array<{ path: string; reason: string }>;
}

const indexAnalyzer: Analyzer<IndexValue> = {
  id: 'index',
  title: 'File index',
  run(scan) {
    const included = scan.files.filter((file) => !file.dropped);
    const dropped = scan.files.filter((file) => file.dropped);
    return {
      files: included.map((file) => ({
        path: file.path,
        kind: file.kind,
        language: file.languageName,
        bytes: formatBytes(file.includedSize ?? file.size),
        lines: file.lines,
        tokens: file.tokens ?? 0,
        importance: file.importance,
        included: true,
      })),
      dropped: dropped.map((file) => ({ path: file.path, reason: file.dropReason ?? 'unknown' })),
    };
  },
  render(value) {
    const lines: string[] = [];
    lines.push('| File | Kind | Language | Size | Lines | ~Tokens | Score |');
    lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: |');
    for (const file of value.files.slice(0, 400)) {
      lines.push(`| \`${file.path}\` | ${file.kind} | ${file.language} | ${file.bytes} | ${file.lines} | ${file.tokens} | ${file.importance} |`);
    }
    if (value.files.length > 400) lines.push(`| _\u2026 ${value.files.length - 400} more files_ | | | | | | |`);
    if (value.dropped.length > 0) {
      lines.push('');
      lines.push('**Excluded files**');
      lines.push('');
      for (const entry of value.dropped.slice(0, 40)) lines.push(`- \`${entry.path}\` — ${entry.reason}`);
      if (value.dropped.length > 40) lines.push(`- \u2026 and ${value.dropped.length - 40} more`);
    }
    return lines.join('\n');
  },
};

/* -------------------------------------------------------------------------- */
/* 7. CLI pretty printer (used by `--list-analyzers`)                         */
/* -------------------------------------------------------------------------- */

/** Render the analyzer registry for the terminal. */
export function describeAnalyzers(): string {
  const rows = listAnalyzers().map((analyzer) => `${padEnd(color.cyan(analyzer.id), 12)}${analyzer.title}`);
  return rows.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

registerAnalyzer(summaryAnalyzer);
registerAnalyzer(treeAnalyzer);
registerAnalyzer(depsAnalyzer);
registerAnalyzer(apiAnalyzer);
registerAnalyzer(todosAnalyzer);
registerAnalyzer(indexAnalyzer);

/** Exported for tests and for `plugins/` to reuse. */
export const analyzerNames = (): string[] => listAnalyzers().map((analyzer) => analyzer.id);

/** Truncate helper re-exported so analyzers stay dependency-free. */
export { truncate };
