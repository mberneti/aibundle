/**
 * Language detection and per-language metadata.
 *
 * The table is intentionally broad: the packer is a *generic* tool that must at
 * least not mangle an unknown stack. TypeScript and React get first-class
 * treatment (correct `.tsx`/`.jsx` fences, JSX-aware compression), everything
 * else falls back to a safe plaintext spec.
 *
 * @module core/languages
 */

import path from 'node:path';
import { extOf } from '../utils/fs.js';
import type { LanguageSpec } from '../types.js';

/** Every language the detector knows, richest support first. */
export const LANGUAGES: readonly LanguageSpec[] = [
  { id: 'tsx', name: 'TypeScript React', extensions: ['.tsx', '.mtsx'], comment: '//', block: ['/*', '*/'] },
  { id: 'typescript', name: 'TypeScript', extensions: ['.ts', '.mts', '.cts'], comment: '//', block: ['/*', '*/'] },
  { id: 'jsx', name: 'JavaScript React', extensions: ['.jsx', '.mjsx'], comment: '//', block: ['/*', '*/'] },
  { id: 'javascript', name: 'JavaScript', extensions: ['.js', '.mjs', '.cjs'], comment: '//', block: ['/*', '*/'] },
  { id: 'python', name: 'Python', extensions: ['.py', '.pyi', '.pyw'], comment: '#', filenames: ['pipfile'] },
  { id: 'rust', name: 'Rust', extensions: ['.rs'], comment: '//', block: ['/*', '*/'] },
  { id: 'go', name: 'Go', extensions: ['.go'], comment: '//', block: ['/*', '*/'] },
  { id: 'java', name: 'Java', extensions: ['.java'], comment: '//', block: ['/*', '*/'] },
  { id: 'kotlin', name: 'Kotlin', extensions: ['.kt', '.kts'], comment: '//', block: ['/*', '*/'] },
  { id: 'swift', name: 'Swift', extensions: ['.swift'], comment: '//', block: ['/*', '*/'] },
  { id: 'ruby', name: 'Ruby', extensions: ['.rb', '.rake'], comment: '#', filenames: ['gemfile', 'rakefile'] },
  { id: 'php', name: 'PHP', extensions: ['.php', '.phtml'], comment: '//', block: ['/*', '*/'] },
  { id: 'csharp', name: 'C#', extensions: ['.cs'], comment: '//', block: ['/*', '*/'] },
  { id: 'cpp', name: 'C++', extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'], comment: '//', block: ['/*', '*/'] },
  { id: 'c', name: 'C', extensions: ['.c', '.h'], comment: '//', block: ['/*', '*/'] },
  { id: 'scala', name: 'Scala', extensions: ['.scala', '.sc'], comment: '//', block: ['/*', '*/'] },
  { id: 'dart', name: 'Dart', extensions: ['.dart'], comment: '//', block: ['/*', '*/'] },
  { id: 'elixir', name: 'Elixir', extensions: ['.ex', '.exs'], comment: '#', filenames: ['mix.exs'] },
  { id: 'erlang', name: 'Erlang', extensions: ['.erl', '.hrl'], comment: '%' },
  { id: 'clojure', name: 'Clojure', extensions: ['.clj', '.cljs', '.cljc', '.edn'], comment: ';' },
  { id: 'lua', name: 'Lua', extensions: ['.lua'], comment: '--' },
  { id: 'r', name: 'R', extensions: ['.r'], comment: '#' },
  { id: 'julia', name: 'Julia', extensions: ['.jl'], comment: '#' },
  { id: 'zig', name: 'Zig', extensions: ['.zig'], comment: '//' },
  { id: 'nim', name: 'Nim', extensions: ['.nim'], comment: '#' },
  { id: 'haskell', name: 'Haskell', extensions: ['.hs', '.lhs'], comment: '--', block: ['{-', '-}'] },
  { id: 'elm', name: 'Elm', extensions: ['.elm'], comment: '--', block: ['{-', '-}'] },
  { id: 'ocaml', name: 'OCaml', extensions: ['.ml', '.mli'], block: ['(*', '*)'] },
  { id: 'solidity', name: 'Solidity', extensions: ['.sol'], comment: '//', block: ['/*', '*/'] },
  { id: 'vue', name: 'Vue SFC', extensions: ['.vue'], comment: '//', block: ['/*', '*/'] },
  { id: 'svelte', name: 'Svelte', extensions: ['.svelte'], comment: '//', block: ['/*', '*/'] },
  { id: 'astro', name: 'Astro', extensions: ['.astro'], comment: '//', block: ['/*', '*/'] },
  { id: 'html', name: 'HTML', extensions: ['.html', '.htm', '.xhtml'], block: ['<!--', '-->'] },
  { id: 'css', name: 'CSS', extensions: ['.css', '.pcss'], block: ['/*', '*/'] },
  { id: 'scss', name: 'SCSS', extensions: ['.scss'], comment: '//', block: ['/*', '*/'] },
  { id: 'sass', name: 'Sass', extensions: ['.sass'], comment: '//' },
  { id: 'less', name: 'Less', extensions: ['.less'], comment: '//', block: ['/*', '*/'] },
  { id: 'stylus', name: 'Stylus', extensions: ['.styl'], comment: '//', block: ['/*', '*/'] },
  { id: 'json', name: 'JSON', extensions: ['.json', '.jsonc', '.json5'], comment: '//' },
  { id: 'yaml', name: 'YAML', extensions: ['.yaml', '.yml'], comment: '#' },
  { id: 'toml', name: 'TOML', extensions: ['.toml'], comment: '#' },
  { id: 'ini', name: 'INI', extensions: ['.ini', '.cfg', '.conf', '.properties', '.env'], comment: '#' },
  { id: 'xml', name: 'XML / SVG', extensions: ['.xml', '.svg', '.plist', '.csproj', '.xaml'], block: ['<!--', '-->'] },
  { id: 'markdown', name: 'Markdown', extensions: ['.md', '.mdx', '.markdown'], block: ['<!--', '-->'] },
  { id: 'sql', name: 'SQL', extensions: ['.sql'], comment: '--', block: ['/*', '*/'] },
  { id: 'graphql', name: 'GraphQL', extensions: ['.graphql', '.gql'], comment: '#' },
  { id: 'protobuf', name: 'Protocol Buffers', extensions: ['.proto'], comment: '//' },
  { id: 'thrift', name: 'Thrift', extensions: ['.thrift'], comment: '//', block: ['/*', '*/'] },
  { id: 'shell', name: 'Shell', extensions: ['.sh', '.bash', '.zsh', '.fish', '.ksh'], comment: '#', filenames: ['bashrc', 'zshrc'] },
  { id: 'powershell', name: 'PowerShell', extensions: ['.ps1', '.psm1'], comment: '#', block: ['<#', '#>'] },
  { id: 'batch', name: 'Batch', extensions: ['.bat', '.cmd'], comment: 'rem' },
  { id: 'dockerfile', name: 'Dockerfile', extensions: ['.dockerfile'], comment: '#', filenames: ['dockerfile', 'containerfile'] },
  { id: 'makefile', name: 'Makefile', extensions: ['.mk', '.mak'], comment: '#', filenames: ['makefile', 'gnumakefile'] },
  { id: 'terraform', name: 'Terraform', extensions: ['.tf', '.tfvars', '.hcl'], comment: '#', block: ['/*', '*/'] },
  { id: 'nginx', name: 'Nginx config', extensions: ['.nginx'], comment: '#' },
  { id: 'gitignore', name: 'Ignore rules', extensions: ['.gitignore', '.dockerignore', '.npmignore', '.eslintignore'], comment: '#' },
  { id: 'text', name: 'Plain text', extensions: ['.txt', '.log', '.text'] },
];

const BY_EXTENSION = new Map<string, LanguageSpec>();
const BY_FILENAME = new Map<string, LanguageSpec>();
for (const spec of LANGUAGES) {
  for (const ext of spec.extensions) if (!BY_EXTENSION.has(ext)) BY_EXTENSION.set(ext, spec);
  for (const filename of spec.filenames ?? []) BY_FILENAME.set(filename, spec);
}

const PLAINTEXT: LanguageSpec = { id: 'text', name: 'Plain text', extensions: [] };

/**
 * Detect the language of a file from its path, with an optional shebang sniff.
 *
 * @param filePath path or filename (either works)
 * @param options `content` enables shebang detection for extension-less files
 */
export function detectLanguage(filePath: string, options: { content?: string } = {}): LanguageSpec {
  const base = path.basename(filePath).toLowerCase();

  const byName = BY_FILENAME.get(base);
  if (byName) return byName;

  // `.d.ts` files are TypeScript even though `extOf` collapses to `.d.ts`.
  if (base.endsWith('.d.ts') || base.endsWith('.d.mts') || base.endsWith('.d.cts')) {
    return BY_EXTENSION.get('.ts')!;
  }

  const ext = extOf(base);
  const byExt = ext ? BY_EXTENSION.get(ext) : undefined;
  if (byExt) return byExt;

  if (options.content) {
    const shebang = options.content.slice(0, 160).split('\n')[0] ?? '';
    if (shebang.startsWith('#!')) {
      if (/node|deno|bun/.test(shebang)) return BY_EXTENSION.get('.js')!;
      if (/python/.test(shebang)) return BY_EXTENSION.get('.py')!;
      if (/(ba|z|fi)?sh/.test(shebang)) return BY_EXTENSION.get('.sh')!;
      if (/ruby/.test(shebang)) return BY_EXTENSION.get('.rb')!;
      if (/perl/.test(shebang)) return PLAINTEXT;
    }
  }

  return PLAINTEXT;
}

/**
 * Fence language hint for Markdown code blocks.
 *
 * React files use `tsx`/`jsx` because that is what GitHub and most chat UIs
 * highlight correctly; TypeScript uses the short `ts` alias.
 */
export const FENCE_HINTS: Readonly<Record<string, string>> = {
  typescript: 'ts',
  tsx: 'tsx',
  javascript: 'js',
  jsx: 'jsx',
  python: 'python',
  shell: 'bash',
  powershell: 'powershell',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gitignore: 'gitignore',
  text: 'text',
  protobuf: 'protobuf',
  graphql: 'graphql',
};

/** Fence hint for a language id; falls back to the id itself. */
export function fenceHint(languageId: string): string {
  return FENCE_HINTS[languageId] ?? languageId;
}

/** Language stats, sorted by bytes descending. */
export interface LanguageBucket {
  language: string;
  name: string;
  files: number;
  bytes: number;
  lines: number;
}

/** Group files by language id. */
export function groupByLanguage(
  files: ReadonlyArray<{ language: string; size: number; lines: number }>,
): LanguageBucket[] {
  const stats = new Map<string, LanguageBucket>();
  for (const file of files) {
    const id = file.language || 'text';
    const entry = stats.get(id) ?? { language: id, name: '', files: 0, bytes: 0, lines: 0 };
    entry.files += 1;
    entry.bytes += file.size ?? 0;
    entry.lines += file.lines ?? 0;
    stats.set(id, entry);
  }
  const specs = new Map(LANGUAGES.map((spec) => [spec.id, spec]));
  return [...stats.values()]
    .map((entry) => ({ ...entry, name: specs.get(entry.language)?.name ?? entry.language }))
    .sort((a, b) => b.bytes - a.bytes);
}

/** Look up a spec by id (for compressor hints). */
export function languageById(id: string): LanguageSpec | undefined {
  return LANGUAGES.find((spec) => spec.id === id);
}
