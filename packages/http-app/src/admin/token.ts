// SPDX-License-Identifier: Apache-2.0
// Bootstrap admin token (P2-09, ADR-0009 Phase 2): one high-entropy secret (`RB_ADMIN_TOKEN`) that authorises the
// admin API until identity-provider sessions arrive (P4-01/P4-02). Only its SHA-256 digest is kept in memory; a
// presented token is hashed and compared in constant time, so neither length nor content leaks through timing.
import { timingSafeEqual } from '@relic-bridge/auth';
import type { Secret } from '@relic-bridge/core';

export const MIN_ADMIN_TOKEN_CHARS: number = 32;
export const MAX_ADMIN_TOKEN_CHARS: number = 512;
/** Printable ASCII without spaces: what fits in an `Authorization: Bearer` header unchanged. */
const ADMIN_TOKEN_RE = /^[\x21-\x7e]+$/;
const BEARER_RE = /^[ \t]*bearer[ \t]+([\x21-\x7e]+)[ \t]*$/i;

export type AdminTokenProblem =
  | 'too_short'
  | 'too_long'
  | 'invalid_characters'
  | 'low_entropy'
  | 'placeholder';

/** Fewer distinct characters than this is refused: 32 random base64 characters have ~25, 32 random hex ~13. */
export const MIN_ADMIN_TOKEN_DISTINCT_CHARS: number = 8;
/** A token whose estimated entropy is below this boots, with a warning that it does not look generated. */
export const ADMIN_TOKEN_WARN_BITS: number = 100;

/** Values copied from examples instead of generated. Long enough never to occur in a random token by chance. */
const PLACEHOLDER_RE =
  /change[-_.]?me|replace[-_.]?me|placeholder|example|your[-_.]?(?:admin[-_.]?)?token|insert[-_.]?token|password|secret[-_.]?token|admin[-_.]?token|not[-_.]?a[-_.]?secret|do[-_.]?not[-_.]?use/i;
/** Words a person types when inventing a token; only a warning, so short words are fine. */
const HUMAN_WORD_RE = /admin|token|secret|passw|relic|bridge|qwerty|letmein|test/i;

const distinctCount = (value: string): number => new Set(value).size;

/** Smallest `p` with `value[i] === value[i - p]` for every `i >= p` (the string repeats a block of length `p`). */
function period(value: string): number {
  for (let p = 1; p < value.length; p++) {
    let repeats = true;
    for (let i = p; i < value.length && repeats; i++) repeats = value[i] === value[i - p];
    if (repeats) return p;
  }
  return value.length;
}

/** Share of neighbours that repeat or step by one (`aa`, `ab`, `ba`, `12`). Random base64: ~5 %, hex: ~19 %. */
function stepShare(value: string): number {
  let steps = 0;
  for (let i = 1; i < value.length; i++) {
    if (Math.abs(value.charCodeAt(i) - value.charCodeAt(i - 1)) <= 1) steps++;
  }
  return steps / Math.max(1, value.length - 1);
}

/** Empirical (Shannon) entropy of the characters as used, in bits for the whole value; an optimistic estimate. */
function estimatedBits(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bitsPerChar = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bitsPerChar -= p * Math.log2(p);
  }
  return bitsPerChar * value.length;
}

/**
 * Why a configured admin token is unusable, or `null` when it is fine. Beyond length and characters it refuses
 * values that are guessable without trying many: fewer than 8 distinct characters (`'a'.repeat(32)`), a repeated
 * block (`'abc123'.repeat(6)`), mostly runs or steps (`abcdefgh…`, `11112222…`) and copied placeholders
 * (`changeme…`). These are refusals because the admin API is reachable from the internet on Workers (T14).
 */
export function checkAdminToken(value: string): AdminTokenProblem | null {
  if (value.length < MIN_ADMIN_TOKEN_CHARS) return 'too_short';
  if (value.length > MAX_ADMIN_TOKEN_CHARS) return 'too_long';
  if (!ADMIN_TOKEN_RE.test(value)) return 'invalid_characters';
  if (distinctCount(value) < MIN_ADMIN_TOKEN_DISTINCT_CHARS) return 'low_entropy';
  if (period(value) * 2 <= value.length) return 'low_entropy';
  if (stepShare(value) > 0.6) return 'low_entropy';
  if (PLACEHOLDER_RE.test(value)) return 'placeholder';
  return null;
}

/**
 * For a token `checkAdminToken` accepts: `true` when it does not look generated (estimated entropy under
 * `ADMIN_TOKEN_WARN_BITS`, one character class only, no digit, many runs or steps, or a common word). Boot then logs
 * a warning; the token still works. Generated tokens (`openssl rand -base64 32`, `admin-token generate`, `cf:setup`)
 * pass.
 */
export function adminTokenLooksWeak(value: string): boolean {
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(value)).length;
  return (
    estimatedBits(value) < ADMIN_TOKEN_WARN_BITS ||
    classes < 2 ||
    !/[0-9]/.test(value) ||
    stepShare(value) > 0.4 ||
    HUMAN_WORD_RE.test(value)
  );
}

/** A sentence for the problem, for boot errors. Never includes the token. */
export function describeAdminTokenProblem(problem: AdminTokenProblem): string {
  switch (problem) {
    case 'too_short':
      return `too short (under ${MIN_ADMIN_TOKEN_CHARS} characters)`;
    case 'too_long':
      return `too long (over ${MAX_ADMIN_TOKEN_CHARS} characters)`;
    case 'invalid_characters':
      return 'not made of printable ASCII characters without spaces';
    case 'low_entropy':
      return (
        `too predictable (fewer than ${MIN_ADMIN_TOKEN_DISTINCT_CHARS} distinct characters, a repeated block, ` +
        'or mostly runs and sequences)'
      );
    case 'placeholder':
      return 'a placeholder copied from an example (such as "changeme" or "your-admin-token")';
  }
}

/** Shown with every refusal: how to get a good token. */
export const ADMIN_TOKEN_ADVICE: string =
  'Generate one: `openssl rand -base64 32` or `relic-bridge admin-token generate`.';

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** The bearer value of an `Authorization` header, or `null` (missing, other scheme, oversized). */
export function adminBearer(header: string | null | undefined): string | null {
  if (typeof header !== 'string' || header.length > MAX_ADMIN_TOKEN_CHARS + 32) return null;
  return BEARER_RE.exec(header)?.[1] ?? null;
}

export interface AdminTokenVerifier {
  /** Whether `presented` is the admin token. Never throws. */
  verify(presented: string): Promise<boolean>;
}

/** Throws `TypeError` for an unusable token (boot refuses to start). The plaintext is not retained. */
export function createAdminTokenVerifier(token: Secret): AdminTokenVerifier {
  const value = token.reveal();
  const problem = checkAdminToken(value);
  if (problem !== null) {
    throw new TypeError(
      `admin token is ${describeAdminTokenProblem(problem)}: use ${MIN_ADMIN_TOKEN_CHARS}-${MAX_ADMIN_TOKEN_CHARS} random printable characters without spaces. ${ADMIN_TOKEN_ADVICE}`,
    );
  }
  const expected = sha256(value);
  return {
    async verify(presented) {
      if (presented.length > MAX_ADMIN_TOKEN_CHARS) return false;
      try {
        return timingSafeEqual(await sha256(presented), await expected);
      } catch {
        return false;
      }
    },
  };
}
