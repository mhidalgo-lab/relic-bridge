// SPDX-License-Identifier: Apache-2.0
// Central secret redaction (THREAT_MODEL T8). Every log line, error message and audit record passes through here.

export const REDACTED = '[REDACTED]';

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
  // client_secret=x, access_token=x, aws_secret_access_key=x. A name prefix (`DB_`, `client_`, `x-`) is allowed.
  [
    /\b([A-Za-z0-9_.-]*?(?:api[_-]?key|(?:master|license|ingest|access)[_-]?key|passw(?:or)?d|secret|token|credentials?|private[_-]?key))("?\s*[:=]\s*"?)([^\s",;}&]+)/gi,
    (_m, name, sep) => `${name}${sep}${REDACTED}`,
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
  return out;
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
