// SPDX-License-Identifier: Apache-2.0
// Admin browser sessions (P4-02, THREAT_MODEL T13/T14). Web-standard only (ADR-0004).
//
// A session lives in the storage `kv` table (D1 / SQLite), never in isolate memory, so every isolate or process sees
// a logout at once. The browser holds `<userId>.<secret>` (secret: 32 CSPRNG bytes, base64url); storage holds only
// SHA-256(secret), in the key:
//
//   sess:<userId>:<hash>       the session: user, provider, created/absolute expiry, CSRF token (JSON)
//   sess-seen:<userId>:<hash>  last activity (epoch ms), for the idle timeout
//
// Activity lives in its own row so that refreshing it never rewrites the session row: a refresh racing a logout can
// only recreate `sess-seen:`, which is worthless without `sess:`, so a revoked session can't come back. The user id
// in the key lets "revoke every session of a user" list one prefix. Expiry is decided here, against the caller's
// clock; the `kv` expiry (with an hour of grace) only lets the storage drop dead rows.
import type { Clock } from '@relic-bridge/core';
import type { KvRepository } from '@relic-bridge/storage';
import { timingSafeEqual, utf8 } from '../crypto/bytes.ts';
import { randomValue, sha256Hex } from './login.ts';

type Kv = Pick<KvRepository, 'get' | 'put' | 'delete' | 'list'>;
type ClockLike = Pick<Clock, 'now'>;

/** Cookie name on https (`__Host-`: Secure, `Path=/`, no `Domain`, so no sibling subdomain can set or read it). */
export const SESSION_COOKIE = '__Host-rb_session';
/** Cookie name on http loopback (browsers refuse `__Host-` without Secure). */
export const INSECURE_SESSION_COOKIE = 'rb_session';
export const DEFAULT_SESSION_IDLE_MS: number = 30 * 60_000;
export const DEFAULT_SESSION_ABSOLUTE_MS: number = 12 * 60 * 60_000;
export const MIN_SESSION_IDLE_MS: number = 5 * 60_000;
export const MAX_SESSION_IDLE_MS: number = 24 * 60 * 60_000;
export const MIN_SESSION_ABSOLUTE_MS: number = 60 * 60_000;
export const MAX_SESSION_ABSOLUTE_MS: number = 7 * 24 * 60 * 60_000;
/** Activity is written at most this often per session (bounds D1 writes; the idle timeout is ≥ 5 min). */
export const SESSION_TOUCH_INTERVAL_MS: number = 60_000;
/** Storage keeps dead rows this much longer than the decision needs (clean-up backstop only). */
const KV_GRACE_SECONDS = 3600;

const SESSION_PREFIX = 'sess:';
const SEEN_PREFIX = 'sess-seen:';
/** User ids as `newId('usr')` makes them, and the short ids fixtures and the CLI use. */
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface SessionTimeouts {
  /** Ends a session after this long without a request. */
  readonly idleMs: number;
  /** Ends a session this long after sign-in, whatever the activity. */
  readonly absoluteMs: number;
}

export const DEFAULT_SESSION_TIMEOUTS: SessionTimeouts = Object.freeze({
  idleMs: DEFAULT_SESSION_IDLE_MS,
  absoluteMs: DEFAULT_SESSION_ABSOLUTE_MS,
});

/** Throws `RangeError` for timeouts outside the allowed ranges (or an idle timeout above the absolute one). */
export function checkSessionTimeouts(t: SessionTimeouts): SessionTimeouts {
  const ok = (v: number, min: number, max: number) => Number.isSafeInteger(v) && v >= min && v <= max;
  if (!ok(t.idleMs, MIN_SESSION_IDLE_MS, MAX_SESSION_IDLE_MS)) {
    throw new RangeError('session idle timeout must be between 5 minutes and 24 hours');
  }
  if (!ok(t.absoluteMs, MIN_SESSION_ABSOLUTE_MS, MAX_SESSION_ABSOLUTE_MS)) {
    throw new RangeError('session lifetime must be between 1 hour and 7 days');
  }
  if (t.idleMs > t.absoluteMs) throw new RangeError('session idle timeout must not exceed its lifetime');
  return Object.freeze({ idleMs: t.idleMs, absoluteMs: t.absoluteMs });
}

/** What storage holds for a session. Never the session secret. */
export interface SessionRecord {
  readonly userId: string;
  /** Provider id the user signed in with (URL key) and its `idp`. */
  readonly provider: string;
  readonly idp: string;
  readonly createdAt: number;
  /** Absolute expiry (epoch ms). */
  readonly expiresAt: number;
  /** Synchronizer CSRF token (43 base64url characters). Only this session's pages get it. */
  readonly csrf: string;
}

/** A live session, as `loadSession` returns it. */
export interface ActiveSession {
  readonly record: SessionRecord;
  /** SHA-256 hex of the secret; with `userId` it names the session (logs, audit, revocation). */
  readonly hash: string;
  /** Short non-secret reference for audit rows (first 16 hex characters of the hash). */
  readonly ref: string;
  readonly lastSeenAt: number;
  /** When the idle timeout ends it if no request comes (epoch ms). */
  readonly idleExpiresAt: number;
}

export interface IssuedSession extends ActiveSession {
  /** The cookie value (`<userId>.<secret>`). Shown to the browser once, never stored. */
  readonly cookieValue: string;
}

export type SessionFailure =
  /** Not a session cookie value at all (checked before any storage read). */
  | 'session_malformed'
  /** No such session: never existed, logged out or revoked. */
  | 'session_unknown'
  /** Past its absolute lifetime. */
  | 'session_expired'
  /** Idle for longer than the idle timeout. */
  | 'session_idle';

export type SessionLookup =
  | { readonly ok: true; readonly session: ActiveSession }
  | { readonly ok: false; readonly reason: SessionFailure };

const sessionKey = (userId: string, hash: string) => `${SESSION_PREFIX}${userId}:${hash}`;
const seenKey = (userId: string, hash: string) => `${SEEN_PREFIX}${userId}:${hash}`;
const expiration = (ms: number) => Math.ceil(ms / 1000) + KV_GRACE_SECONDS;
const refOf = (hash: string) => hash.slice(0, 16);

/** Split a cookie value into user id and secret, or null when it is not one (no storage read needed to refuse it). */
export function parseSessionCookie(value: string | undefined): { userId: string; secret: string } | null {
  if (value === undefined || value.length > 120) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const userId = value.slice(0, dot);
  const secret = value.slice(dot + 1);
  return USER_ID_RE.test(userId) && SECRET_RE.test(secret) ? { userId, secret } : null;
}

function parseRecord(raw: string | null, userId: string): SessionRecord | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (
      v['userId'] !== userId ||
      typeof v['provider'] !== 'string' ||
      typeof v['idp'] !== 'string' ||
      typeof v['createdAt'] !== 'number' ||
      typeof v['expiresAt'] !== 'number' ||
      typeof v['csrf'] !== 'string' ||
      !SECRET_RE.test(v['csrf'])
    ) {
      return null;
    }
    return v as unknown as SessionRecord;
  } catch {
    return null;
  }
}

/** Create a session for a signed-in user. The caller sets the cookie and must revoke any session it replaces. */
export async function createSession(
  kv: Kv,
  input: { readonly userId: string; readonly provider: string; readonly idp: string },
  timeouts: SessionTimeouts,
  clock: ClockLike,
): Promise<IssuedSession> {
  if (!USER_ID_RE.test(input.userId)) throw new TypeError('user id cannot be used in a session');
  const secret = randomValue();
  const hash = await sha256Hex(secret);
  const now = clock.now();
  const record: SessionRecord = {
    userId: input.userId,
    provider: input.provider,
    idp: input.idp,
    createdAt: now,
    expiresAt: now + timeouts.absoluteMs,
    csrf: randomValue(),
  };
  // Activity first: a session row never exists without one (a crash in between leaves only a worthless row).
  await kv.put(seenKey(input.userId, hash), String(now), {
    expiration: expiration(Math.min(record.expiresAt, now + timeouts.idleMs)),
  });
  await kv.put(sessionKey(input.userId, hash), JSON.stringify(record), {
    expiration: expiration(record.expiresAt),
  });
  return {
    record,
    hash,
    ref: refOf(hash),
    lastSeenAt: now,
    idleExpiresAt: Math.min(record.expiresAt, now + timeouts.idleMs),
    cookieValue: `${input.userId}.${secret}`,
  };
}

/**
 * Look up the session a cookie names and check both timeouts. On success the activity row is refreshed (at most once
 * per {@link SESSION_TOUCH_INTERVAL_MS}). Does not check the user: the caller must (disabled users, roles).
 */
export async function loadSession(
  kv: Kv,
  cookieValue: string | undefined,
  timeouts: SessionTimeouts,
  clock: ClockLike,
): Promise<SessionLookup> {
  const parsed = parseSessionCookie(cookieValue);
  if (parsed === null) return { ok: false, reason: 'session_malformed' };
  const hash = await sha256Hex(parsed.secret);
  const [raw, seenRaw] = await Promise.all([
    kv.get(sessionKey(parsed.userId, hash)),
    kv.get(seenKey(parsed.userId, hash)),
  ]);
  const record = parseRecord(raw, parsed.userId);
  if (record === null) return { ok: false, reason: 'session_unknown' };
  const now = clock.now();
  if (now >= record.expiresAt) return { ok: false, reason: 'session_expired' };
  const seen = seenRaw === null ? Number.NaN : Number(seenRaw);
  if (!Number.isSafeInteger(seen) || now - seen >= timeouts.idleMs)
    return { ok: false, reason: 'session_idle' };
  let lastSeenAt = seen;
  if (now - seen >= SESSION_TOUCH_INTERVAL_MS) {
    lastSeenAt = now;
    await kv.put(seenKey(parsed.userId, hash), String(now), {
      expiration: expiration(Math.min(record.expiresAt, now + timeouts.idleMs)),
    });
  }
  return {
    ok: true,
    session: {
      record,
      hash,
      ref: refOf(hash),
      lastSeenAt,
      idleExpiresAt: Math.min(record.expiresAt, lastSeenAt + timeouts.idleMs),
    },
  };
}

/** End one session (logout). Unknown or malformed values are ignored. */
export async function revokeSession(kv: Kv, cookieValue: string | undefined): Promise<boolean> {
  const parsed = parseSessionCookie(cookieValue);
  if (parsed === null) return false;
  return revokeSessionByHash(kv, parsed.userId, await sha256Hex(parsed.secret));
}

/** End one session by user id and hash. The session row goes first: after that the session is dead. */
export async function revokeSessionByHash(kv: Kv, userId: string, hash: string): Promise<boolean> {
  if (!USER_ID_RE.test(userId) || !HASH_RE.test(hash)) return false;
  const existed = (await kv.get(sessionKey(userId, hash))) !== null;
  await kv.delete(sessionKey(userId, hash));
  await kv.delete(seenKey(userId, hash));
  return existed;
}

/** End every session of a user (logout everywhere, role change, disable). Returns how many were live. */
export async function revokeUserSessions(kv: Kv, userId: string): Promise<number> {
  if (!USER_ID_RE.test(userId)) return 0;
  const prefix = `${SESSION_PREFIX}${userId}:`;
  const hashes: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
    for (const k of page.keys) hashes.push(k.name.slice(prefix.length));
    cursor = page.complete ? undefined : page.cursor;
  } while (cursor !== undefined);
  for (const hash of hashes) {
    await kv.delete(sessionKey(userId, hash));
    await kv.delete(seenKey(userId, hash));
  }
  return hashes.length;
}

/** Constant-time comparison of a presented CSRF token with the session's. */
export function csrfTokenMatches(
  session: Pick<SessionRecord, 'csrf'>,
  presented: string | undefined,
): boolean {
  const value = presented !== undefined && SECRET_RE.test(presented) ? presented : '';
  // Equal lengths always (43): a wrong-length or absent value is compared as a fixed non-token.
  return timingSafeEqual(utf8(value.padEnd(43, '\0')), utf8(session.csrf)) && value !== '';
}
