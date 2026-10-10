// SPDX-License-Identifier: Apache-2.0
// P4-07 security review, sign-in routes (P4-01) end to end against the mock IdP: regression tests for the findings
// fixed in the review ("fix:") and the attacks probed that hold. Report: docs/reviews/phase-4-admin-security-review.md.
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
import { randomAdminToken } from './fixtures.ts';

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
async function browserLogin(app: App, provider: string, query = '') {
  const start = await get(app, `/auth/login/${provider}${query}`);
  expect(start.res.status).toBe(302);
  const setCookie = start.res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0] as string;
  const callback = await idp.authorize(start.res.headers.get('location') as string);
  const done = await get(app, `${callback.pathname}${callback.search}`, { cookie });
  return { start, callback, cookie, done };
}

beforeEach(async () => {
  idp = await createMockIdp();
  storage = createMemoryStorage();
  keyring = await Keyring.create({ current: generateMasterKey(1) });
  logs = [];
  bodies = [];
});

const originOf = (loc: string) => new URL(loc, PUBLIC).origin;

describe('P4-07 review: next= open redirect', () => {
  // Finding M1 (fixed): WHATWG URL normalisation removes dot segments, so `/.//evil.example` becomes `//evil.example`,
  // which safeNextPath returns and the session redirect sends as `Location: //evil.example` (scheme-relative).
  const bypass = [
    '/.//evil.example',
    '/..//evil.example',
    '/%2e//evil.example',
    '/%2E%2E//evil.example',
    '/./\\/evil.example',
    '/a/..//evil.example',
  ];
  it('fix: safeNextPath never returns a scheme-relative path', () => {
    for (const n of bypass) {
      const r = safeNextPath(n, PUBLIC);
      expect(r === null || !r.startsWith('//'), `${n} -> ${r}`).toBe(true);
    }
  });

  it('fix: end to end, a post-login redirect never leaves the origin', async () => {
    await storage.users.create({ id: 'usr_1', email: 'owner@example.com', role: 'owner' });
    const app = makeApp();
    const { done } = await browserLogin(app, 'oidc', `?next=${encodeURIComponent('/.//evil.example/phish')}`);
    expect(done.res.status).toBe(303);
    expect(originOf(done.res.headers.get('location') as string)).toBe(PUBLIC);
  });

  it('the other next= tricks are refused', () => {
    const bad = [
      '//evil.example',
      '/\\evil.example',
      '\\\\evil',
      'https://evil.example',
      'javascript:alert(1)',
      '/%0d%0aSet-Cookie:x=1',
      '/a\r\nb',
      '/a b',
      '/\tevil',
      '/\t/evil.example',
      '/admin@evil.example/',
      'evil',
      '',
      '/\u2028',
      '/é',
    ];
    for (const n of bad) {
      const r = safeNextPath(n, PUBLIC);
      if (r !== null) expect(originOf(r), n).toBe(PUBLIC);
      if (r !== null) expect(r.startsWith('//'), n).toBe(false);
    }
    // `/admin@evil.example` stays a path
    expect(safeNextPath('/admin@evil.example', PUBLIC)).toBe('/admin@evil.example');
    // percent-encoded slashes/backslashes are not decoded by URL, so they stay in the path
    expect(safeNextPath('/%2F%2Fevil.example', PUBLIC)).toBe('/%2F%2Fevil.example');
    expect(safeNextPath('/%5Cevil.example', PUBLIC)).toBe('/%5Cevil.example');
  });
});

describe('P4-07 review: login transaction binding and replay', () => {
  it('state of provider A presented to provider B callback is refused, and is burnt', async () => {
    await storage.users.create({ id: 'usr_1', email: 'owner@example.com', role: 'owner' });
    const app = makeApp();
    const start = await get(app, '/auth/login/oidc');
    const cookie = (start.res.headers.get('set-cookie') ?? '').split(';')[0] as string;
    const cb = await idp.authorize(start.res.headers.get('location') as string);
    const swapped = `/auth/callback/google${cb.search}`;
    expect((await get(app, swapped, { cookie })).res.status).toBe(400);
    // burnt: the right provider can no longer use it
    expect((await get(app, `${cb.pathname}${cb.search}`, { cookie })).res.status).toBe(400);
  });

  it('replay of a finished callback, and a callback without the binding cookie, are refused', async () => {
    await storage.users.create({ id: 'usr_1', email: 'owner@example.com', role: 'owner' });
    const app = makeApp();
    const { callback, cookie, done } = await browserLogin(app, 'oidc');
    expect(done.res.status).toBe(303);
    expect((await get(app, `${callback.pathname}${callback.search}`, { cookie })).res.status).toBe(400);
    const s2 = await get(app, '/auth/login/oidc');
    const cb2 = await idp.authorize(s2.res.headers.get('location') as string);
    expect((await get(app, `${cb2.pathname}${cb2.search}`)).res.status).toBe(400);
  });

  it('an `error=` callback still consumes the state; code without valid state never reaches the IdP', async () => {
    const app = makeApp();
    const s = await get(app, '/auth/login/oidc');
    const cookie = (s.res.headers.get('set-cookie') ?? '').split(';')[0] as string;
    const cb = await idp.authorize(s.res.headers.get('location') as string);
    const state = cb.searchParams.get('state');
    expect(
      (await get(app, `/auth/callback/oidc?error=access_denied&state=${state}`, { cookie })).res.status,
    ).toBe(403);
    expect((await get(app, `${cb.pathname}${cb.search}`, { cookie })).res.status).toBe(400);
    const before = idp.tokenRequests.length;
    await get(app, '/auth/callback/oidc?code=x&state=nope', { cookie });
    expect(idp.tokenRequests.length).toBe(before);
  });

  it('Host / X-Forwarded-Host do not influence redirect_uri', async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request(`${PUBLIC}/auth/login/oidc`, {
        headers: {
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'http',
          forwarded: 'host=evil.example',
        },
      }),
    );
    const loc = new URL(res.headers.get('location') as string);
    expect(loc.searchParams.get('redirect_uri')).toBe(`${PUBLIC}/auth/callback/oidc`);
    const bad = await app.fetch(new Request('https://evil.example/auth/login/oidc'));
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });

  it('login-state cookie flags; callback clears it', async () => {
    await storage.users.create({ id: 'usr_1', email: 'owner@example.com', role: 'owner' });
    const app = makeApp();
    const { start, done } = await browserLogin(app, 'oidc');
    const sc = start.res.headers.get('set-cookie') as string;
    for (const f of ['__Host-rb_login=', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax'])
      expect(sc).toContain(f);
    expect(sc).not.toMatch(/Domain=/i);
    expect(
      done.res.headers
        .getSetCookie()
        .some((c) => c.startsWith('__Host-rb_login=;') && c.includes('Max-Age=0')),
    ).toBe(true);
  });

  it('logs and error pages never contain code, state, binding, id_token', async () => {
    await storage.users.create({ id: 'usr_1', email: 'owner@example.com', role: 'owner' });
    const app = makeApp();
    idp.idTokenClaims = { nonce: 'wrong' };
    const { callback, cookie, done } = await browserLogin(app, 'oidc');
    expect(done.res.status).toBe(403);
    const state = callback.searchParams.get('state') as string;
    const code = callback.searchParams.get('code') as string;
    const all = `${logs.join('\n')}\n${bodies.join('\n')}\n${JSON.stringify(await storage.auditLog.list({ limit: 100 }))}`;
    for (const secret of [state, code, cookie.split('=')[1] as string, 'eyJ'])
      expect(all).not.toContain(secret);
  });
});

describe('P4-07 review: setup links', () => {
  async function issue(app: App) {
    const res = await app.fetch(
      new Request(`${PUBLIC}/api/admin/v1/setup-links`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    return ((await res.json()) as { data: { url: string } }).data.url;
  }

  it('truly concurrent completions on one link: exactly one owner', async () => {
    const app = makeApp();
    const search = new URL(await issue(app)).search;
    const starts = [];
    const callbacks: { path: string; cookie: string }[] = [];
    for (let i = 0; i < 6; i++) {
      idp.user = { sub: `u-${i}`, email: `user${i}@example.com`, email_verified: true };
      const s = await get(app, `/auth/login/oidc${search}`);
      expect(s.res.status).toBe(302);
      starts.push(s);
      const cb = await idp.authorize(s.res.headers.get('location') as string);
      callbacks.push({
        path: `${cb.pathname}${cb.search}`,
        cookie: (s.res.headers.get('set-cookie') ?? '').split(';')[0] as string,
      });
    }
    const results = await Promise.all(callbacks.map((c) => get(app, c.path, { cookie: c.cookie })));
    expect(results.filter((r) => r.res.status === 303)).toHaveLength(1);
    expect((await storage.users.list()).filter((u) => u.role === 'owner')).toHaveLength(1);
  });

  it('the setup code is not reflected into the login-start response or the sign-in chooser href unvalidated', async () => {
    const app = makeApp();
    const page = await get(app, `/auth/login?setup=rb_setup_${'0'.repeat(64)}&next=/admin`);
    expect(page.res.headers.get('cache-control')).toBe('no-store');
    expect(page.text).toContain('same-origin');
    const start = await get(app, '/auth/login/oidc');
    expect(start.res.headers.get('location')).not.toContain('setup');
  });

  // Finding I1 (accepted): the link is used up before the user decision, so a denied sign-in (disabled user,
  // identity_conflict) burns it. Fails closed; the owner issues a new link.
  it('a denied sign-in uses up the setup link (fails closed)', async () => {
    await storage.users.create({ id: 'usr_x', email: 'owner@example.com', role: 'member' });
    await storage.users.update('usr_x', { disabledAt: Date.now() });
    const app = makeApp();
    const url = await issue(app);
    const search = new URL(url).search;
    const { done } = await browserLogin(app, 'oidc', search);
    expect(done.res.status).toBe(403);
    expect((await get(app, `/auth/login/oidc${search}`)).res.status).not.toBe(302);
  });
});

describe('P4-07 review: unauthenticated cost', () => {
  // Finding L4 (fixed): every sign-in start stores a login state; a separate per-IP sign-in limit bounds them.
  it('fix: sign-in requests have their own per-IP limit (default 60 per 5 min), so login states stay bounded', async () => {
    const hooks = createRateLimitHooks({
      limiter: new MemoryRateLimiter(),
      preAuthLimiter: new MemoryRateLimiter(),
      getClientIp: () => '203.0.113.9',
    });
    const app = makeApp({ hooks });
    const statuses: number[] = [];
    for (let i = 0; i < 70; i++) statuses.push((await get(app, '/auth/login/oidc')).res.status);
    expect(statuses.filter((s) => s === 302)).toHaveLength(60);
    expect(statuses.at(-1)).toBe(429);
    const rows = await storage.kv.list({ prefix: 'login:' });
    expect(rows.keys).toHaveLength(60);
    // Other routes are not charged by it.
    expect((await get(app, '/health')).res.status).not.toBe(429);
  });

  it('/auth/login (chooser) writes no kv row', async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++) await get(app, '/auth/login');
    const rows = (await storage.kv.list({ prefix: 'login:' })) as unknown as { keys?: unknown[] };
    expect(rows.keys?.length ?? 0).toBe(0);
  });
});
