/**
 * Secret redaction.
 *
 * The packer exists to move code *out* of the machine and into a chat, so the
 * last thing it must do is leak a live credential. Two layers:
 *
 * 1. **Patterns** — well-known token shapes (`sk-…`, `ghp_…`, `xox…`, `AIza…`,
 *    AWS keys, JWTs, private-key blocks, connection strings with a password).
 *    These match on shape alone, so a token is caught even without a
 *    suggestive variable name.
 * 2. **Assignments** — `API_KEY = "…"`, `password: '…'`, `.env` style lines.
 *    The value is replaced while keeping the key and the quoting style so the
 *    file still reads correctly.
 *
 * Everything is replaced with `«redacted:<kind>»`, which is a marker the reader
 * (human or model) can see. The original is never kept.
 *
 * @module core/redactor
 */

/** One redaction rule. */
export interface RedactionRule {
  id: string;
  /** Matched against the whole file body. */
  pattern: RegExp;
  /** `full` replaces the whole match, `group` replaces capture group 1. */
  replace: 'full' | 'group';
}

/** Shape-based rules — order matters, most specific first. */
export const SECRET_PATTERNS: readonly RedactionRule[] = [
  { id: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: 'full' },
  { id: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replace: 'full' },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replace: 'full' },
  { id: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, replace: 'full' },
  { id: 'github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: 'full' },
  { id: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: 'full' },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: 'full' },
  { id: 'aws-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: 'full' },
  { id: 'aws-secret', pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/g, replace: 'group' },
  { id: 'stripe-key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, replace: 'full' },
  { id: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g, replace: 'full' },
  { id: 'discord-token', pattern: /\b[MNO][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g, replace: 'full' },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: 'full' },
  { id: 'basic-auth-url', pattern: /\b[a-z][a-z0-9+.-]*:\/\/([^\s:@/]+:[^\s:@/]+)@/gi, replace: 'group' },
  { id: 'bearer', pattern: /\bBearer\s+([A-Za-z0-9._-]{20,})/g, replace: 'group' },
  { id: 'connection-password', pattern: /(?:Password|password|pwd)\s*=\s*([^;'"\s]{6,})/g, replace: 'group' },
];

/** Keys that suggest the neighbouring value is a secret. */
const SENSITIVE_KEY_RE =
  /(?:api[_-]?key|apikey|secret|token|passwd|password|passphrase|credential|private[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret|refresh[_-]?token|session[_-]?secret|encryption[_-]?key|signing[_-]?key)/i;

/**
 * Assignment rule: `KEY = value`, `"key": "value"`.
 *
 * The key must look sensitive (`SENSITIVE_KEY_RE`). Placeholder values such as
 * `process.env.X`, `changeme`, `your-key-here` or an empty string are skipped so
 * the output stays honest.
 */
const ASSIGNMENT_RE =
  /([A-Za-z_][A-Za-z0-9_.-]*)(\s*(?::|=>|=)\s*)(['"`])([^'"`\n]{1,400})\3/g;

const PLACEHOLDER_RE =
  /^(?:process\.env|import\.meta\.env|env)(?:\.[A-Za-z0-9_[\]]+)*$|^<.*>$|^\$\{?[A-Za-z0-9_]+\}?$|^\*{3,}$|^x{3,}$|^\.{3,}$|^your[_-]|^my[_-]|^change[_-]?me$|^placeholder$|^example$|^redacted$|^\u00abredacted[^\u00bb]*\u00bb$|^todo$|^none$|^null$|^true$|^false$|^$/i;

export interface RedactResult {
  text: string;
  count: number;
  /** Rule ids that fired, for the report. */
  kinds: string[];
}

/**
 * Redact secrets from a file body.
 *
 * @param text the raw file content
 * @param rules rules to apply (defaults to {@link SECRET_PATTERNS})
 */
export function redactSecrets(text: string, rules: readonly RedactionRule[] = SECRET_PATTERNS): RedactResult {
  let out = String(text ?? '');
  let count = 0;
  const kinds = new Set<string>();

  for (const rule of rules) {
    out = out.replace(new RegExp(rule.pattern.source, rule.pattern.flags), (...args: unknown[]) => {
      const match = args[0] as string;
      if (rule.replace === 'full') {
        count += 1;
        kinds.add(rule.id);
        return `\u00abredacted:${rule.id}\u00bb`;
      }
      // Group replacement: keep everything around capture group 1.
      const groups = (args[1] as string | undefined) ?? '';
      const index = match.indexOf(groups);
      if (index < 0) return match;
      if (isPlaceholder(groups)) return match;
      count += 1;
      kinds.add(rule.id);
      const before = match.slice(0, index);
      const after = match.slice(index + groups.length);
      const tail = after.length >= 2 ? after[after.length - 1] : '';
      const quote = /['"`]/.test(tail) ? tail : '';
      const rest = quote ? after.slice(0, -1) : after;
      return `${before}\u00abredacted:${rule.id}\u00bb${quote}${rest}`;
    });
  }

  out = out.replace(ASSIGNMENT_RE, (match, key: string, separator: string, quote: string, value: string) => {
    if (!SENSITIVE_KEY_RE.test(key)) return match;
    if (isPlaceholder(value)) return match;
    count += 1;
    kinds.add('assignment');
    return `${key}${separator}${quote}\u00abredacted\u00bb${quote}`;
  });

  return { text: out, count, kinds: [...kinds].sort() };
}

/** Whether a value looks like a placeholder rather than a real secret. */
export function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  if (PLACEHOLDER_RE.test(trimmed)) return true;
  // Values with no entropy at all (`aaaa`, `1234`) are placeholders too.
  return new Set(trimmed).size <= 2 && trimmed.length <= 8;
}
