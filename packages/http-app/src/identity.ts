// SPDX-License-Identifier: Apache-2.0
// Admin sign-in routes (P4-01, ADR-0009 step 2, THREAT_MODEL T14). Web-standard only (ADR-0004).
//
//   GET /auth/login                 provider chooser (keeps `next` and `setup`)
//   GET /auth/login/:provider       starts a redirect login: transaction in storage + binding cookie → 302 to the IdP
//   GET /auth/callback/:provider    finishes it: consume the transaction once, exchange the code, verify, map to a user
//   GET /auth/cf-access             Cloudflare Access: verify the `Cf-Access-Jwt-Assertion` header, map to a user
//   POST /auth/logout               ends the browser's session (P4-02; CSRF token + same-origin), `everywhere=1`: all
//
// The routes end at a verified, allowed user record and hand it to `onLogin`; `createHttpApp` turns that into a
// session (P4-02, `session.ts`).
// Every outcome is audited (`auth` / `login.ok` | `login.denied`); the browser gets one generic failure page whose
// only detail is the request id. Nothing here reads the `Authorization` header: bearer tokens confer nothing.

import { htmlResponse, LoginPage, MessagePage } from '@relic-bridge/admin-ui';
import {
  CF_ACCESS_HEADER,
  consumeSetupLink,
  finishLogin,
  type IdentityErrorCode,
  type IdentityProvider,
  isIdentityError,
  LOGIN_TTL_SECONDS,
  type LoginOutcome,
  type LoginPolicy,
  PROVIDER_ID_RE,
  resolveLoginUser,
  setupCodeHash,
  setupLinkUsable,
  startLogin,
  type VerifiedIdentity,
} from '@relic-bridge/auth';
import type { Clock, Logger } from '@relic-bridge/core';
import type { Storage, UserRecord, UserRole } from '@relic-bridge/storage';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AdminAuditEvent } from './audit.ts';
import { CSRF_FIELD, CSRF_HEADER, type SessionManager, type SessionOptions } from './session.ts';

export const IDENTITY_BASE: '/auth' = '/auth';
/** Where a login continues when no (valid) `next` was given. */
export const DEFAULT_LOGIN_NEXT = '/admin';

export type StorageForIdentity = Pick<Storage, 'users' | 'kv'>;

/** A finished sign-in, handed to `onLogin` (P4-02 creates the session here). */
export interface CompletedLogin {
  readonly user: UserRecord;
  readonly identity: VerifiedIdentity;
  readonly outcome: LoginOutcome;
  /** Provider id (URL key). */
  readonly provider: string;
  /** Validated same-origin path to continue to. */
  readonly next: string;
}

/** One audit row per sign-in attempt that reached a provider. Never carries codes, tokens or the email. */
export interface LoginAuditEvent {
  readonly requestId: string;
  readonly status: 'ok' | 'denied';
  readonly provider: string;
  readonly idp: string | null;
  readonly userId?: string | null;
  /** Stable deny reason (`IdentityErrorCode` or `LoginDenyReason`). */
  readonly reason?: string | null;
  readonly outcome?: LoginOutcome | null;
  /**
   * Keyed hash of `(idp, subject)` (`Keyring.identityHash`, P4-16) once the provider verified an identity: correlates
   * repeated attempts by one identity. Never the subject or the email.
   */
  readonly identityHash?: string | null;
  /** A setup link made an existing user the owner: the role it had before. */
  readonly previousRole?: UserRole | null;
}

export interface IdentityOptions {
  /** Origin browsers use (`RB_PUBLIC_URL`); redirect URIs are `<publicUrl>/auth/callback/<provider>`, exactly. */
  readonly publicUrl: string;
  readonly providers: readonly IdentityProvider[];
  readonly policy: LoginPolicy;
  readonly storage: StorageForIdentity;
  /**
   * Called with the verified, allowed user; its Response is sent. Default (`createHttpApp`): create an admin session,
   * set the session cookie and redirect to `login.next` (P4-02). Override only in tests.
   */
  readonly onLogin?: (c: Context, login: CompletedLogin) => Response | Promise<Response>;
  /** Admin session timeouts (P4-02). */
  readonly session?: SessionOptions;
  /** Records sign-ins (`createAuditRecorder(...)`), and session changes when `admin` is there. */
  readonly audit?: {
    login(c: Context, event: LoginAuditEvent): Promise<void>;
    admin?(event: AdminAuditEvent): Promise<void>;
  };
}

export interface IdentityRouteDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly beforeAuth?: (
    c: Context,
    requestId: string,
  ) => Promise<Response | undefined> | Response | undefined;
  readonly runInBackground: (c: Context, task: Promise<unknown>, what: string) => void;
  /** Admin sessions (P4-02): the default `onLogin` and `POST /logout`. */
  readonly sessions?: SessionManager;
  /** Keyed identity hash for sign-in audit rows (P4-16; `keyring.identityHash`). Omit to record none. */
  readonly identityHash?: (idp: string, subject: string) => Promise<string>;
}

/** Largest logout form body (it carries a CSRF token and a flag). */
const MAX_LOGOUT_BODY = 2048;

type Vars = { requestId: string; started: number; log: Record<string, unknown> };

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (ch) => ESCAPES[ch] as string);

/** A sign-in page in the admin UI layout, with its CSP (P4-03). Fixed sentences only, plus the request id. */
function page(
  status: number,
  title: string,
  paragraphs: readonly string[],
  opts: { link?: { href: string; label: string }; requestId?: string; headers?: Record<string, string> } = {},
): Response {
  return htmlResponse(
    MessagePage({ title, paragraphs, link: opts.link, requestId: opts.requestId }),
    status,
    opts.headers ?? {},
  );
}

/** One leading `/`, not followed by `/` or `\`: a path on this origin, never scheme-relative. */
export const isLocalPath = (path: string): boolean => /^\/(?![/\\])/.test(path);

/**
 * A post-login path: same origin, absolute path, no scheme-relative (`//host`) or backslash tricks, no control
 * characters. Anything else is null (the caller falls back to the default), so `next` can never leave the origin.
 */
export function safeNextPath(next: string | undefined, publicUrl: string): string | null {
  if (next === undefined || next.length === 0 || next.length > 512) return null;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null;
  // Printable ASCII only (no spaces or control characters), and no backslash (browsers read it as `/`).
  if (!/^[!-~]+$/.test(next) || next.includes('\\')) return null;
  try {
    const u = new URL(next, publicUrl);
    if (u.origin !== new URL(publicUrl).origin) return null;
    const path = `${u.pathname}${u.search}${u.hash}`;
    // Parsing removes dot segments: `/.//evil.example` becomes `//evil.example`, a scheme-relative URL (P4-07). Check
    // the result, not only the input.
    return isLocalPath(path) ? path : null;
  } catch {
    return null;
  }
}

const FAILURE_STATUS: Partial<Record<string, number>> = {
  invalid_callback: 400,
  unknown_state: 400,
  binding_mismatch: 400,
  provider_mismatch: 400,
  idp_unavailable: 502,
  internal_error: 500,
};

export function createIdentityRoutes(
  options: IdentityOptions,
  deps: IdentityRouteDeps,
): Hono<{ Variables: Vars }> {
  const { storage, policy, clock, logger } = { ...options, ...deps };
  const publicUrl = new URL(options.publicUrl).origin;
  const secure = publicUrl.startsWith('https:');
  // `__Host-`: Secure, Path=/, no Domain, so no sibling subdomain can set or read it. Plain name on http loopback.
  const cookieName = secure ? '__Host-rb_login' : 'rb_login';
  const providers = new Map<string, IdentityProvider>();
  for (const p of options.providers) {
    if (!PROVIDER_ID_RE.test(p.id)) throw new TypeError(`invalid identity provider id ${p.id}`);
    if (providers.has(p.id)) throw new TypeError(`duplicate identity provider ${p.id}`);
    providers.set(p.id, p);
  }
  const redirectUri = (id: string) => `${publicUrl}${IDENTITY_BASE}/callback/${id}`;
  const cookie = (value: string, maxAge: number) =>
    `${cookieName}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const clearCookie = cookie('', 0);
  const readCookie = (c: Context): string | undefined => {
    const header = c.req.header('cookie');
    if (header === undefined) return undefined;
    // Like the session cookie: a header naming the cookie more than once (cookie tossing) is no cookie at all.
    let found: string | undefined;
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === cookieName) {
        if (found !== undefined) return undefined;
        found = part.slice(i + 1).trim();
      }
    }
    return found;
  };

  const audit = (c: Context, event: Omit<LoginAuditEvent, 'requestId'>) => {
    if (!options.audit) return;
    const a = options.audit;
    deps.runInBackground(c, a.login(c, { requestId: c.get('requestId') as string, ...event }), 'login_audit');
  };

  const fail = (
    c: Context,
    provider: string,
    idp: string | null,
    reason: IdentityErrorCode | string,
    extra: Record<string, string> = {},
    identityHash: string | null = null,
  ): Response => {
    (c.get('log') as Record<string, unknown>)['deny'] = reason;
    audit(c, { status: 'denied', provider, idp, reason, ...(identityHash === null ? {} : { identityHash }) });
    const status = FAILURE_STATUS[reason] ?? 403;
    const text =
      status === 400
        ? 'This sign-in attempt is invalid or has expired. Start again from the sign-in page.'
        : status === 502
          ? 'The identity provider could not be reached. Try again in a moment.'
          : status === 500
            ? 'Sign-in failed unexpectedly. Try again in a moment.'
            : 'Sign-in was refused. If you should have access, ask an administrator.';
    return page(status, 'Sign-in failed', [text], {
      link: { href: `${IDENTITY_BASE}/login`, label: 'Sign in again' },
      requestId: c.get('requestId') as string,
      headers: extra,
    });
  };

  /** The keyed identity hash, or null (not configured, or the keyring failed: the row is still written). */
  const hashIdentity = async (identity: VerifiedIdentity): Promise<string | null> => {
    if (deps.identityHash === undefined) return null;
    try {
      return await deps.identityHash(identity.idp, identity.subject);
    } catch {
      deps.logger.warn('identity hash failed', { event: 'login_identity_hash_failed' });
      return null;
    }
  };

  /** Shared tail of both login kinds: setup link, user mapping, audit, hand-off. */
  const complete = async (
    c: Context,
    provider: IdentityProvider,
    identity: VerifiedIdentity,
    setup: string | null,
    next: string,
    extra: Record<string, string>,
  ): Promise<Response> => {
    const hash = await hashIdentity(identity);
    if (setup !== null && !(await consumeSetupLink(storage.kv, setup, clock))) {
      return fail(c, provider.id, provider.idp, 'setup_invalid', extra, hash);
    }
    const decision = await resolveLoginUser(storage.users, identity, policy, {
      ownerBootstrap: setup !== null,
    });
    if (!decision.ok) return fail(c, provider.id, provider.idp, decision.reason, extra, hash);
    audit(c, {
      status: 'ok',
      provider: provider.id,
      idp: provider.idp,
      userId: decision.user.id,
      outcome: decision.outcome,
      ...(hash === null ? {} : { identityHash: hash }),
      ...(decision.previousRole === undefined ? {} : { previousRole: decision.previousRole }),
    });
    (c.get('log') as Record<string, unknown>)['login'] = decision.outcome;
    const login: CompletedLogin = {
      user: decision.user,
      identity,
      outcome: decision.outcome,
      provider: provider.id,
      next,
    };
    const res = options.onLogin
      ? await options.onLogin(c, login)
      : deps.sessions
        ? await deps.sessions.login(c, login)
        : page(200, 'Signed in', [
            `Signed in as ${decision.user.email} (${decision.user.role}).`,
            'Admin sessions are not configured; use the admin token for the admin API.',
          ]);
    for (const [k, v] of Object.entries(extra)) res.headers.append(k, v);
    return res;
  };

  const app = new Hono<{ Variables: Vars }>();

  app.use('*', async (c, next) => {
    if (deps.beforeAuth) {
      const stop = await deps.beforeAuth(c, c.get('requestId'));
      if (stop) return stop;
    }
    await next();
  });

  const queryNext = (c: Context) => safeNextPath(c.req.query('next'), publicUrl) ?? DEFAULT_LOGIN_NEXT;

  /** The setup link carried by `?setup=`: undefined when absent, null when present but unusable. */
  const querySetup = async (c: Context): Promise<string | null | undefined> => {
    const raw = c.req.query('setup');
    if (raw === undefined) return undefined;
    const hash = await setupCodeHash(raw);
    if (hash === null || !(await setupLinkUsable(storage.kv, hash, clock))) return null;
    return hash;
  };

  app.get('/login', async (c) => {
    const params = new URLSearchParams();
    const next = safeNextPath(c.req.query('next'), publicUrl);
    if (next !== null) params.set('next', next);
    const setup = c.req.query('setup');
    if (setup !== undefined && (await setupCodeHash(setup)) !== null) params.set('setup', setup);
    const qs = params.size > 0 ? `?${params.toString()}` : '';
    const list = [...providers.values()].map((p) => ({
      href: p.kind === 'header' ? `${IDENTITY_BASE}/cf-access${qs}` : `${IDENTITY_BASE}/login/${p.id}${qs}`,
      label: p.label,
    }));
    return htmlResponse(LoginPage({ providers: list, setup: params.has('setup') }));
  });

  app.get('/login/:provider', async (c) => {
    const provider = providers.get(c.req.param('provider'));
    if (provider === undefined || provider.kind !== 'redirect') return c.json({ error: 'not_found' }, 404);
    const setup = await querySetup(c);
    if (setup === null) return fail(c, provider.id, provider.idp, 'setup_invalid');
    try {
      const started = await startLogin(
        storage.kv,
        { provider: provider.id, next: queryNext(c), setup: setup ?? null },
        clock,
      );
      const url = await provider.authorizationUrl({
        redirectUri: redirectUri(provider.id),
        state: started.state,
        nonce: started.nonce,
        codeChallenge: started.codeChallenge,
      });
      return new Response(null, {
        status: 302,
        headers: { Location: url.href, 'Set-Cookie': cookie(started.binding, LOGIN_TTL_SECONDS) },
      });
    } catch (error) {
      if (isIdentityError(error)) return fail(c, provider.id, provider.idp, error.code);
      throw error;
    }
  });

  app.get('/callback/:provider', async (c) => {
    const provider = providers.get(c.req.param('provider'));
    if (provider === undefined || provider.kind !== 'redirect') return c.json({ error: 'not_found' }, 404);
    const clear = { 'Set-Cookie': clearCookie };
    const q = (k: string) => {
      const v = c.req.query(k);
      return v !== undefined && v.length <= 2048 ? v : undefined;
    };
    try {
      // The transaction is consumed first (single use), whatever else the callback says.
      const tx = await finishLogin(
        storage.kv,
        { state: q('state'), binding: readCookie(c), provider: provider.id },
        clock,
      );
      if (q('error') !== undefined) return fail(c, provider.id, provider.idp, 'idp_error', clear);
      const code = q('code');
      if (code === undefined || code === '')
        return fail(c, provider.id, provider.idp, 'invalid_callback', clear);
      const iss = c.req.query('iss');
      const identity = await provider.complete(
        {
          code,
          redirectUri: redirectUri(provider.id),
          codeVerifier: tx.codeVerifier,
          nonce: tx.nonce,
          ...(iss === undefined ? {} : { issuer: iss }),
        },
        {
          background: (task) => deps.runInBackground(c, task, 'github_token_revoke'),
          warn: (message, fields) => logger.warn(message, { requestId: c.get('requestId'), ...fields }),
        },
      );
      return await complete(c, provider, identity, tx.setup, tx.next, clear);
    } catch (error) {
      if (isIdentityError(error)) return fail(c, provider.id, provider.idp, error.code, clear);
      logger.error('login failed', {
        requestId: c.get('requestId'),
        provider: provider.id,
        error: error instanceof Error ? error.name : typeof error,
      });
      return fail(c, provider.id, provider.idp, 'internal_error', clear);
    }
  });

  app.get('/cf-access', async (c) => {
    const provider = [...providers.values()].find((p) => p.kind === 'header');
    if (provider === undefined || provider.kind !== 'header') return c.json({ error: 'not_found' }, 404);
    const setup = await querySetup(c);
    if (setup === null) return fail(c, provider.id, provider.idp, 'setup_invalid');
    try {
      const identity = await provider.verify(c.req.raw.headers);
      return await complete(c, provider, identity, setup ?? null, queryNext(c), {});
    } catch (error) {
      if (isIdentityError(error)) return fail(c, provider.id, provider.idp, error.code);
      logger.error('login failed', {
        requestId: c.get('requestId'),
        provider: provider.id,
        error: error instanceof Error ? error.name : typeof error,
      });
      return fail(c, provider.id, provider.idp, 'internal_error');
    }
  });

  if (deps.sessions) {
    const sessions = deps.sessions;
    /** Back to the sign-in page; the cookie is cleared only when the request presented one. */
    const toLogin = (clear: boolean) =>
      new Response(null, {
        status: 303,
        headers: {
          Location: `${IDENTITY_BASE}/login`,
          ...(clear ? { 'Set-Cookie': sessions.clearCookie } : {}),
        },
      });
    const sessionAudit = (c: Context, event: Omit<AdminAuditEvent, 'actor'>, userId: string | null) => {
      const record = options.audit?.admin;
      if (!record) return;
      deps.runInBackground(
        c,
        record.call(options.audit, {
          actor: { requestId: c.get('requestId') as string, userId },
          ...event,
        }),
        'session_audit',
      );
    };

    const capped = bodyLimit({
      maxSize: MAX_LOGOUT_BODY,
      onError: () => page(413, 'Sign-out refused', ['The request is too large.']),
    });

    app.post('/logout', capped, async (c) => {
      const auth = await sessions.authenticate(c);
      // No live session: nothing to protect, just drop the cookie (an expired or revoked one). Without a cookie (a
      // cross-site form: SameSite=Lax withholds it) nothing is cleared, so another site can't sign this browser out.
      if (!auth.ok) {
        const presented = sessions.readCookie(c) !== undefined;
        if (presented) await sessions.revokeCurrent(c);
        return toLogin(presented);
      }
      const principal = auth.principal;
      const userId = principal.user.id;
      let token = c.req.header(CSRF_HEADER);
      let everywhere = false;
      const type = c.req.header('content-type') ?? '';
      // The body is capped while it is read (`bodyLimit` above), declared length or not.
      if (/^application\/x-www-form-urlencoded\s*(;|$)/i.test(type)) {
        const form = new URLSearchParams(await c.req.text());
        token ??= form.get(CSRF_FIELD) ?? undefined;
        everywhere = form.get('everywhere') === '1';
      }
      const problem =
        sessions.checkFetchOrigin(c, true) ?? (sessions.csrfMatches(principal, token) ? null : 'csrf');
      if (problem !== null) {
        (c.get('log') as Record<string, unknown>)['deny'] = problem;
        sessionAudit(
          c,
          {
            action: 'admin.forbidden',
            targetType: 'session',
            targetId: principal.session.ref,
            status: 'denied',
            errorCode: 'forbidden',
            refusal: true,
            details: { reason: problem, route: 'POST /auth/logout' },
          },
          userId,
        );
        return page(403, 'Sign-out refused', [
          'This sign-out request did not come from this site. Use the sign-out button in the admin panel.',
        ]);
      }
      if (everywhere) {
        const revoked = await sessions.revokeUser(userId);
        sessionAudit(
          c,
          {
            action: 'session.revoke_all',
            targetType: 'user',
            targetId: userId,
            details: { reason: 'logout_everywhere', revoked },
          },
          userId,
        );
      } else {
        await sessions.revokeCurrent(c);
        sessionAudit(
          c,
          {
            action: 'session.revoke',
            targetType: 'session',
            targetId: principal.session.ref,
            details: { reason: 'logout' },
          },
          userId,
        );
      }
      return toLogin(true);
    });
  }

  return app;
}

export { CF_ACCESS_HEADER };
