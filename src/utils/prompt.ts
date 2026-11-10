/**
 * Zero-dependency interactive prompt toolkit.
 *
 * Small enough to keep `dependencies: {}`, complete enough to drive the wizard:
 * text, confirm, number, single-select and multi-select with arrow keys, a
 * non-TTY fallback for CI, and `Ctrl-C` handling that restores the cursor.
 *
 * All prompts resolve their value and never throw on user cancellation: they
 * throw {@link CancelledError} instead, which the CLI catches to exit cleanly.
 *
 * @module utils/prompt
 */

import readline from 'node:readline';
import { color, displayWidth, padEnd, truncate } from './style.js';

/** Thrown when the user presses Ctrl-C (or the stream closes) mid-prompt. */
export class CancelledError extends Error {
  constructor(message = 'cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

/** Thrown when a prompt cannot be shown (no TTY) — callers fall back to defaults. */
export class NotInteractiveError extends Error {
  constructor(message = 'stdin is not a TTY') {
    super(message);
    this.name = 'NotInteractiveError';
  }
}

export interface PromptStreams {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

function streams(options: PromptStreams): { input: NodeJS.ReadStream; output: NodeJS.WriteStream } {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  return { input, output };
}

/** True when interactive prompting is possible. */
export function isInteractive(options: PromptStreams = {}): boolean {
  const { input, output } = streams(options);
  return Boolean(input.isTTY && output.isTTY);
}

function createInterface(options: PromptStreams): readline.Interface {
  const { input, output } = streams(options);
  return readline.createInterface({ input, output, terminal: true });
}

/**
 * Ask for a line of text.
 *
 * @param question the prompt shown before the cursor
 * @param defaultValue returned (without prompting for input) on empty input
 */
export async function askText(
  question: string,
  defaultValue = '',
  options: PromptStreams & { validate?: (value: string) => string | null } = {},
): Promise<string> {
  if (!isInteractive(options)) {
    if (defaultValue !== '') return defaultValue;
    throw new NotInteractiveError();
  }
  const rl = createInterface(options);
  try {
    const suffix = defaultValue !== '' ? color.dim(` (${defaultValue})`) : '';
    return await new Promise<string>((resolve) => {
      rl.question(`${color.cyan('?')} ${question}${suffix} ${color.dim('\u203a')} `, (answer) => {
        resolve(answer.trim() === '' ? defaultValue : answer.trim());
      });
      rl.on('SIGINT', () => {
        rl.close();
        resolve(defaultValue);
      });
    });
  } finally {
    rl.close();
  }
}

/** Ask a yes/no question. Empty input returns `defaultValue`. */
export async function askConfirm(question: string, defaultValue = true, options: PromptStreams = {}): Promise<boolean> {
  if (!isInteractive(options)) return defaultValue;
  const hint = defaultValue ? 'Y/n' : 'y/N';
  const answer = await askText(`${question} ${color.dim(`[${hint}]`)}`, '', options);
  if (answer === '') return defaultValue;
  return /^(y|yes|1|true|\u0628\u0644\u0647)$/i.test(answer);
}

/** Ask for a number, re-asking until the answer parses. */
export async function askNumber(
  question: string,
  defaultValue: number,
  options: PromptStreams & { min?: number; max?: number } = {},
): Promise<number> {
  if (!isInteractive(options)) return defaultValue;
  for (;;) {
    const answer = await askText(question, String(defaultValue), options);
    const value = Number(answer);
    if (Number.isFinite(value)) {
      const min = options.min ?? Number.NEGATIVE_INFINITY;
      const max = options.max ?? Number.POSITIVE_INFINITY;
      if (value < min || value > max) continue;
      return value;
    }
  }
}

/** One choice in a select prompt. */
export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}

/** Render choice rows, highlighting `cursor`, optionally with check marks. */
function drawChoices<T>(
  choices: ReadonlyArray<Choice<T>>,
  cursor: number,
  checked?: ReadonlySet<number>,
): string[] {
  return choices.map((choice, index) => {
    const active = index === cursor;
    const marker = checked ? (checked.has(index) ? color.green('\u25c9') : color.dim('\u25cb')) : active ? color.cyan('\u203a') : ' ';
    const label = active ? color.bold(choice.label) : choice.label;
    const hint = choice.hint ? color.dim(`  ${choice.hint}`) : '';
    return `   ${marker} ${padEnd(label, 34)}${hint}`;
  });
}

/**
 * Arrow-key single select. Returns the chosen value.
 *
 * `multi` turns the same UI into a checkbox list and returns an array.
 */
export async function askSelect<T>(
  question: string,
  choices: ReadonlyArray<Choice<T>>,
  options: PromptStreams & { defaultIndex?: number; multi?: false },
): Promise<T>;
export async function askSelect<T>(
  question: string,
  choices: ReadonlyArray<Choice<T>>,
  options: PromptStreams & { defaultIndex?: number; multi: true; defaults?: readonly number[] },
): Promise<T[]>;
export async function askSelect<T>(
  question: string,
  choices: ReadonlyArray<Choice<T>>,
  options: PromptStreams & { defaultIndex?: number; multi?: boolean; defaults?: readonly number[] } = {},
): Promise<T | T[]> {
  const { output } = streams(options);
  if (!isInteractive(options)) {
    if (options.multi) {
      const indexes = options.defaults ?? [options.defaultIndex ?? 0];
      return indexes.map((index) => choices[index]!.value);
    }
    return choices[options.defaultIndex ?? 0]!.value;
  }

  const multi = Boolean(options.multi);
  const cursorStart = Math.min(Math.max(options.defaultIndex ?? 0, 0), choices.length - 1);
  const checked = new Set<number>(options.defaults ?? (multi ? [cursorStart] : []));
  let cursor = cursorStart;
  let drawn = 0;

  const render = (): void => {
    const body = drawChoices(choices, cursor, multi ? checked : undefined);
    const lines = [`${color.cyan('?')} ${question}`, ...body, color.dim(multi ? '   space to toggle \u00b7 enter to confirm' : '   arrows to move \u00b7 enter to select')];
    output.write(lines.join('\n') + '\n');
    drawn = lines.length;
  };
  const clear = (): void => {
    if (drawn === 0) return;
    readline.moveCursor(output, 0, -drawn);
    readline.clearScreenDown(output);
    drawn = 0;
  };

  const { input } = streams(options);
  const wasRaw = Boolean(input.isRaw);
  if (input.isTTY) input.setRawMode(true);
  readline.emitKeypressEvents(input, undefined);

  return new Promise<T | T[]>((resolve, reject) => {
    const finish = (value: T | T[]): void => {
      input.off('keypress', onKey);
      if (input.isTTY) input.setRawMode(wasRaw);
      clear();
      output.write(`${color.cyan('?')} ${question} ${color.dim('\u203a')} ${
        Array.isArray(value) ? value.map((v) => choices.find((c) => c.value === v)?.label ?? '').join(', ') : choices.find((c) => c.value === value)?.label ?? ''
      }\n`);
      resolve(value);
    };

    const onKey = (_str: string | undefined, key: readline.Key): void => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        input.off('keypress', onKey);
        if (input.isTTY) input.setRawMode(wasRaw);
        clear();
        reject(new CancelledError());
        return;
      }
      const redraw = (): void => {
        clear();
        render();
      };
      if (key.name === 'up') {
        cursor = (cursor - 1 + choices.length) % choices.length;
        redraw();
      } else if (key.name === 'down') {
        cursor = (cursor + 1) % choices.length;
        redraw();
      } else if (key.name === 'space' && multi) {
        if (checked.has(cursor)) checked.delete(cursor);
        else checked.add(cursor);
        redraw();
      } else if (key.name === 'a' && multi) {
        for (let i = 0; i < choices.length; i += 1) checked.add(i);
        redraw();
      } else if (key.name === 'return' || key.name === 'enter') {
        if (multi) {
          if (checked.size === 0) checked.add(cursor);
          finish([...checked].sort((a, b) => a - b).map((index) => choices[index]!.value));
        } else {
          finish(choices[cursor]!.value);
        }
      }
    };

    render();
    input.on('keypress', onKey);
  });
}

/** Ask for a free-text answer, tolerating empty input. */
export async function askOptional(question: string, options: PromptStreams = {}): Promise<string> {
  if (!isInteractive(options)) return '';
  return askText(question, '', options);
}

/** Print a plain line to the output stream. */
export function writeLine(text: string, options: PromptStreams = {}): void {
  streams(options).output.write(text + '\n');
}

/** Width of the terminal, with a sane fallback. */
export function terminalWidth(options: PromptStreams = {}): number {
  const { output } = streams(options);
  return output.columns && output.columns > 40 ? output.columns : 80;
}

/** A heading followed by a dim rule, for wizard sections. */
export function heading(title: string, options: PromptStreams = {}): string {
  const width = terminalWidth(options);
  const label = color.bold(` ${title} `);
  const fill = '\u2500'.repeat(Math.max(0, width - displayWidth(title) - 4));
  return `${color.dim('\u2500\u2500')}${label}${color.dim(fill)}`;
}

/** Truncate for narrow terminals, keeping ANSI-free text safe. */
export function fit(text: string, options: PromptStreams = {}): string {
  return truncate(text, terminalWidth(options) - 2);
}
