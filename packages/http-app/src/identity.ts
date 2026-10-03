// SPDX-License-Identifier: Apache-2.0
// Admin sign-in routes (P4-01, ADR-0009 step 2, THREAT_MODEL T14). Web-standard only (ADR-0004).
//
//   GET /auth/login                 provider chooser (keeps `next` and `setup`)
//   GET /auth/login/:provider       starts a redirect login: transaction in storage + binding cookie → 302 to the IdP
//   GET /auth/callback/:provider    finishes it: consume the transaction once, exchange the code, verify, map to a user
//   GET /auth/cf-access             Cloudflare Access: verify the `Cf-Access-Jwt-Assertion` header, map to a user
//
// The routes end at a verified, allowed user record and hand it to `onLogin`; turning that into a session is P4-02.
// Every outcome is audited (`auth` / `login.ok` | `login.denied`); the browser gets one generic failure page whose
// only detail is the request id. Nothing here reads the `Authorization` header: bearer tokens confer nothing.
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
import type { Storage, UserRecord } from '@relic-bridge/storage';
import { type Context, Hono } from 'hono';

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
}

export interface IdentityOptions {
  /** Origin browsers use (`RB_PUBLIC_URL`); redirect URIs are `<publicUrl>/auth/callback/<provider>`, exactly. */
  readonly publicUrl: string;
  readonly providers: readonly IdentityProvider[];
  readonly policy: LoginPolicy;
  readonly storage: StorageForIdentity;
  /**
   * Called with the verified, allowed user; its Response is sent (P4-02: set the session cookie, redirect to
   * `login.next`). Default: a page naming the signed-in user (no session yet).
   */
  readonly onLogin?: (c: Context, login: CompletedLogin) => Response | Promise<Response>;
  /** Records sign-ins (`createAuditRecorder(...)`). */
  readonly audit?: { login(c: Context, event: LoginAuditEvent): Promise<void> };
}

export interface IdentityRouteDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly beforeAuth?: (
    c: Context,
    requestId: string,
  ) => Promise<Response | undefined> | Response | undefined;
  readonly runInBackground: (c: Context, task: Promise<unknown>, what: string) => void;
}

type Vars = { requestId: string; started: number; log: Record<string, unknown> };

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (ch) => ESCAPES[ch] as string);

function page(status: number, title: string, body: string, headers: Record<string, string> = {}): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<meta name="robots" content="noindex"><title>${escapeHtml(title)} · relic-bridge</title></head>` +
    `<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
}

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
    return `${u.pathname}${u.search}${u.hash}`;
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
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === cookieName) return part.slice(i + 1).trim();
    }
    return undefined;
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
  ): Response => {
    (c.get('log') as Record<string, unknown>)['deny'] = reason;
    audit(c, { status: 'denied', provider, idp, reason });
    const status = FAILURE_STATUS[reason] ?? 403;
    const text =
      status === 400
        ? 'This sign-in attempt is invalid or has expired. Start again from the sign-in page.'
        : status === 502
          ? 'The identity provider could not be reached. Try again in a moment.'
          : status === 500
            ? 'Sign-in failed unexpectedly. Try again in a moment.'
            : 'Sign-in was refused. If you should have access, ask an administrator.';
    return page(
      status,
      'Sign-in failed',
      `<p>${escapeHtml(text)}</p><p><a href="${IDENTITY_BASE}/login">Sign in again</a></p>` +
        `<p><small>Request id: ${escapeHtml(c.get('requestId') as string)}</small></p>`,
      extra,
    );
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
    if (setup !== null && !(await consumeSetupLink(storage.kv, setup, clock))) {
      return fail(c, provider.id, provider.idp, 'setup_invalid', extra);
    }
    const decision = await resolveLoginUser(storage.users, identity, policy, {
      ownerBootstrap: setup !== null,
    });
    if (!decision.ok) return fail(c, provider.id, provider.idp, decision.reason, extra);
    audit(c, {
      status: 'ok',
      provider: provider.id,
      idp: provider.idp,
      userId: decision.user.id,
      outcome: decision.outcome,
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
      : page(
          200,
          'Signed in',
          `<p>Signed in as ${escapeHtml(decision.user.email)} (${escapeHtml(decision.user.role)}).</p>` +
            '<p>Admin sessions are not available on this version yet; use the admin token for the admin API.</p>',
        );
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
    const items = [...providers.values()]
      .map((p) => {
        const href =
          p.kind === 'header' ? `${IDENTITY_BASE}/cf-access${qs}` : `${IDENTITY_BASE}/login/${p.id}${qs}`;
        return `<li><a href="${escapeHtml(href)}">Sign in with ${escapeHtml(p.label)}</a></li>`;
      })
      .join('');
    const intro = params.has('setup')
      ? '<p>Setup link: the account you sign in with becomes the owner of this instance.</p>'
      : '';
    return page(200, 'Sign in', `${intro}<ul>${items}</ul>`);
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
      const identity = await provider.complete({
        code,
        redirectUri: redirectUri(provider.id),
        codeVerifier: tx.codeVerifier,
        nonce: tx.nonce,
        ...(iss === undefined ? {} : { issuer: iss }),
      });
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

  return app;
}

export { CF_ACCESS_HEADER };
