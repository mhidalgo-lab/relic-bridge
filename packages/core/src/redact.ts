// SPDX-License-Identifier: Apache-2.0
// Central secret redaction (THREAT_MODEL T8). Every log line, error message and audit record passes through here.

export const REDACTED = '[REDACTED]';

// Every pattern below must do work linear in the input (no unbounded scan that can restart at each position): text
// from New Relic data and NRQL reaches redact() and must not be able to stall it. Name prefixes and URL schemes are
// bounded, and token shapes that may repeat inside one run of characters start only at the run's beginning.

/** Value patterns: each match is replaced; the replacer keeps a short, non-secret prefix for debugging. */
const VALUE_PATTERNS: ReadonlyArray<[RegExp, (match: string, ...groups: string[]) => string]> = [
  // New Relic keys: User (NRAK), admin (NRAA), ingest/insights/browser/mobile (NRII, NRIK, NRIQ, NRJS, NRBR, NRSP).
  [/\b(NRAK|NRAA|NRII|NRIK|NRIQ|NRJS|NRBR|NRSP)-[A-Za-z0-9_-]{8,}/g, (_m, prefix) => `${prefix}-${REDACTED}`],
  // New Relic license key: 36 hex chars + "NRAL".
  [/\b[a-fA-F0-9]{36}NRAL\b/g, () => `${REDACTED}NRAL`],
  // relic-bridge access tokens (P2-05 format: rb_<env>_<random>[_<checksum>]).
  [/\brb_[A-Za-z0-9_]{16,}/g, () => `rb_${REDACTED}`],
  // Bearer credentials in headers or messages.
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_m, scheme) => `${scheme} ${REDACTED}`],
  // Authorization headers with any scheme (Basic, Token, Digest…): the scheme stays, the credential goes.
  [
    /\b((?:proxy-)?authorization"?\s*[:=]\s*"?)([A-Za-z][A-Za-z0-9-]*\s+)?([^\s",;}]+)/gi,
    (_m, name, scheme = '') => `${name}${scheme}${REDACTED}`,
  ],
  // key/value assignments: API-Key: x, apiKey=x, RB_MASTER_KEY=x, NEW_RELIC_API_KEY=x, DB_PASSWORD=x,
  // client_secret=x, access_token=x, aws_secret_access_key=x. A name prefix (`DB_`, `client_`, `x-`) is allowed; only
  // its last 40 characters are matched (bounded work), and a longer name still has its value redacted.
  [
    /([A-Za-z0-9_.-]{0,40}?(?:api[_-]?key|(?:master|license|ingest|access)[_-]?key|passw(?:or)?d|secret|token|credentials?|private[_-]?key))("?\s*[:=]\s*"?)([^\s",;}&]+)/gi,
    (_m, name, sep) => `${name}${sep}${REDACTED}`,
  ],
];

/** Secret shapes that show up in free text (log lines, error messages, URLs) beyond the value patterns above. */
const FREE_TEXT_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // JSON web tokens; also one cut short at the end of the text (header and the start of the payload).
  [
    /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.(?:[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*|[A-Za-z0-9_-]*$)/g,
    '[REDACTED_JWT]',
  ],
  // AWS access key ids; GitHub, Slack, Stripe and OpenAI-style tokens.
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED_TOKEN]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED_TOKEN]'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, '[REDACTED_TOKEN]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_TOKEN]'],
  // Credentials in URLs: scheme://user:password@host.
  [/([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@'],
  // PEM private key bodies.
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[REDACTED_PRIVATE_KEY]',
  ],
];

/** Object keys whose values are always redacted, whatever they contain. */
const SECRET_KEY_RE =
  /^(api[-_]?key|authorization|token|access[-_]?token|refresh[-_]?token|id[-_]?token|password|secret|client[-_]?secret|master[-_]?key|cookie|set-cookie)$/i;

export function isSecretKeyName(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/** Redact secrets inside a string. Idempotent. */
export function redact(input: string): string {
  let out = input;
  for (const [re, replace] of VALUE_PATTERNS) out = out.replace(re, replace as (m: string) => string);
  for (const [re, replacement] of FREE_TEXT_PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Characters redacted past a caller's cap (see redactHead), so a secret that crosses the cap is still recognised. */
export const REDACT_CUT_MARGIN = 1024;

export interface RedactedHead {
  /** Redacted text: all of the input, or its start when `cut`. May be longer than the cap; the caller cuts it. */
  readonly text: string;
  /** True when the input was longer than the cap plus REDACT_CUT_MARGIN and only its start was redacted. */
  readonly cut: boolean;
}

/**
 * Redact only the part of `input` a caller keeps (its first `max` characters), so the work is bounded by the cap and
 * not by the input. Redaction runs on the first `max` + REDACT_CUT_MARGIN characters: a secret that crosses the cap is
 * matched with its tail. The end of that window can split a secret too, and a shrinking redaction (a long value
 * replaced by REDACTED) can pull the window's end below the cap, so the untouched characters at the end of the window
 * (up to the margin) are dropped: what is returned is either redacted or came from before the window's last margin.
 */
export function redactHead(input: string, max: number): RedactedHead {
  const window = Math.max(0, max) + REDACT_CUT_MARGIN;
  if (input.length <= window) return { text: redact(input), cut: false };
  const head = input.slice(0, window);
  const out = redact(head);
  const limit = Math.min(REDACT_CUT_MARGIN, out.length);
  let same = 0;
  while (same < limit && out.charCodeAt(out.length - 1 - same) === head.charCodeAt(head.length - 1 - same))
    same++;
  return { text: out.slice(0, out.length - same), cut: true };
}

const MAX_DEPTH = 8;

/**
 * Deep-redact any value for logging: strings are scrubbed, secret-named keys are blanked, `Secret` instances and
 * anything with a custom `toJSON` that returns REDACTED stay redacted. Cycles and excessive depth are cut.
 */
export function redactValue(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message) };
  }
  const maybeJson = (value as { toJSON?: () => unknown }).toJSON;
  if (typeof maybeJson === 'function' && !(value instanceof Date)) {
    return redactValue(maybeJson.call(value), depth + 1, seen);
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSecretKeyName(k) ? REDACTED : redactValue(v, depth + 1, seen);
  }
  return out;
}
