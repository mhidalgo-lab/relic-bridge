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

export type AdminTokenProblem = 'too_short' | 'too_long' | 'invalid_characters';

/** Why a configured admin token is unusable, or `null` when it is fine. */
export function checkAdminToken(value: string): AdminTokenProblem | null {
  if (value.length < MIN_ADMIN_TOKEN_CHARS) return 'too_short';
  if (value.length > MAX_ADMIN_TOKEN_CHARS) return 'too_long';
  if (!ADMIN_TOKEN_RE.test(value)) return 'invalid_characters';
  return null;
}

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
      `admin token is ${problem.replace('_', ' ')}: use ${MIN_ADMIN_TOKEN_CHARS}-${MAX_ADMIN_TOKEN_CHARS} printable characters without spaces`,
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
