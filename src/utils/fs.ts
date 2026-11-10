/**
 * Filesystem helpers: recursive walk, binary sniffing, safe writes.
 *
 * The walker is asynchronous and collects metadata first, reading contents
 * lazily, so a huge repository does not blow memory when the caller only wants
 * a summary.
 *
 * @module utils/fs
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Directories that never carry signal for an AI and are skipped by default. */
export const DEFAULT_IGNORE_DIRS: readonly string[] = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '.nyc_output',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
  'target',
  '.idea',
  '.terraform',
  'tmp',
  'temp',
];

/** File extensions treated as binary without reading the content. */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.tiff',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.ogg', '.flac', '.webm',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.class', '.jar', '.wasm', '.node',
  '.sqlite', '.db', '.pyc', '.pyo', '.lockb',
]);

/** Extensions whose content has low signal and should be summarised away. */
export const LOW_SIGNAL_EXTENSIONS: ReadonlySet<string> = new Set([
  '.min.js', '.min.css', '.map', '.snap', '.lock',
]);

/** Dotfiles that carry real configuration and are read even without `--hidden`. */
export const NOTEWORTHY_DOTFILES: ReadonlySet<string> = new Set([
  '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc',
  '.env.example', '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.cjs',
  '.prettierrc', '.prettierrc.json', '.prettierrc.js', '.babelrc',
  '.browserslistrc', '.dockerignore', '.stylelintrc',
]);

const MAX_SNIFF_BYTES = 8192;

/** A file discovered by the walker. */
export interface WalkEntry {
  /** Absolute path. */
  absolutePath: string;
  /** POSIX path relative to the walk root. */
  relativePath: string;
  /** Size in bytes. */
  size: number;
  /** Lowercase extension including the dot (may be empty). */
  ext: string;
  /** Last modified time in epoch milliseconds. */
  mtimeMs: number;
  /** Set when the walker already decided to skip the file. */
  skipped?: 'too-large';
}

export interface WalkOptions {
  /** Directory names to skip. Defaults to {@link DEFAULT_IGNORE_DIRS}. */
  ignoreDirs?: readonly string[];
  /** Extra ignore patterns in gitignore syntax. */
  extraIgnore?: readonly string[];
  /** Ignore matcher already built from `.gitignore` and user patterns. */
  matcher?: { matches: (relativePath: string, isDir?: boolean) => boolean };
  /** Files larger than this are reported with `skipped: 'too-large'`. */
  maxFileSize?: number;
  /** Include dotfiles and dot-directories other than the noteworthy set. */
  includeHidden?: boolean;
  /** Follow symbolic links (off by default to avoid cycles). */
  followSymlinks?: boolean;
  /** Abort the walk early. */
  signal?: AbortSignal;
}

/** Recursively list files under `rootDir`, applying ignore rules. */
export async function walk(rootDir: string, options: WalkOptions = {}): Promise<WalkEntry[]> {
  const {
    ignoreDirs = DEFAULT_IGNORE_DIRS,
    extraIgnore = [],
    matcher,
    maxFileSize = 2 * 1024 * 1024,
    includeHidden = false,
    followSymlinks = false,
    signal,
  } = options;

  const ignoreDirSet = new Set<string>([...ignoreDirs, ...extraIgnore].filter(Boolean) as string[]);
  const results: WalkEntry[] = [];
  const visited = new Set<string>();

  async function visit(dir: string): Promise<void> {
    if (signal?.aborted) throw new Error('walk aborted');
    let realPath: string;
    try {
      realPath = await fsp.realpath(dir);
    } catch {
      return;
    }
    if (visited.has(realPath)) return;
    visited.add(realPath);

    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = toPosix(path.relative(rootDir, full));

      if (!includeHidden && entry.name.startsWith('.')) {
        const allowedFile = !entry.isDirectory() && NOTEWORTHY_DOTFILES.has(entry.name);
        if (!allowedFile) continue;
      }
      if (matcher && matcher.matches(rel, entry.isDirectory())) continue;

      if (entry.isDirectory()) {
        if (ignoreDirSet.has(entry.name)) continue;
        await visit(full);
        continue;
      }

      if (entry.isSymbolicLink()) {
        if (!followSymlinks) continue;
        try {
          const stat = await fsp.stat(full);
          if (stat.isDirectory()) {
            await visit(full);
            continue;
          }
        } catch {
          continue;
        }
      }

      if (!entry.isFile()) continue;

      let stat: fs.Stats;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }

      const base: WalkEntry = {
        absolutePath: full,
        relativePath: rel,
        size: stat.size,
        ext: extOf(entry.name),
        mtimeMs: stat.mtimeMs,
      };
      if (stat.size > maxFileSize) base.skipped = 'too-large';
      results.push(base);
    }
  }

  await visit(rootDir);
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

/** Convert an OS path to POSIX separators. */
export function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

/** Lowercase extension including the dot; handles compound and dotfile names. */
export function extOf(filename: string): string {
  const base = path.basename(filename).toLowerCase();
  const compound = ['.min.js', '.min.css', '.d.ts', '.test.ts', '.spec.ts', '.test.tsx', '.spec.tsx'];
  for (const ext of compound) if (base.endsWith(ext)) return ext;
  const ext = path.extname(base);
  if (ext) return ext;
  if (base.startsWith('.')) return base;
  return '';
}

/**
 * Whether a file is likely binary. Uses the extension first, then sniffs the
 * first 8 KiB for NUL bytes and a high ratio of non-printable characters.
 */
export async function isBinary(filePath: string, meta: { ext?: string; size?: number } = {}): Promise<boolean> {
  const ext = meta.ext ?? extOf(filePath);
  if (BINARY_EXTENSIONS.has(ext)) return true;
  if (meta.size === 0) return false;

  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(filePath, 'r');
    const buffer = Buffer.alloc(MAX_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_SNIFF_BYTES, 0);
    return sniffBinary(buffer.subarray(0, bytesRead));
  } catch {
    return true;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Pure byte-level binary test — exported for testing. */
export function sniffBinary(buffer: Uint8Array): boolean {
  if (!buffer || buffer.length === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i]!;
    if (byte === 0) return true;
    const printable = byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126) || byte >= 128;
    if (!printable) suspicious += 1;
  }
  return suspicious / buffer.length > 0.3;
}

/** Read a UTF-8 text file, normalising BOM and CRLF. */
export async function readTextFile(filePath: string): Promise<string> {
  return normalizeText(await fsp.readFile(filePath, 'utf8'));
}

/** Strip BOM, normalise newlines and collapse runs of blank lines. */
export function normalizeText(text: string): string {
  return String(text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

/** Count lines in a file body. */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lines += 1;
  return lines;
}

/** Ensure a directory exists (recursive). */
export async function ensureDir(dir: string): Promise<string> {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** Write a text file, creating parents first. */
export async function writeFileSafe(filePath: string, content: string | Uint8Array): Promise<string> {
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, content);
  return filePath;
}

/** Check whether a path exists (any type). */
export async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/** True for a directory. */
export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fsp.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** True for a file. */
export async function isFile(target: string): Promise<boolean> {
  try {
    return (await fsp.stat(target)).isFile();
  } catch {
    return false;
  }
}

/** Read a JSON file, returning `fallback` on any error. */
export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Sync existence check, for fast CLI bootstrapping. */
export function existsSync(target: string): boolean {
  return fs.existsSync(target);
}

export { fsp, fs, path };
