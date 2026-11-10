/**
 * Small ANSI + layout toolkit used by the CLI.
 *
 * Deliberately dependency-free so the packer runs in a bare Node environment
 * (CI, docker, a colleague's laptop) with zero install time. Set `NO_COLOR=1`
 * or pass `--no-color` to turn styling off.
 *
 * @module utils/style
 */

const NO_COLOR_ENV = process.env.NO_COLOR != null && process.env.NO_COLOR !== '';

let colorEnabled = !NO_COLOR_ENV;

/** Enable or disable ANSI colors for the rest of the process. */
export function setColorEnabled(value: boolean): void {
  colorEnabled = Boolean(value) && !NO_COLOR_ENV;
}

/** True when styled output is being emitted. */
export function isColorEnabled(): boolean {
  return colorEnabled;
}

export type Paint = (text: string | number) => string;

function wrap(open: number, close: number): Paint {
  return (text) => (colorEnabled ? `\u001b[${open}m${text}\u001b[${close}m` : String(text));
}

/** Pre-built ANSI painters. */
export const color: Record<
  'bold' | 'dim' | 'italic' | 'underline' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'gray',
  Paint
> = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

/** Visual width of a string, counting wide (CJK/emoji) glyphs as two cells. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) continue;
    if (
      code >= 0x1100 &&
      (code <= 0x115f ||
        code === 0x2329 ||
        code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x1f300 && code <= 0x1faff))
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/** Pad `text` on the right to `width` display cells. */
export function padEnd(text: string, width: number): string {
  const diff = width - displayWidth(text);
  return diff > 0 ? text + ' '.repeat(diff) : text;
}

/** Pad `text` on the left to `width` display cells. */
export function padStart(text: string, width: number): string {
  const diff = width - displayWidth(text);
  return diff > 0 ? ' '.repeat(diff) + text : text;
}

/** Truncate `text` to `width` cells, appending an ellipsis when cut. */
export function truncate(text: string, width: number, ellipsis = '\u2026'): string {
  const value = String(text);
  if (displayWidth(value) <= width) return value;
  let out = '';
  for (const char of value) {
    if (displayWidth(out + char) > width - displayWidth(ellipsis)) break;
    out += char;
  }
  return out + ellipsis;
}

/** Human-readable byte size, e.g. `1.4 MB`. */
export function formatBytes(bytes: number, fractionDigits = 1): string {
  const n = Number(bytes) || 0;
  if (n < 1000) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = n / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(fractionDigits)} ${units[unit]}`;
}

/** Compact number, e.g. `12.3k`. */
export function formatCount(value: number): string {
  const n = Number(value) || 0;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Compact duration, e.g. `1.24s` or `2m03s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/** Icon set shared by status lines. */
export const ICONS = {
  info: '\u203a',
  success: '\u2714',
  warn: '!',
  error: '\u2716',
  step: '\u203a',
  bullet: '\u2022',
  arrow: '\u2192',
} as const;

export type StatusLevel = keyof Pick<typeof ICONS, 'info' | 'success' | 'warn' | 'error' | 'step'>;

/** Print a titled section rule, e.g. `── Scanning ────────`. */
export function banner(title: string, width = 62): string {
  const label = ` ${title} `;
  const rest = Math.max(0, width - displayWidth(label) - 2);
  return color.gray('\u2500'.repeat(2)) + color.bold(label) + color.gray('\u2500'.repeat(rest));
}

/** A single styled status line. */
export function statusLine(level: StatusLevel, message: string): string {
  const palette: Record<StatusLevel, Paint> = {
    info: color.cyan,
    success: color.green,
    warn: color.yellow,
    error: color.red,
    step: color.magenta,
  };
  const paint = palette[level] ?? color.cyan;
  return `${paint(ICONS[level] ?? '\u203a')} ${message}`;
}

/** Render a `key: value` table with aligned columns. */
export function table(rows: ReadonlyArray<readonly [string, string]>, options: { indent?: number } = {}): string {
  const indent = options.indent ?? 2;
  const entries: Array<[string, string]> = rows.map((row) => [String(row[0]), String(row[1])]);
  const keyWidth = entries.reduce((max, [key]) => Math.max(max, displayWidth(key)), 0);
  const prefix = ' '.repeat(indent);
  return entries.map(([key, value]) => `${prefix}${color.dim(padEnd(key, keyWidth))}  ${value}`).join('\n');
}

/** Render a horizontal bar chart row (used in run summaries). */
export function bar(value: number, max: number, width = 24, fill = '\u2588', empty = '\u00b7'): string {
  const safeMax = max > 0 ? max : 1;
  const filled = Math.max(0, Math.min(width, Math.round((value / safeMax) * width)));
  return color.cyan(fill.repeat(filled)) + color.gray(empty.repeat(width - filled));
}

/** Named icons, re-exported for callers that only need glyphs. */
export const sym = ICONS;
