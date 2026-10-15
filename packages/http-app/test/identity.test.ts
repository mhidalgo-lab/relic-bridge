// SPDX-License-Identifier: Apache-2.0
// P4-01: the `/auth/*` sign-in routes end to end against the mock IdP: OIDC, Google, GitHub and Cloudflare Access,
// the binding cookie, single-use state, `next`, setup links (through the admin API) and audit rows.
import {
  createCloudflareAccessProvider,
  createGitHubProvider,
  createGoogleProvider,
  createOidcProvider,
  generateMasterKey,
  type IdentityProvider,
  Keyring,
  type LoginPolicy,
} from '@relic-bridge/auth';
import { createLogger, Secret } from '@relic-bridge/core';
import { createMemoryStorage, type Storage } from '@relic-bridge/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CF_AUD,
  CF_TEAM,
  createMockIdp,
  GITHUB_CLIENT_ID,
  GOOGLE_CLIENT_ID,
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  MOCK_ISSUER,
  type MockIdp,
} from '../../auth/test/mock-idp.ts';
import {
  createAuditRecorder,
  createHttpApp,
  createRateLimitHooks,
  type HttpAppOptions,
  MemoryRateLimiter,
  safeNextPath,
} from '../src/index.ts';
import {
  ManualClock,
  parseSetupLink,
  randomAdminToken,
  setupCookieOf,
  setupPostRequest,
  T0,
} from './fixtures.ts';

const PUBLIC = 'https://bridge.example.com';
const ADMIN = randomAdminToken();

let idp: MockIdp;
let storage: Storage;
let keyring: Keyring;
let logs: string[];
let bodies: string[];

function providers(): IdentityProvider[] {
  const secret = new Secret(MOCK_CLIENT_SECRET);
  return [
    createOidcProvider({
      id: 'oidc',
      label: 'Corp <SSO>',
      idp: 'oidc:corp',
      issuer: MOCK_ISSUER,
      clientId: MOCK_CLIENT_ID,
      clientSecret: secret,
      fetch: idp.fetch,
    }),
    createGoogleProvider({ clientId: GOOGLE_CLIENT_ID, clientSecret: secret, fetch: idp.fetch }),
    createGitHubProvider({
      clientId: GITHUB_CLIENT_ID,
      clientSecret: secret,
      orgs: ['relic-org'],
      fetch: idp.fetch,
    }),
    createCloudflareAccessProvider({ team: CF_TEAM, audience: CF_AUD, fetch: idp.fetch }),
  ];
}

const POLICY: LoginPolicy = { emails: [], domains: [], githubOrgs: [], autoProvision: 'off' };

function makeApp(over: { policy?: Partial<LoginPolicy>; publicUrl?: string } & Partial<HttpAppOptions> = {}) {
  const logger = createLogger({ level: 'debug', sink: (l) => logs.push(l) });
  const audit = createAuditRecorder({ storage, logger, getClientIp: () => '203.0.113.9' });
  const { policy, publicUrl, ...rest } = over;
  const publicOrigin = publicUrl ?? PUBLIC;
  return createHttpApp({
    storage,
    keyring,
    logger,
    allowedHosts: ['bridge.example.com', 'localhost'],
    hooks: audit.hooks,
    admin: { token: new Secret(ADMIN), storage, audit },
    identity: {
      publicUrl: publicOrigin,
      providers: providers(),
      policy: { ...POLICY, ...policy },
      storage,
      audit,
    },
    ...rest,
  });
}

type App = ReturnType<typeof makeApp>;

async function get(app: App, path: string, headers: Record<string, string> = {}) {
  const res = await app.fetch(new Request(`${PUBLIC}${path}`, { headers }));
  const text = await res.text();
  bodies.push(text);
  return { res, text };
}

/** The browser: start, follow the IdP, come back with the cookie. */
async function browserLogin(app: App, provider: string, query = '', setupCookie?: string) {
  const start = await get(app, `/auth/login/${provider}${query}`, setupCookie ? { cookie: setupCookie } : {});
  expect(start.res.status).toBe(302);
  const setCookie = start.res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0] as string;
  const callback = await idp.authorize(start.res.headers.get('location') as string);
  const done = await get(app, `${callback.pathname}${callback.search}`, { cookie });
  return { start, callback, cookie, done };
}

async function auditRows() {
  await vi.waitFor(async () => {
    if ((await storage.auditLog.list({ kind: 'auth' })).length === 0) throw new Error('no rows yet');
  });
  return storage.auditLog.list({ kind: 'auth' });
}

beforeEach(async () => {
  idp = await createMockIdp();
  storage = createMemoryStorage();
  keyring = await Keyring.create({ current: generateMasterKey(1) });
  logs = [];
  bodies = [];
});

describe('redirect login (generic OIDC)', () => {
  it('signs in a pre-created user: exact redirect URI, Secure __Host- cookie, binding consumed', async () => {
    await storage.users.create({ id: 'usr_1', email: 'owner@example.com', role: 'owner' });
    const app = makeApp();
    const { start, done } = await browserLogin(app, 'oidc');
    const location = new URL(start.res.headers.get('location') as string);
    expect(location.searchParams.get('redirect_uri')).toBe(`${PUBLIC}/auth/callback/oidc`);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(start.res.headers.get('set-cookie')).toMatch(
      /^__Host-rb_login=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/,
    );
    expect(done.res.status).toBe(303);
    expect(done.res.headers.get('location')).toBe('/admin');
    expect(done.res.headers.get('set-cookie')).toMatch(
      /^__Host-rb_session=usr_1\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=43200; HttpOnly; SameSite=Lax; Secure, /,
    );
    expect(done.res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(done.res.headers.get('cache-control')).toBe('no-store');
    const user = await storage.users.get('usr_1');
    expect([user?.idp, user?.idpSubject]).toEqual(['oidc:corp', 'user-1']);
    const rows = await auditRows();
    expect(rows.map((r) => [r.action, r.status, r.userId, r.targetId])).toContainEqual([
      'login.ok',
      'ok',
      'usr_1',
      'oidc',
    ]);
    expect(rows[0]?.details).toMatchObject({ idp: 'oidc:corp', outcome: 'linked', ip: '203.0.113.9' });
  });

  it('sign-in rotates the session: the one the browser had ends, the new one works (P4-02)', async () => {
    await storage.users.create({ id: 'usr_1', email: 'owner@example.com', role: 'owner' });
    const app = makeApp();
    const sessionOf = (r: Response) =>
      (r.headers.getSetCookie().find((c) => c.startsWith('__Host-rb_session=')) ?? '').split(
        ';',
      )[0] as string;
    const me = async (cookie: string) =>
      (await get(app, '/api/admin/v1/session', { cookie, 'sec-fetch-site': 'same-origin' })).res.status;
    const first = sessionOf((await browserLogin(app, 'oidc', '?next=%2Fadmin%2Fusers')).done.res);
    expect(await me(first)).toBe(200);
    // Signing in again from a browser that presents the first session (or a planted one) ends it.
    const start = await get(app, '/auth/login/oidc');
    const login = (start.res.headers.get('set-cookie') ?? '').split(';')[0] as string;
    const cb = await idp.authorize(start.res.headers.get('location') as string);
    const again = await get(app, `${cb.pathname}${cb.search}`, { cookie: `${login}; ${first}` });
    expect(again.res.status).toBe(303);
    const second = sessionOf(again.res);
    expect(second).not.toBe(first);
    expect(await me(first)).toBe(401);
    expect(await me(second)).toBe(200);
    // The session id never reaches logs or the audit log; the audit names the user and a short reference only.
    const audit = await storage.auditLog.list({ action: 'session.create' });
    expect(audit.map((r) => [r.userId, r.details?.['rotated']])).toEqual([
      ['usr_1', true],
      ['usr_1', false],
    ]);
    const dump = `${logs.join('\n')}\n${JSON.stringify(await storage.auditLog.list({ limit: 100 }))}`;
    for (const c of [first, second]) expect(dump).not.toContain(c.split('.')[1] as string);
  });

  it('an onLogin seam receives the user and the validated next path', async () => {
    await storage.users.create({ id: 'usr_1', email: 'owner@example.com', role: 'admin' });
    const seen: unknown[] = [];
    const logger = createLogger({ level: 'error', sink: () => undefined });
    const app = createHttpApp({
      storage,
      keyring,
      logger,
      allowedHosts: ['bridge.example.com'],
      identity: {
        publicUrl: PUBLIC,
        providers: providers(),
        policy: POLICY,
        storage,
        onLogin: (_c, login) => {
          seen.push([login.user.id, login.next, login.outcome, login.provider]);
          return new Response(null, { status: 303, headers: { Location: login.next } });
        },
      },
    });
    const { done } = await browserLogin(app, 'oidc', '?next=%2Fadmin%2Fprojects%3Ftab%3D1');
    expect(done.res.status).toBe(303);
    expect(seen).toEqual([['usr_1', '/admin/projects?tab=1', 'linked', 'oidc']]);
    // An off-origin next falls back to /admin.
    const again = await browserLogin(app, 'oidc', '?next=https%3A%2F%2Fevil.example%2F');
    expect(again.done.res.status).toBe(303);
    expect(seen.at(-1)).toEqual(['usr_1', '/admin', 'existing', 'oidc']);
  });

  it('denies unknown identities by default and audits the reason; the page says nothing specific', async () => {
    const app = makeApp();
    const { done } = await browserLogin(app, 'oidc');
    expect(done.res.status).toBe(403);
    expect(done.text).toContain('Sign-in was refused');
    expect(done.text).not.toContain('not_allowed');
    expect(await storage.users.list()).toEqual([]);
    const rows = await auditRows();
    expect(rows.map((r) => [r.action, r.errorCode])).toEqual([['login.denied', 'not_allowed']]);
  });

  it('denied rows carry a keyed identity hash that correlates repeats, never the email or subject (P4-16)', async () => {
    await storage.users.create({
      id: 'usr_x',
      email: 'owner@example.com',
      role: 'member',
      idp: 'google',
      idpSubject: 'someone-else',
    });
    const app = makeApp();
    // Twice identity_conflict (the email belongs to another identity), then an unknown identity: not_allowed.
    expect((await browserLogin(app, 'oidc')).done.res.status).toBe(403);
    expect((await browserLogin(app, 'oidc')).done.res.status).toBe(403);
    idp.user = { ...idp.user, sub: 'user-9', email: 'stranger@example.org' };
    expect((await browserLogin(app, 'oidc')).done.res.status).toBe(403);
    await vi.waitFor(async () => {
      expect((await storage.auditLog.list({ action: 'login.denied' })).length).toBe(3);
    });
    const rows = [...(await storage.auditLog.list({ action: 'login.denied' }))].reverse();
    expect(rows.map((r) => r.errorCode)).toEqual(['identity_conflict', 'identity_conflict', 'not_allowed']);
    const hashes = rows.map((r) => (r.details as Record<string, unknown>)['identityHash']);
    expect(hashes[0]).toMatch(/^v1\.[A-Za-z0-9_-]{22}$/);
    expect(hashes[1]).toBe(hashes[0]);
    expect(hashes[2]).toMatch(/^v1\.[A-Za-z0-9_-]{22}$/);
    expect(hashes[2]).not.toBe(hashes[0]);
    // Keyed: the same identity under another master key hashes differently; equal to the keyring's own answer.
    expect(hashes[0]).toBe(await keyring.identityHash('oidc:corp', 'user-1'));
    const other = await Keyring.create({ current: generateMasterKey(1) });
    expect(await other.identityHash('oidc:corp', 'user-1')).not.toBe(hashes[0]);
    // T8: no email or subject in the audit log, the logs or the pages.
    const everything = `${JSON.stringify(await storage.auditLog.list({ limit: 100 }))}\n${logs.join('\n')}\n${bodies.join('\n')}`;
    for (const secret of [
      'owner@example.com',
      'Owner@Example.com',
      'stranger@example.org',
      'user-1',
      'user-9',
    ]) {
      expect(everything.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  it('auto-provisions allowlisted identities only when configured', async () => {
    const app = makeApp({ policy: { domains: ['example.com'], autoProvision: 'member' } });
    const { done } = await browserLogin(app, 'oidc');
    expect(done.res.status).toBe(303);
    expect((await storage.users.list()).map((u) => [u.email, u.role, u.idp])).toEqual([
      ['owner@example.com', 'member', 'oidc:corp'],
    ]);
  });

  it('a replayed callback (same state) is refused, even with the right cookie', async () => {
    await storage.users.create({ id: 'usr_1', email: 'owner@example.com', role: 'owner' });
    const app = makeApp();
    const { callback, cookie, done } = await browserLogin(app, 'oidc');
    expect(done.res.status).toBe(303);
    const replay = await get(app, `${callback.pathname}${callback.search}`, { cookie });
    expect(replay.res.status).toBe(400);
    const rows = await auditRows();
    expect(rows.some((r) => r.errorCode === 'unknown_state')).toBe(true);
  });

  it('login CSRF: a callback without the starting browser cookie is refused and burns the state', async () => {
    await storage.users.create({ id: 'usr_1', email: 'owner@example.com', role: 'owner' });
    const app = makeApp();
    const start = await get(app, '/auth/login/oidc');
    const callback = await idp.authorize(start.res.headers.get('location') as string);
    const path = `${callback.pathname}${callback.search}`;
    expect((await get(app, path)).res.status).toBe(400);
    expect(
      (await get(app, path, { cookie: '__Host-rb_login=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).res
        .status,
    ).toBe(400);
    // The real cookie no longer helps: the transaction was consumed by the first attempt.
    const cookie = (start.res.headers.get('set-cookie') ?? '').split(';')[0] as string;
    expect((await get(app, path, { cookie })).res.status).toBe(400);
    expect(idp.tokenRequests).toEqual([]); // the code was never exchanged
  });

  it('a login cookie named twice is no cookie (cookie tossing), even when one copy is the real one', async () => {
    await storage.users.create({ id: 'usr_1', email: 'owner@example.com', role: 'owner' });
    const app = makeApp();
    const start = await get(app, '/auth/login/oidc');
    const callback = await idp.authorize(start.res.headers.get('location') as string);
    const real = (start.res.headers.get('set-cookie') ?? '').split(';')[0] as string;
    const forged = '__Host-rb_login=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const path = `${callback.pathname}${callback.search}`;
    expect((await get(app, path, { cookie: `${real}; ${forged}` })).res.status).toBe(400);
    expect((await get(app, path, { cookie: `${forged}; ${real}` })).res.status).toBe(400);
    expect(idp.tokenRequests).toEqual([]);
  });

  it('provider mix-up: a state started for one provider is refused at another callback', async () => {
    await storage.users.create({ id: 'usr_1', email: 'owner@example.com', role: 'owner' });
    const app = makeApp();
    const start = await get(app, '/auth/login/oidc');
    const cookie = (start.res.headers.get('set-cookie') ?? '').split(';')[0] as string;
    const callback = await idp.authorize(start.res.headers.get('location') as string);
    const res = await get(app, `/auth/callback/google${callback.search}`, { cookie });
    expect(res.res.status).toBe(400);
    const rows = await auditRows();
    expect(rows.map((r) => r.errorCode)).toContain('provider_mismatch');
  });

  it('an IdP error, a missing code and a foreign iss are refused', async () => {
    const app = makeApp();
    for (const extra of ['&error=access_denied', '&iss=https%3A%2F%2Fevil.example']) {
      const start = await get(app, '/auth/login/oidc');
      const cookie = (start.res.headers.get('set-cookie') ?? '').split(';')[0] as string;
      const callback = await idp.authorize(start.res.headers.get('location') as string);
      const res = await get(app, `${callback.pathname}${callback.search}${extra}`, { cookie });
      expect(res.res.status).toBe(403);
    }
    const rows = await auditRows();
    expect(rows.map((r) => r.errorCode).sort()).toEqual(['idp_error', 'issuer_mismatch']);
  });

  it('expired ID token and unverified email are refused', async () => {
    await storage.users.create({ id: 'usr_1', email: 'owner@example.com', role: 'owner' });
    const app = makeApp();
    idp.idTokenClaims = { exp: Math.floor(Date.now() / 1000) - 600 };
    expect((await browserLogin(app, 'oidc')).done.res.status).toBe(403);
    idp.idTokenClaims = { email_verified: false };
    expect((await browserLogin(app, 'oidc')).done.res.status).toBe(403);
    const rows = await auditRows();
    expect(rows.map((r) => r.errorCode).sort()).toEqual(['email_unverified', 'token_expired']);
    expect((await storage.users.get('usr_1'))?.idp).toBeNull();
  });

  it('an unreachable IdP is a 502 page, not a crash', async () => {
    const app = makeApp();
    idp.discovery = { issuer: 'https://evil.example' };
    const res = await get(app, '/auth/login/oidc');
    expect(res.res.status).toBe(502);
  });

  it('http loopback public URL: plain cookie name without Secure', async () => {
    const app = makeApp({ publicUrl: 'http://localhost:8787' });
    const res = await app.fetch(new Request('http://localhost:8787/auth/login/oidc'));
    expect(res.headers.get('set-cookie')).toMatch(
      /^rb_login=[^;]+; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax$/,
    );
    expect(new URL(res.headers.get('location') as string).searchParams.get('redirect_uri')).toBe(
      'http://localhost:8787/auth/callback/oidc',
    );
  });
});

describe('Google and GitHub', () => {
  it('Google signs in a pre-created user', async () => {
    await storage.users.create({ id: 'usr_g', email: 'owner@example.com', role: 'owner' });
    const { done } = await browserLogin(makeApp(), 'google');
    expect(done.res.status).toBe(303);
    expect((await storage.users.get('usr_g'))?.idp).toBe('google');
  });

  it('GitHub: org members are provisioned when allowlisted by org; an unverified primary email is refused', async () => {
    const app = makeApp({ policy: { githubOrgs: ['relic-org'], autoProvision: 'member' } });
    const ok = await browserLogin(app, 'github');
    expect(ok.done.res.status).toBe(303);
    expect((await storage.users.list()).map((u) => [u.idp, u.idpSubject])).toEqual([['github', '4242']]);
    idp.githubUser = {
      ...idp.githubUser,
      id: 99,
      emails: [{ email: 'x@example.org', primary: true, verified: false }],
    };
    expect((await browserLogin(app, 'github')).done.res.status).toBe(403);
    idp.githubUser = {
      ...idp.githubUser,
      id: 100,
      emails: [{ email: 'y@example.org', primary: true, verified: true }],
      orgs: { 'relic-org': 'pending' },
    };
    expect((await browserLogin(app, 'github')).done.res.status).toBe(403);
    await vi.waitFor(async () => {
      expect((await storage.auditLog.list({ kind: 'auth', action: 'login.denied' })).length).toBe(2);
    });
    expect((await storage.auditLog.list({ action: 'login.denied' })).map((r) => r.errorCode).sort()).toEqual([
      'email_unverified',
      'not_allowed',
    ]);
  });
});

describe('Cloudflare Access', () => {
  it('signs in with a valid assertion; wrong AUD, expired or missing header are refused', async () => {
    await storage.users.create({ id: 'usr_c', email: 'owner@example.com', role: 'owner' });
    const app = makeApp();
    const ok = await get(app, '/auth/cf-access', { 'cf-access-jwt-assertion': await idp.accessAssertion() });
    expect(ok.res.status).toBe(303);
    expect((await storage.users.get('usr_c'))?.idp).toBe('cf-access');
    for (const headers of [
      {},
      { 'cf-access-jwt-assertion': await idp.accessAssertion({ aud: ['b'.repeat(64)] }) },
      { 'cf-access-jwt-assertion': await idp.accessAssertion({ exp: Math.floor(Date.now() / 1000) - 600 }) },
      // A bearer token is not an identity here.
      { authorization: `Bearer ${ADMIN}` },
    ]) {
      expect((await get(app, '/auth/cf-access', headers)).res.status).toBe(403);
    }
  });

  it('the CF_Authorization cookie is ignored', async () => {
    await storage.users.create({ id: 'usr_c', email: 'owner@example.com', role: 'owner' });
    const res = await get(makeApp(), '/auth/cf-access', {
      cookie: `CF_Authorization=${await idp.accessAssertion()}`,
    });
    expect(res.res.status).toBe(403);
  });
});

describe('setup links (first-owner bootstrap)', () => {
  async function issue(app: App, body: unknown = {}) {
    const res = await app.fetch(
      new Request(`${PUBLIC}/api/admin/v1/setup-links`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as { data: { url: string; expiresAt: number } } };
  }

  /** The browser: open the setup page, post the code from the fragment, keep the setup cookie. */
  async function redeem(app: App, url: string, headers: Record<string, string> = {}) {
    const link = parseSetupLink(url);
    const pageRes = await get(app, link.path);
    expect(pageRes.res.status).toBe(200);
    expect(pageRes.text).not.toContain(link.code);
    const form: Record<string, string> = { code: link.code };
    if (link.provider !== null) form['provider'] = link.provider;
    const res = await app.fetch(setupPostRequest(PUBLIC, form, headers));
    const text = await res.text();
    bodies.push(text);
    return { res, text, code: link.code, cookie: setupCookieOf(res) };
  }

  const clearsSetupCookie = (res: Response) =>
    res.headers.getSetCookie().some((c) => /^__Host-rb_setup=; .*Max-Age=0/.test(c));

  it('the link carries the code in the fragment only; the page posts it and the sign-in makes the owner, once', async () => {
    const app = makeApp();
    const { status, body } = await issue(app, { provider: 'oidc', ttlMinutes: 30 });
    expect(status).toBe(201);
    const link = new URL(body.data.url);
    expect(`${link.origin}${link.pathname}${link.search}`).toBe(`${PUBLIC}/auth/setup?provider=oidc`);
    expect(link.hash).toMatch(/^#setup=rb_setup_[0-9a-f]{64}$/);
    // The setup page: the UI CSP and referrer policy, the form, no inline script; the code never in it.
    const setupPage = await get(app, `${link.pathname}${link.search}`);
    expect(setupPage.res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(setupPage.res.headers.get('content-security-policy')).not.toContain('unsafe-inline');
    expect(setupPage.res.headers.get('referrer-policy')).toBe('same-origin');
    expect(setupPage.text).toContain('data-setup-form');
    expect(setupPage.text).toContain('action="/auth/setup"');
    expect(setupPage.text).not.toMatch(/<script(?![^>]*\bsrc=)/);

    const posted = await redeem(app, body.data.url);
    expect(posted.res.status).toBe(303);
    expect(posted.res.headers.get('location')).toBe('/auth/login?provider=oidc');
    expect(posted.cookie).toMatch(/^__Host-rb_setup=[0-9a-f]{64}$/);
    expect(posted.res.headers.get('set-cookie')).toMatch(
      /Path=\/; Max-Age=600; HttpOnly; SameSite=Lax; Secure/,
    );
    expect(posted.cookie).not.toContain(posted.code);
    // The chooser shows the owner card and only the link's provider.
    const chooser = await get(app, '/auth/login?provider=oidc', { cookie: posted.cookie as string });
    expect(chooser.text).toContain('becomes the owner');
    expect(chooser.text).toContain('/auth/login/oidc');
    expect(chooser.text).not.toContain('/auth/login/google');

    const { start, done } = await browserLogin(app, 'oidc', '', posted.cookie as string);
    // The setup moved into the login transaction: the start clears the setup cookie.
    expect(clearsSetupCookie(start.res)).toBe(true);
    expect(done.res.status).toBe(303);
    expect((await storage.users.list()).map((u) => [u.email, u.role])).toEqual([
      ['owner@example.com', 'owner'],
    ]);
    // Used: posting the code again is refused, and so is the old cookie at the start.
    expect((await redeem(app, body.data.url)).res.status).toBe(400);
    expect((await get(app, '/auth/login/oidc', { cookie: posted.cookie as string })).res.status).toBe(403);
    // The code (and the cookie value) never reach the logs, the audit log or a page.
    const audit = JSON.stringify(await storage.auditLog.list({ limit: 100 }));
    const all = `${logs.join('\n')}\n${audit}\n${bodies.join('\n')}`;
    expect(all).not.toContain(posted.code);
    expect(all).not.toContain((posted.cookie as string).split('=')[1]);
    expect(logs.join('\n')).toContain('"setup":"accepted"');
    const created = await storage.auditLog.list({ action: 'setup_link.create' });
    expect(created[0]?.details).toMatchObject({ ttlMinutes: 30, provider: 'oidc' });
    const ok = await storage.auditLog.list({ action: 'login.ok' });
    expect(ok[0]?.details).toMatchObject({ outcome: 'owner_bootstrap' });
    expect(ok[0]?.details).not.toHaveProperty('previousRole');
  });

  it('a link without a provider leads to the full chooser', async () => {
    const app = makeApp();
    const { body } = await issue(app);
    expect(new URL(body.data.url).search).toBe('');
    const posted = await redeem(app, body.data.url);
    expect(posted.res.headers.get('location')).toBe('/auth/login');
    const chooser = await get(app, '/auth/login', { cookie: posted.cookie as string });
    expect(chooser.text).toContain('becomes the owner');
    expect(chooser.text).toContain('/auth/login/google');
    expect(chooser.text).toContain('/auth/cf-access');
  });

  it('an old-form link (?setup=) is refused on every route, reads no storage and logs no code', async () => {
    const app = makeApp();
    const { body } = await issue(app, { provider: 'oidc' });
    const { code } = parseSetupLink(body.data.url);
    const assertion = await idp.accessAssertion();
    const take = vi.spyOn(storage.kv, 'take');
    const read = vi.spyOn(storage.kv, 'get');
    for (const path of [
      `/auth/login/oidc?setup=${code}`,
      `/auth/login?setup=${code}`,
      `/auth/cf-access?setup=${code}`,
      `/auth/setup?setup=${code}`,
      `/auth/login/oidc?next=%2Fadmin&setup=${code}`,
    ]) {
      const res = await get(app, path, { 'cf-access-jwt-assertion': assertion });
      expect(res.res.status, path).toBe(400);
      expect(res.text).toContain('relic-bridge setup-link');
      expect(res.text).not.toContain(code);
      expect(res.res.headers.get('location')).toBeNull();
      expect(res.res.headers.get('set-cookie')).toBeNull();
    }
    expect(take).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    take.mockRestore();
    read.mockRestore();
    expect(logs.join('\n')).not.toContain(code);
    expect(logs.join('\n')).toContain('"deny":"setup_in_url"');
    expect(JSON.stringify(await storage.auditLog.list({ limit: 100 }))).not.toContain(code);
    // Still unused: the fragment link works.
    expect((await redeem(app, body.data.url)).res.status).toBe(303);
  });

  it('the setup post is same-origin, form-encoded and capped', async () => {
    const app = makeApp();
    const { body } = await issue(app);
    const { code } = parseSetupLink(body.data.url);
    const post = (headers: Record<string, string>, form: Record<string, string> = { code }) =>
      app.fetch(setupPostRequest(PUBLIC, form, headers));
    const cases: [string, Record<string, string>, number][] = [
      ['cross-site', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }, 403],
      ['same-site', { 'sec-fetch-site': 'same-site', origin: 'https://sub.bridge.example.com' }, 403],
      ['foreign origin', { 'sec-fetch-site': '', origin: 'https://evil.example' }, 403],
      ['null origin', { 'sec-fetch-site': '', origin: 'null' }, 403],
      ['no origin, no metadata', { 'sec-fetch-site': '', origin: '' }, 403],
      ['typed URL', { 'sec-fetch-site': 'none', origin: '' }, 403],
      ['json', { 'content-type': 'application/json' }, 415],
      ['multipart', { 'content-type': 'multipart/form-data; boundary=x' }, 415],
    ];
    for (const [what, headers, status] of cases) {
      const res = await post(headers);
      expect(res.status, what).toBe(status);
      expect(setupCookieOf(res), what).toBeNull();
    }
    expect((await post({}, { code, pad: 'x'.repeat(8192) })).status).toBe(413);
    // None of these used the link up.
    expect((await post({})).status).toBe(303);
    expect(logs.join('\n')).not.toContain(code);
  });

  it('malformed, unknown and expired codes are refused; the post never consumes the link', async () => {
    const clock = new ManualClock(T0);
    const app = makeApp({ clock });
    for (const bad of ['', 'nonsense', `rb_setup_${'0'.repeat(64)}`, `rb_setup_${'A'.repeat(64)}`]) {
      const res = await app.fetch(setupPostRequest(PUBLIC, { code: bad }));
      expect(res.status, bad).toBe(400);
      expect(setupCookieOf(res)).toBeNull();
    }
    const { body } = await issue(app, { ttlMinutes: 1 });
    const { code } = parseSetupLink(body.data.url);
    // Posting twice is fine (not consumed); only a completed sign-in uses it.
    expect((await app.fetch(setupPostRequest(PUBLIC, { code }))).status).toBe(303);
    const again = await app.fetch(setupPostRequest(PUBLIC, { code }));
    expect(again.status).toBe(303);
    const cookie = setupCookieOf(again) as string;
    clock.advance(61_000);
    expect((await app.fetch(setupPostRequest(PUBLIC, { code }))).status).toBe(400);
    // An expired link in the cookie is refused at the start, and the cookie is cleared.
    const start = await get(app, '/auth/login/oidc', { cookie });
    expect(start.res.status).toBe(403);
    expect(clearsSetupCookie(start.res)).toBe(true);
    // A malformed cookie is refused too.
    expect((await get(app, '/auth/login/oidc', { cookie: '__Host-rb_setup=zz' })).res.status).toBe(403);
  });

  it('a setup cookie named twice is no cookie (cookie tossing): a plain sign-in', async () => {
    const app = makeApp();
    const { body } = await issue(app, { provider: 'oidc' });
    const posted = await redeem(app, body.data.url);
    const tossed = `${posted.cookie}; __Host-rb_setup=${'1'.repeat(64)}`;
    const { done } = await browserLogin(app, 'oidc', '', tossed);
    // No setup: the default policy denies the unknown identity.
    expect(done.res.status).toBe(403);
    expect(await storage.users.list()).toEqual([]);
  });

  it('audits the previous role when a setup link promotes an existing user (P4-16)', async () => {
    await storage.users.create({ id: 'usr_m', email: 'owner@example.com', role: 'member' });
    const app = makeApp();
    const { body } = await issue(app, { provider: 'oidc' });
    const posted = await redeem(app, body.data.url);
    const { done } = await browserLogin(app, 'oidc', '', posted.cookie as string);
    expect(done.res.status).toBe(303);
    expect((await storage.users.get('usr_m'))?.role).toBe('owner');
    await vi.waitFor(async () => {
      expect((await storage.auditLog.list({ action: 'login.ok' })).length).toBe(1);
    });
    const [row] = await storage.auditLog.list({ action: 'login.ok' });
    expect(row?.userId).toBe('usr_m');
    expect(row?.details).toMatchObject({
      outcome: 'owner_bootstrap',
      previousRole: 'member',
      identityHash: await keyring.identityHash('oidc:corp', 'user-1'),
    });
  });

  it('two logins racing on one link: only one becomes owner', async () => {
    const app = makeApp();
    const { body } = await issue(app);
    const cookie = (await redeem(app, body.data.url)).cookie as string;
    const a = await get(app, '/auth/login/oidc', { cookie });
    idp.user = { ...idp.user, sub: 'user-2', email: 'second@example.com' };
    const b = await get(app, '/auth/login/oidc', { cookie });
    const finish = async (start: typeof a) => {
      const login = (start.res.headers.get('set-cookie') ?? '').split(';')[0] as string;
      const cb = await idp.authorize(start.res.headers.get('location') as string);
      return (await get(app, `${cb.pathname}${cb.search}`, { cookie: login })).res.status;
    };
    idp.user = { ...idp.user, sub: 'user-1', email: 'owner@example.com' };
    const first = await finish(a);
    idp.user = { ...idp.user, sub: 'user-2', email: 'second@example.com' };
    const second = await finish(b);
    expect([first, second]).toEqual([303, 403]);
    expect((await storage.users.list()).filter((u) => u.role === 'owner')).toHaveLength(1);
  });

  it('works through Cloudflare Access too; an unknown or malformed setup cookie is refused', async () => {
    const app = makeApp();
    const { body } = await issue(app, { provider: 'cf-access' });
    expect(parseSetupLink(body.data.url).path).toBe('/auth/setup?provider=cf-access');
    const assertion = { 'cf-access-jwt-assertion': await idp.accessAssertion() };
    for (const bad of [`__Host-rb_setup=${'0'.repeat(64)}`, '__Host-rb_setup=nonsense']) {
      const res = await get(app, '/auth/cf-access', { ...assertion, cookie: bad });
      expect(res.res.status, bad).toBe(403);
    }
    const posted = await redeem(app, body.data.url);
    const chooser = await get(app, '/auth/login?provider=cf-access', { cookie: posted.cookie as string });
    expect(chooser.text).toContain('/auth/cf-access');
    expect(chooser.text).not.toContain('/auth/login/oidc');
    const done = await get(app, '/auth/cf-access', { ...assertion, cookie: posted.cookie as string });
    expect(done.res.status).toBe(303);
    expect(clearsSetupCookie(done.res)).toBe(true);
    expect((await storage.users.list()).map((u) => u.role)).toEqual(['owner']);
  });

  it('is refused when sign-in is not configured, and for an unknown provider', async () => {
    const off = createHttpApp({
      storage,
      keyring,
      allowedHosts: ['bridge.example.com'],
      admin: { token: new Secret(ADMIN), storage },
    });
    expect((await issue(off)).status).toBe(422);
    expect((await issue(makeApp(), { provider: 'nope' })).status).toBe(400);
    expect((await issue(makeApp(), { ttlMinutes: 0 })).status).toBe(400);
  });
});

describe('pages and guards', () => {
  it('the chooser escapes labels and keeps a valid next; unknown providers are 404', async () => {
    const app = makeApp();
    const page = await get(app, '/auth/login?next=%2Fadmin%2Fx');
    expect(page.res.status).toBe(200);
    expect(page.res.headers.get('content-type')).toContain('text/html');
    expect(page.text).toContain('Corp &lt;SSO&gt;');
    expect(page.text).not.toContain('<SSO>');
    expect(page.text).toContain('/auth/login/oidc?next=%2Fadmin%2Fx');
    expect(page.text).not.toContain('becomes the owner');
    expect(page.text).toContain('/auth/cf-access?next=');
    expect((await get(app, '/auth/login/nope')).res.status).toBe(404);
    expect((await get(app, '/auth/callback/cf-access?state=x')).res.status).toBe(404);
  });

  it('safeNextPath keeps same-origin paths only', () => {
    for (const bad of [
      '//evil.example/',
      '/\\evil.example',
      'https://evil.example/',
      'javascript:alert(1)',
      '/admin\\x',
      '/a b',
      `/${'a'.repeat(2048)}`,
      '',
    ]) {
      expect(safeNextPath(bad, PUBLIC), bad).toBeNull();
    }
    expect(safeNextPath('/admin/projects?x=1#y', PUBLIC)).toBe('/admin/projects?x=1#y');
    // Room for an OAuth authorization request (P5-04).
    const authorize = `/oauth/authorize?${'a'.repeat(2047 - '/oauth/authorize?'.length)}`;
    expect(safeNextPath(authorize, PUBLIC)).toBe(authorize);
  });

  it('the per-IP request limit covers the sign-in routes', async () => {
    const hooks = createRateLimitHooks({
      limiter: new MemoryRateLimiter(),
      preAuthLimiter: new MemoryRateLimiter(),
      rules: { ip: { requests: 2, perSeconds: 60 }, token: null, grant: null, authFailures: null },
      getClientIp: () => '203.0.113.9',
    });
    const app = makeApp({ hooks });
    expect((await get(app, '/auth/login')).res.status).toBe(200);
    expect((await get(app, '/auth/login/oidc')).res.status).toBe(302);
    expect((await get(app, '/auth/callback/oidc')).res.status).toBe(429);
  });

  it('routes are off without identity options', async () => {
    const app = createHttpApp({ storage, keyring, allowedHosts: ['bridge.example.com'] });
    for (const path of ['/auth/login', '/auth/login/oidc', '/auth/callback/oidc', '/auth/cf-access']) {
      expect((await get(app, path)).res.status).toBe(404);
    }
  });

  it('refuses a public URL whose host the Host check would block', () => {
    expect(() =>
      createHttpApp({
        storage,
        keyring,
        allowedHosts: ['other.example.com'],
        identity: { publicUrl: PUBLIC, providers: [], policy: POLICY, storage },
      }),
    ).toThrow(/allowedHosts/);
  });
});
