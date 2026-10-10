// SPDX-License-Identifier: Apache-2.0
// Admin browser sessions over HTTP (P4-02, THREAT_MODEL T13/T14). Web-standard only (ADR-0004).
//
// - Sign-in (`onLogin`) ends the browser's previous session, creates a new one in storage and sets the cookie
//   `__Host-rb_session` (`rb_session` on http loopback): HttpOnly, Secure, SameSite=Lax, Path=/, no Domain.
//   Lax rather than Strict: sign-in finishes in a redirect chain the IdP started, and Strict would withhold the cookie
//   on the first admin page after it (and on every link into the admin from mail or chat). Unsafe methods are covered
//   by the CSRF token and the Origin check; cross-site reads by `Sec-Fetch-Site`.
// - Every cookie-authenticated request loads the session from storage (a logout anywhere ends it everywhere at once)
//   and the user record (≤ 5 s per-isolate cache, cleared by admin changes): a disabled or deleted user fails.
// - The user's role comes from the user record on every request, never from the session.
import {
  type ActiveSession,
  checkSessionTimeouts,
  createSession,
  csrfTokenMatches,
  DEFAULT_SESSION_TIMEOUTS,
  INSECURE_SESSION_COOKIE,
  loadSession,
  revokeSession,
  revokeUserSessions,
  SESSION_COOKIE,
  type SessionTimeouts,
} from '@relic-bridge/auth';
import type { Clock, Logger } from '@relic-bridge/core';
import type { KvRepository, UserRecord, UserRole, UsersRepository } from '@relic-bridge/storage';
import type { Context } from 'hono';
import type { AdminAuditEvent } from './audit.ts';
import type { CompletedLogin } from './identity.ts';

export interface SessionOptions {
  /** Idle and absolute timeouts. Default 30 minutes / 12 hours. */
  readonly timeouts?: SessionTimeouts;
  /** How long a user record is reused per isolate, 0-10000 ms. Default 5000. */
  readonly userCacheTtlMs?: number;
}

/** Header carrying the CSRF token on admin API calls. */
export const CSRF_HEADER = 'x-csrf-token';
/** Form field carrying the CSRF token on HTML form posts (`POST /auth/logout`). */
export const CSRF_FIELD = '_csrf';
export const DEFAULT_USER_CACHE_TTL_MS = 5000;
const USER_CACHE_MAX = 1000;

/** Ranks of the admin roles: a route needing `admin` admits `admin` and `owner`. */
export const ROLE_RANK: Readonly<Record<UserRole, number>> = Object.freeze({ member: 1, admin: 2, owner: 3 });

/** Who is calling the admin API. The bootstrap admin token counts as `owner` (break-glass, P4-02). */
export type AdminPrincipal =
  | { readonly kind: 'admin_token'; readonly role: 'owner' }
  | {
      readonly kind: 'session';
      readonly role: UserRole;
      readonly user: UserRecord;
      readonly session: ActiveSession;
    };

export type SessionPrincipal = Extract<AdminPrincipal, { kind: 'session' }>;

export type SessionAuth =
  | { readonly ok: true; readonly principal: SessionPrincipal }
  /** `none`: no session cookie at all (the caller treats it like a missing credential). */
  | { readonly ok: false; readonly reason: 'none' | 'session_user_disabled' | string };

/** Why a cookie-authenticated request is refused before its handler (403). */
export type FetchOriginProblem = 'cross_site' | 'origin_mismatch' | 'origin_missing';

export interface SessionManager {
  readonly cookieName: string;
  /** `RB_PUBLIC_URL`'s origin: the only `Origin` cookie-authenticated unsafe requests may carry. */
  readonly publicOrigin: string;
  readonly timeouts: SessionTimeouts;
  /** The session cookie value; null when the header names it more than once (cookie tossing: treated as malformed). */
  readCookie(c: Context): string | null | undefined;
  /** Load and check the session of this request, and its user. */
  authenticate(c: Context): Promise<SessionAuth>;
  /** Fetch-metadata and Origin checks for a cookie-authenticated request (null when fine). */
  checkFetchOrigin(c: Context, unsafe: boolean): FetchOriginProblem | null;
  csrfMatches(principal: SessionPrincipal, presented: string | undefined): boolean;
  /** `onLogin`: rotate, create, set the cookie, 303 to `next`. */
  login(c: Context, login: CompletedLogin): Promise<Response>;
  /** End the session this request presents (logout). */
  revokeCurrent(c: Context): Promise<boolean>;
  /** End every session of a user (logout everywhere, role change, disable). */
  revokeUser(userId: string): Promise<number>;
  /** Drop cached user records (after an admin change). */
  forgetUsers(): void;
  setCookie(value: string): string;
  readonly clearCookie: string;
}

export interface SessionManagerDeps {
  readonly publicUrl: string;
  readonly kv: Pick<KvRepository, 'get' | 'put' | 'delete' | 'list' | 'deletePrefix'>;
  readonly users: Pick<UsersRepository, 'get'>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly options?: SessionOptions;
  /** Records session changes (`session.create`, …); never rejects. */
  readonly audit?: (event: AdminAuditEvent) => Promise<void>;
  readonly runInBackground: (c: Context, task: Promise<unknown>, what: string) => void;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const isUnsafeMethod = (method: string): boolean => !SAFE_METHODS.has(method.toUpperCase());

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const publicOrigin = new URL(deps.publicUrl).origin;
  const secure = publicOrigin.startsWith('https:');
  const cookieName = secure ? SESSION_COOKIE : INSECURE_SESSION_COOKIE;
  const timeouts = checkSessionTimeouts(deps.options?.timeouts ?? DEFAULT_SESSION_TIMEOUTS);
  const cacheTtl = deps.options?.userCacheTtlMs ?? DEFAULT_USER_CACHE_TTL_MS;
  if (!Number.isSafeInteger(cacheTtl) || cacheTtl < 0 || cacheTtl > 10_000) {
    throw new RangeError('userCacheTtlMs must be between 0 and 10000');
  }
  const { kv, clock } = deps;
  // Per-app (per-isolate) cache of user records: ids, emails and roles, no credentials (T21). Bounded and short.
  const users = new Map<string, { readonly user: UserRecord | null; readonly at: number }>();
  const maxAge = Math.round(timeouts.absoluteMs / 1000);

  const cookie = (value: string, age: number) =>
    `${cookieName}=${value}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const clearCookie = cookie('', 0);

  const readCookie = (c: Context): string | null | undefined => {
    const header = c.req.header('cookie');
    if (header === undefined) return undefined;
    let found: string | undefined;
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === cookieName) {
        if (found !== undefined) return null;
        found = part.slice(i + 1).trim();
      }
    }
    return found;
  };

  const loadUser = async (id: string): Promise<UserRecord | null> => {
    const now = clock.now();
    const hit = users.get(id);
    if (hit !== undefined && now - hit.at < cacheTtl) return hit.user;
    const user = await deps.users.get(id);
    if (cacheTtl > 0) {
      if (users.size >= USER_CACHE_MAX) users.clear();
      users.set(id, { user, at: now });
    }
    return user;
  };

  const audit = (c: Context, event: AdminAuditEvent) => {
    if (deps.audit) deps.runInBackground(c, deps.audit(event), 'session_audit');
  };

  const revokeUser = async (userId: string): Promise<number> => {
    users.delete(userId);
    return revokeUserSessions(kv, userId);
  };

  return {
    cookieName,
    publicOrigin,
    timeouts,
    readCookie,
    setCookie: (value) => cookie(value, maxAge),
    clearCookie,

    async authenticate(c) {
      const value = readCookie(c);
      if (value === undefined) return { ok: false, reason: 'none' };
      const found = await loadSession(kv, value ?? '', timeouts, clock);
      if (!found.ok) return { ok: false, reason: found.reason };
      const user = await loadUser(found.session.record.userId);
      // Fail closed: disabling through the admin API already deleted the sessions; a user disabled some other way (the
      // database directly) loses this session here, so re-enabling the user later does not revive it (P4-07).
      if (user === null || user.disabledAt !== null) {
        await revokeSession(kv, value ?? '').catch(() => false);
        return { ok: false, reason: 'session_user_disabled' };
      }
      return { ok: true, principal: { kind: 'session', role: user.role, user, session: found.session } };
    },

    checkFetchOrigin(c, unsafe) {
      // Fetch metadata (all current browsers): only our own pages may use the session, for reads too. `none` is a
      // typed URL or bookmark: fine for a read, never for a change.
      const site = c.req.header('sec-fetch-site');
      if (site !== undefined && site !== 'same-origin' && !(site === 'none' && !unsafe)) return 'cross_site';
      if (!unsafe) return null;
      const origin = c.req.header('origin');
      if (origin !== undefined) return origin === publicOrigin ? null : 'origin_mismatch';
      return site === 'same-origin' ? null : 'origin_missing';
    },

    csrfMatches: (principal, presented) => csrfTokenMatches(principal.session.record, presented),

    async login(c, login) {
      // Rotation: whatever session this browser had ends here, so a planted or older cookie never survives sign-in.
      const previous = readCookie(c);
      if (previous) await revokeSession(kv, previous);
      const issued = await createSession(
        kv,
        { userId: login.user.id, provider: login.provider, idp: login.identity.idp },
        timeouts,
        clock,
      );
      users.delete(login.user.id);
      audit(c, {
        actor: { requestId: c.get('requestId') as string, userId: login.user.id },
        action: 'session.create',
        targetType: 'session',
        targetId: issued.ref,
        details: {
          via: 'sign_in',
          provider: login.provider,
          idp: login.identity.idp,
          outcome: login.outcome,
          role: login.user.role,
          rotated: Boolean(previous),
          evicted: issued.evicted,
        },
      });
      return new Response(null, {
        status: 303,
        headers: {
          // `next` was checked when the login started; check again here so no path can ever leave the origin (P4-07).
          Location: /^\/(?![/\\])/.test(login.next) ? login.next : '/admin',
          'Set-Cookie': cookie(issued.cookieValue, maxAge),
        },
      });
    },

    async revokeCurrent(c) {
      const value = readCookie(c);
      return value ? revokeSession(kv, value) : false;
    },

    revokeUser,
    forgetUsers: () => users.clear(),
  };
}
