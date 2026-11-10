/**
 * Token estimation.
 *
 * There is no bundled BPE vocabulary (that would mean shipping a multi-megabyte
 * blob and a runtime dependency). Instead we use a calibrated heuristic that is
 * accurate enough to answer the only questions that matter here: *does this
 * bundle fit in the model's context window*, and *roughly what will it cost*.
 *
 * Calibration: modern tokenizers average ~4.0 characters per token on prose and
 * ~3.2 on code; CJK and emoji run closer to 1.0–1.5. We split the input into
 * ASCII and wide characters, estimate each with its own rate, then add a
 * correction for the structural characters (braces, newlines, punctuation) that
 * tokenizers almost always isolate into their own token.
 *
 * The estimate is monotonic and stable, which is what the budget logic needs.
 *
 * @module utils/tokenizer
 */

/** Model identifiers we expose pricing and context windows for. */
export type ModelId =
  | 'gpt-4o'
  | 'gpt-4o-mini'
  | 'gpt-4.1'
  | 'o3'
  | 'claude-3-5-sonnet'
  | 'claude-3-7-sonnet'
  | 'gemini-1.5-pro'
  | 'gemini-2.0-flash'
  | 'default';

export interface TokenEstimateOptions {
  /** Multiplier applied to the raw estimate, e.g. 1.1 for a safety margin. */
  bias?: number;
}

const RATES = {
  /** characters per token for ASCII prose */
  prose: 4.0,
  /** characters per token for ASCII code */
  code: 3.2,
  /** characters per token for CJK/emoji */
  wide: 1.4,
} as const;

const WORDISH_RE = /[A-Za-z0-9_$]+/g;
const STRUCTURAL_RE = /[\n\r{}()<>[\];:,=|&!?]/g;

/** True for characters outside the Latin/ASCII range we treat as "wide". */
function isWide(code: number): boolean {
  return code >= 0x2e80;
}

/**
 * Estimate the number of tokens `text` costs.
 *
 * @param text the raw text
 * @param options `bias` multiplies the result (default 1.05 safety margin)
 */
export function estimateTokens(text: string, options: TokenEstimateOptions = {}): number {
  const value = String(text ?? '');
  if (value.length === 0) return 0;

  const bias = options.bias ?? 1.05;

  let ascii = 0;
  let wide = 0;
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (isWide(code)) wide += 1;
    else ascii += 1;
  }

  // Identifier-like runs tokenize worse than prose (camelCase, snake_case).
  const wordChars = (value.match(WORDISH_RE) ?? []).reduce((sum, word) => sum + word.length, 0);
  const codeShare = ascii > 0 ? Math.min(1, wordChars / ascii) : 0;
  const asciiRate = RATES.code + (1 - codeShare) * (RATES.prose - RATES.code);

  const asciiTokens = ascii > 0 ? ascii / asciiRate : 0;
  const wideTokens = wide > 0 ? wide / RATES.wide : 0;
  const structural = countStructuralTokens(value);

  const raw = asciiTokens + wideTokens + structural;
  return Math.max(1, Math.ceil(raw * bias));
}

/**
 * Punctuation and whitespace boundaries that always become their own token in
 * practice (newlines, indentation stops, brackets).
 */
function countStructuralTokens(value: string): number {
  const matches = value.match(STRUCTURAL_RE);
  return matches ? matches.length * 0.32 : 0;
}

/** Token estimate for one chunk. */
export interface TokenChunk {
  path: string;
  content: string;
}

/** Estimates for many chunks at once, plus a total. */
export interface TokenMapResult {
  total: number;
  perFile: Map<string, number>;
}

/** Estimate tokens for many chunks at once, returning per-chunk and total counts. */
export function estimateTokenMap(chunks: readonly TokenChunk[], options: TokenEstimateOptions = {}): TokenMapResult {
  const perFile = new Map<string, number>();
  let total = 0;
  for (const chunk of chunks) {
    const tokens = estimateTokens(chunk.content, options);
    perFile.set(chunk.path, tokens);
    total += tokens;
  }
  return { total, perFile };
}

/** Pricing table (USD per 1M input tokens) for the cost line in the report. */
export const PRICING: Record<ModelId, number> = {
  'gpt-4o': 2.5,
  'gpt-4o-mini': 0.15,
  'gpt-4.1': 2.0,
  o3: 2.0,
  'claude-3-5-sonnet': 3.0,
  'claude-3-7-sonnet': 3.0,
  'gemini-1.5-pro': 1.25,
  'gemini-2.0-flash': 0.1,
  default: 2.5,
};

/** Rough USD cost of `tokens` input tokens on `model`. */
export function estimateCost(tokens: number, model: ModelId = 'default'): number {
  const price = PRICING[model] ?? PRICING.default;
  return (tokens / 1_000_000) * price;
}

/** How well a bundle fits known context windows. */
export interface ContextFit {
  model: string;
  window: number;
  fits: boolean;
  fillPercent: number;
}

/** Fit of `tokens` against the context windows we report on. */
export function contextFit(tokens: number): ContextFit[] {
  const windows: ReadonlyArray<readonly [string, number]> = [
    ['GPT-4o class', 128_000],
    ['Claude 3.5 Sonnet', 200_000],
    ['Gemini 1.5 Pro', 1_000_000],
  ];
  return windows.map(([model, window]) => ({
    model,
    window,
    fits: tokens <= window,
    fillPercent: Math.min(100, (tokens / window) * 100),
  }));
}
