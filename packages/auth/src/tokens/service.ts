// SPDX-License-Identifier: Apache-2.0
// Per-device access tokens (ADR-0009, P2-05, THREAT_MODEL T1/T15): issue, verify, list, revoke. Tokens are stored
// only as SHA-256 hashes; the plaintext leaves `issueAccessToken` once, wrapped in `Secret`. No module state: storage,
// clock and options are passed in on every call.
import { redact, Secret } from '@relic-bridge/core';
import { type AccessTokenRecord, newId, type Storage } from '@relic-bridge/storage';
import { AccessError } from '../access/errors.ts';
import { timingSafeEqual, utf8 } from '../crypto/bytes.ts';
import {
  checkTokenFormat,
  DEFAULT_TOKEN_ENV,
  generateTokenString,
  hashToken,
  isTokenEnv,
  MAX_TOKEN_LENGTH,
  tokenDisplayPrefix,
} from './format.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Default lifetime of a new token. */
export const DEFAULT_TOKEN_TTL_MS: number = 90 * DAY;
/** `last_used_at` is written at most this often per token, to save writes (D1 subrequests, SQLite fsyncs). */
export const LAST_USED_WRITE_INTERVAL_MS: number = 5 * MINUTE;
export const MAX_TOKEN_LABEL = 100;

// Control characters (C0, DEL, C1), line/paragraph separators and bidi overrides/isolates: a label is printed by the
// CLI and the admin UI, so it must not move the cursor, colour the terminal or reorder the text around it.
function hasUnsafeChar(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return true;
  }
  return false;
}

/** A token as shown to people: everything but the hash. */
export interface AccessTokenSummary {
  readonly id: string;
  readonly grantId: string;
  /** `rb_live_Ab3d`: enough to recognise a token, never to use it. */
  readonly prefix: string;
  readonly label: string;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
}

export type IssueTokenWarning =
  /** `ttl: 'never'`: the token works until revoked. */
  | 'token_never_expires'
  /** The token expires after its grant (or never, while the grant does): the grant's expiry still applies. */
  | 'token_outlives_grant';

export interface IssueAccessTokenInput {
  readonly grantId: string;
  /** Device name (`laptop`, `work-pc`). */
  readonly label: string;
  /** Lifetime in milliseconds, or `'never'`. Default {@link DEFAULT_TOKEN_TTL_MS}. */
  readonly ttl?: number | 'never';
  /** Token `env` segment, 2-4 lowercase letters/digits. Default `live`. */
  readonly env?: string;
}

export interface IssuedAccessToken {
  /** The plaintext token. Show it once; it is not stored and can't be recovered. */
  readonly token: Secret;
  readonly record: AccessTokenSummary;
  readonly warnings: readonly IssueTokenWarning[];
}

export type TokenDenyReason =
  /** Not a token at all (shape or length). No storage read. */
  | 'malformed'
  /** Right shape, wrong checksum: a typo or a guess. No storage read. */
  | 'bad_checksum'
  /** No stored token has this hash. */
  | 'unknown'
  | 'revoked'
  /** `now ≥ expires_at`. */
  | 'expired';

export const TOKEN_DENY_REASONS: readonly TokenDenyReason[] = Object.freeze([
  'malformed',
  'bad_checksum',
  'unknown',
  'revoked',
  'expired',
] as const);

export type TokenVerification =
  | {
      readonly ok: true;
      readonly tokenId: string;
      /** The principal for `resolveAccess`; the grant decides the project (a token works on one project only). */
      readonly grantId: string;
      /** Cap any cache of this result (and of the access resolved from it) at this time. */
      readonly expiresAt: number | null;
      /**
       * The throttled `last_used_at` write, or `null` when none was due. Never rejects: await it, or hand it to
       * `waitUntil` on Workers.
       */
      readonly touch: Promise<void> | null;
    }
  | { readonly ok: false; readonly reason: TokenDenyReason };

export interface VerifyAccessTokenOptions {
  readonly now: number;
  /** Called when the `last_used_at` write fails (for a log line); the error never carries the token. */
  readonly onTouchError?: (error: unknown) => void;
}

type TokenStore = Pick<Storage, 'accessTokens'>;
type IssueDeps = Pick<Storage, 'accessTokens' | 'grants'>;

export function toTokenSummary(r: AccessTokenRecord): AccessTokenSummary {
  return Object.freeze({
    id: r.id,
    grantId: r.grantId,
    prefix: r.prefix,
    label: r.label,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
  });
}

function checkLabel(value: unknown): string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (v === '' || v.length > MAX_TOKEN_LABEL || hasUnsafeChar(v)) {
    throw new AccessError(
      'invalid_input',
      `label must be 1-${MAX_TOKEN_LABEL} characters without control characters`,
      'label',
    );
  }
  return v;
}

function expiryFor(ttl: number | 'never' | undefined, now: number): number | null {
  if (ttl === 'never') return null;
  const ms = ttl ?? DEFAULT_TOKEN_TTL_MS;
  if (!Number.isSafeInteger(ms) || ms <= 0 || !Number.isSafeInteger(now + ms)) {
    throw new AccessError('invalid_input', "ttl must be a positive number of milliseconds or 'never'", 'ttl');
  }
  return now + ms;
}

/**
 * Issues a token for a live grant (not revoked, not expired). The grant's project, user and credential are checked
 * on every request by `resolveAccess`, so a token never grants more than its grant does at that moment.
 */
export async function issueAccessToken(
  storage: IssueDeps,
  input: IssueAccessTokenInput,
  now: number,
): Promise<IssuedAccessToken> {
  checkNow(now);
  const label = checkLabel(input.label);
  const env = input.env ?? DEFAULT_TOKEN_ENV;
  if (!isTokenEnv(env)) {
    throw new AccessError('invalid_input', 'env must be 2-4 lowercase letters or digits', 'env');
  }
  const expiresAt = expiryFor(input.ttl, now);
  const grant = typeof input.grantId === 'string' ? await storage.grants.get(input.grantId) : null;
  if (grant === null || grant.revokedAt !== null || (grant.expiresAt !== null && now >= grant.expiresAt)) {
    throw new AccessError(
      'not_found',
      redact(`grant ${String(input.grantId).slice(0, 64)} not found`),
      'grantId',
    );
  }
  const warnings: IssueTokenWarning[] = [];
  if (expiresAt === null) warnings.push('token_never_expires');
  if (grant.expiresAt !== null && (expiresAt === null || expiresAt > grant.expiresAt)) {
    warnings.push('token_outlives_grant');
  }
  const plaintext = generateTokenString(env);
  const record = await storage.accessTokens.create({
    id: newId('tok'),
    grantId: grant.id,
    prefix: tokenDisplayPrefix(plaintext),
    tokenHash: await hashToken(plaintext),
    label,
    expiresAt,
  });
  return Object.freeze({
    token: new Secret(plaintext),
    record: toTokenSummary(record),
    warnings: Object.freeze(warnings),
  });
}

/** A bad clock must fail loudly: `NaN >= expiresAt` is false, which would make every token immortal. */
export function checkNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('now must be a timestamp in milliseconds');
}

function deny(reason: TokenDenyReason): TokenVerification {
  return { ok: false, reason };
}

/**
 * Authenticates a presented token: offline format + checksum check (no storage read), SHA-256, lookup by hash,
 * constant-time comparison of the stored hash (an adapter's lookup is not trusted to compare exactly), then
 * revocation and expiry against `now`. Deny reasons are for logs and audit only; HTTP answers all of them alike.
 */
export async function verifyAccessToken(
  storage: TokenStore,
  token: unknown,
  options: VerifyAccessTokenOptions,
): Promise<TokenVerification> {
  const { now } = options;
  checkNow(now);
  const problem = checkTokenFormat(token);
  if (problem !== null) return deny(problem);
  const hash = await hashToken(token as string);
  const checked = checkTokenRecord(await storage.accessTokens.getByHash(hash), hash, now);
  if (!checked.ok) return checked;
  const { record } = checked;
  return {
    ok: true,
    tokenId: record.id,
    grantId: record.grantId,
    expiresAt: record.expiresAt,
    touch: touchToken(storage, record, now, options.onTouchError),
  };
}

/**
 * The checks on a stored token row, shared by `verifyAccessToken` and `authenticateAccess` (P3-09): constant-time
 * comparison of the stored hash (an adapter's lookup is not trusted to compare exactly), then revocation and expiry.
 * Pure; `now` must already be checked.
 */
export function checkTokenRecord(
  record: AccessTokenRecord | null,
  hash: string,
  now: number,
):
  | { readonly ok: true; readonly record: AccessTokenRecord }
  | { readonly ok: false; readonly reason: TokenDenyReason } {
  if (record === null || !timingSafeEqual(utf8(record.tokenHash), utf8(hash)))
    return { ok: false, reason: 'unknown' };
  if (record.revokedAt !== null) return { ok: false, reason: 'revoked' };
  if (record.expiresAt !== null && now >= record.expiresAt) return { ok: false, reason: 'expired' };
  return { ok: true, record };
}

/**
 * The throttled `last_used_at` write for an accepted token, or `null` when none is due (at most one per
 * {@link LAST_USED_WRITE_INTERVAL_MS}, from the stored value). Never rejects.
 */
export function touchToken(
  storage: TokenStore,
  record: AccessTokenRecord,
  now: number,
  onTouchError?: (error: unknown) => void,
): Promise<void> | null {
  const due = record.lastUsedAt === null || now - record.lastUsedAt >= LAST_USED_WRITE_INTERVAL_MS;
  if (!due) return null;
  return Promise.resolve()
    .then(() => storage.accessTokens.markUsed(record.id, now))
    .catch((error: unknown) => {
      try {
        onTouchError?.(error);
      } catch {
        // A failing log hook must not turn into an unhandled rejection.
      }
    });
}

/** Revokes a token. Revoking twice keeps the first time. Unknown ids are `not_found`. */
export async function revokeAccessToken(
  storage: TokenStore,
  tokenId: string,
  now: number,
): Promise<AccessTokenSummary> {
  checkNow(now);
  const existing = typeof tokenId === 'string' ? await storage.accessTokens.get(tokenId) : null;
  if (existing === null) {
    throw new AccessError('not_found', redact(`token ${String(tokenId).slice(0, 64)} not found`), 'tokenId');
  }
  return toTokenSummary(await storage.accessTokens.revoke(existing.id, now));
}

/** Tokens (all, or one grant's) without their hashes. */
export async function listAccessTokens(
  storage: TokenStore,
  filter: { readonly grantId?: string } = {},
): Promise<readonly AccessTokenSummary[]> {
  return Object.freeze((await storage.accessTokens.list(filter)).map(toTokenSummary));
}

/**
 * The token from an `Authorization` header value (`Bearer <token>`, scheme case-insensitive), or `null`. Anything
 * longer than a token could be is `null` too, so a huge header is never hashed.
 */
export function bearerToken(
  header: string | null | undefined,
  maxTokenLength: number = MAX_TOKEN_LENGTH,
): string | null {
  if (typeof header !== 'string' || header.length > maxTokenLength + 32) return null;
  const m = /^[ \t]*bearer[ \t]+([^\s]+)[ \t]*$/i.exec(header);
  return m?.[1] ?? null;
}
