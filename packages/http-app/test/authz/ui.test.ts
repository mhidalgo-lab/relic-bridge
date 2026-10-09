// SPDX-License-Identifier: Apache-2.0
// Admin UI pages in the authorization matrix (P4-03, THREAT_MODEL T13/T14), on the HTTP app and (P3-06 host) the
// Worker: only a live admin session renders a page; every other caller is sent to sign-in without a byte of the page;
// cross-site subresource requests are refused; every HTML answer carries the UI's CSP and headers.

import { ASSET_CACHE_CONTROL, ASSETS, PERMISSIONS_POLICY, UI_CSP } from '@relic-bridge/admin-ui';
import { revokeSession } from '@relic-bridge/auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeHooks } from '../../src/index.ts';
import { NR_KEY, T0 } from '../fixtures.ts';
import {
  ADMIN_TOKEN,
  authzHostKind,
  type Captured,
  createHarness,
  type Harness,
  PUBLIC_ORIGIN,
} from './harness.ts';
import { ADMIN_PRINCIPALS, UI_ASSET_ROUTES, UI_ROUTES } from './matrix.ts';

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.scan();
});

const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  h.send(new Request(`${PUBLIC_ORIGIN}${path}`, { method, headers }));

/** What a browser sends for a same-origin navigation with the session. */
const navigation = (cookie: string): Record<string, string> => ({
  cookie,
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
});

function expectSignInRedirect(res: Captured, next: string, what: string) {
  expect(res.status, what).toBe(303);
  expect(res.headers.get('location'), what).toBe(`/auth/login?${new URLSearchParams({ next })}`);
  expect(res.text, what).toBe('');
}

function expectUiHeaders(res: Captured, what: string) {
  expect(res.headers.get('content-type'), what).toBe('text/html; charset=utf-8');
  expect(res.headers.get('content-security-policy'), what).toBe(UI_CSP);
  expect(res.headers.get('cross-origin-opener-policy'), what).toBe('same-origin');
  expect(res.headers.get('permissions-policy'), what).toBe(PERMISSIONS_POLICY);
  expect(res.headers.get('x-frame-options'), what).toBe('DENY');
  expect(res.headers.get('x-content-type-options'), what).toBe('nosniff');
  expect(res.headers.get('referrer-policy'), what).toBe('no-referrer');
  expect(res.headers.get('cache-control'), what).toBe('no-store');
  expect(res.text.startsWith('<!doctype html><html lang="en">'), what).toBe(true);
}

describe('admin UI × principals (P4-03)', () => {
  /** Everything that is not a live session cookie: none of it opens a page. */
  const strangers = (): { name: string; headers: Record<string, string>; query?: string }[] => [
    { name: 'nothing', headers: {} },
    { name: 'admin token as bearer', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
    { name: 'MCP token as bearer', headers: { authorization: `Bearer ${h.world.tokens.prod}` } },
    { name: 'New Relic key as bearer', headers: { authorization: `Bearer ${NR_KEY}` } },
    { name: 'admin token in a cookie', headers: { cookie: `rb_admin=${ADMIN_TOKEN}; token=${ADMIN_TOKEN}` } },
    {
      name: 'credentials in the query',
      headers: {},
      query: `token=${ADMIN_TOKEN}&access_token=${ADMIN_TOKEN}`,
    },
  ];

  it('callers without a session get the sign-in redirect on every UI route, and no audit row', async () => {
    for (const route of UI_ROUTES) {
      for (const caller of strangers()) {
        const path = `${route.path}${caller.query ? `?${caller.query}` : ''}`;
        const res = await get(path, caller.headers);
        expectSignInRedirect(res, path, `${route.path} ${caller.name}`);
        expect(res.headers.get('set-cookie'), caller.name).toBeNull();
      }
    }
    expect(await h.auditRows()).toEqual([]);
  });

  it('every broken session is sent to sign-in, its cookie cleared, an auth.denied row written', async () => {
    const sessionPrincipals = ADMIN_PRINCIPALS.filter((p) => p.reason.startsWith('session_'));
    expect(sessionPrincipals.length).toBeGreaterThanOrEqual(8);
    for (const route of UI_ROUTES) {
      for (const principal of sessionPrincipals) {
        const presented = await principal.present(h);
        const res = await get(route.path, { cookie: presented.headers['cookie'] as string });
        const what = `${route.path} ${principal.name}`;
        expectSignInRedirect(res, route.path, what);
        expect(res.headers.get('set-cookie'), what).toMatch(/^rb_session=; Path=\/; Max-Age=0; HttpOnly/);
        const row = await h.deniedRow(res.requestId as string);
        expect(row, what).toMatchObject({ kind: 'auth', status: 'denied', errorCode: principal.reason });
      }
    }
  });

  it('a session cookie under the __Host- name on http is no session at all', async () => {
    const s = await h.addSession();
    const res = await get('/admin', { cookie: `__Host-rb_session=${s.value}` });
    expectSignInRedirect(res, '/admin', 'host-prefixed');
  });

  it('a revoked session stops at once', async () => {
    const s = await h.addSession({ role: 'owner' });
    expect((await get('/admin', navigation(s.cookie))).status).toBe(200);
    await revokeSession(h.world.storage.kv, s.value);
    expectSignInRedirect(await get('/admin', navigation(s.cookie)), '/admin', 'revoked');
  });

  it('positive control: every role sees the overview; admins also see users through the admin API', async () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      const s = await h.addSession({ role });
      const res = await get('/admin', navigation(s.cookie));
      expect(res.status, role).toBe(200);
      expectUiHeaders(res, role);
      expect(res.text).toContain('<h1>Overview</h1>');
      expect(res.text).toContain(`(${role})`);
      // Both sign-out forms carry this session's CSRF token, and nothing else of the session.
      expect(res.text.split(`name="_csrf" value="${s.csrf}"`).length - 1).toBe(3);
      expect(res.text).not.toContain(s.value);
      expect(res.text.includes('<caption>Users (first 5)</caption>'), role).toBe(role !== 'member');
    }
    // The admin API call ran as the session: no refusal, no admin-token use.
    const rows = await h.auditRows();
    expect(rows.filter((r) => r.status === 'denied')).toEqual([]);
  });

  it('the bearer token next to a session neither helps nor hurts: pages look at the cookie only', async () => {
    const s = await h.addSession({ role: 'member' });
    const res = await get('/admin', { ...navigation(s.cookie), authorization: `Bearer ${ADMIN_TOKEN}` });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<caption>Users');
  });

  it('a disabled user is signed out on the next page', async () => {
    const s = await h.addSession({ role: 'admin' });
    await h.world.storage.users.update(s.userId, { disabledAt: T0 });
    expectSignInRedirect(await get('/admin', navigation(s.cookie)), '/admin', 'disabled');
  });

  it('keeps the page and query in next; the sign-in page only accepts same-origin paths', async () => {
    const res = await get('/admin/some/page?tab=2&x=%2F%2Fevil.example');
    expectSignInRedirect(res, '/admin/some/page?tab=2&x=%2F%2Fevil.example', 'deep link');
    for (const next of [
      '//evil.example/admin',
      'https://evil.example/',
      '/\\evil.example',
      'javascript:alert(1)',
    ]) {
      const login = await get(`/auth/login?${new URLSearchParams({ next })}`);
      expect(login.status).toBe(200);
      expect(login.text).not.toContain('evil');
      expect(login.text).not.toContain('javascript');
    }
  });

  it('signed-in requests to unknown UI paths get the 404 page; HEAD and POST too', async () => {
    const s = await h.addSession({ role: 'member' });
    for (const method of ['GET', 'HEAD', 'POST']) {
      const res = await get('/admin/no-such-page', navigation(s.cookie), method);
      expect(res.status, method).toBe(404);
      if (method !== 'HEAD') {
        expectUiHeaders(res, method);
        expect(res.text).toContain('<h1>Page not found</h1>');
      }
    }
  });
});

describe.skipIf(authzHostKind() !== 'http-app')('admin UI pre-authentication hook (P4-03)', () => {
  it('runs with the admin_session scope before the session is read; a refusal is audited', async () => {
    const scopes: string[] = [];
    const app = h.makeApp({
      hooks: mergeHooks(h.recorderHooks, {
        beforeAuth: (_c, _id, scope) => {
          scopes.push(scope);
          return scope === 'admin_session'
            ? new Response('{"error":"rate_limited"}', { status: 429 })
            : undefined;
        },
      }),
    });
    const s = await h.addSession({ role: 'owner' });
    const res = await h.send(new Request(`${PUBLIC_ORIGIN}/admin`, { headers: navigation(s.cookie) }), app);
    expect(res.status).toBe(429);
    expect(scopes).toEqual(['admin_session']);
    const rows = await h.auditRows();
    expect(rows.map((r) => `${r.kind}:${r.action}`)).toEqual(['auth:request.rejected']);
  });
});

describe('admin UI fetch metadata (P4-03)', () => {
  it('cross-site subresource and fetch requests are refused before the session is looked at', async () => {
    const s = await h.addSession({ role: 'owner' });
    for (const [mode, dest] of [
      ['no-cors', 'script'],
      ['no-cors', 'image'],
      ['cors', 'empty'],
      ['navigate', 'iframe'],
      ['no-cors', 'style'],
    ]) {
      for (const site of ['cross-site', 'same-site']) {
        const res = await get('/admin', {
          cookie: s.cookie,
          'sec-fetch-site': site,
          'sec-fetch-mode': mode as string,
          'sec-fetch-dest': dest as string,
        });
        expect(res.status, `${site} ${mode} ${dest}`).toBe(403);
        expectUiHeaders(res, `${site} ${mode} ${dest}`);
        expect(res.text).not.toContain(s.csrf);
      }
    }
    // A link from mail or chat (a cross-site top-level navigation) opens the page.
    const link = await get('/admin', {
      cookie: s.cookie,
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    });
    expect(link.status).toBe(200);
    // Typed URL or bookmark.
    expect((await get('/admin', { cookie: s.cookie, 'sec-fetch-site': 'none' })).status).toBe(200);
  });
});

describe('admin UI headers on every HTML page (P4-03)', () => {
  it('UI, sign-in, sign-in failure, sign-out refusal and error pages all carry the UI CSP', async () => {
    const s = await h.addSession({ role: 'owner' });
    const pages: [string, Captured][] = [
      ['overview', await get('/admin', navigation(s.cookie))],
      ['ui 404', await get('/admin/nope', navigation(s.cookie))],
      ['sign-in', await get('/auth/login')],
      ['sign-in with setup', await get(`/auth/login?setup=rb_setup_${'0'.repeat(64)}`)],
      ['callback failure', await get('/auth/callback/github')],
      ['access failure', await get('/auth/cf-access')],
      ['asset 404', await get('/admin/assets/nope.css')],
      [
        'cross-site refusal',
        await get('/admin', { cookie: s.cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'script' }),
      ],
      [
        'sign-out refusal',
        await h.send(
          new Request(`${PUBLIC_ORIGIN}/auth/logout`, {
            method: 'POST',
            headers: { cookie: s.cookie, 'content-type': 'application/x-www-form-urlencoded' },
            body: '_csrf=wrong',
          }),
        ),
      ],
    ];
    for (const [what, res] of pages) {
      expectUiHeaders(res, what);
      expect(res.text, what).not.toMatch(/<script(?![^>]*\bsrc=)/);
      expect(res.text, what).not.toMatch(/\sstyle=|<style|\son[a-z]+=/i);
    }
  });

  it('no response from the app carries a CSP with unsafe-inline or unsafe-eval', async () => {
    const s = await h.addSession({ role: 'owner' });
    for (const path of ['/admin', '/auth/login', '/health', '/api/admin/v1/session', '/admin/assets/x']) {
      const res = await get(path, navigation(s.cookie));
      expect(res.headers.get('content-security-policy'), path).not.toMatch(/unsafe-/);
      expect(res.headers.get('content-security-policy'), path).toMatch(/frame-ancestors 'none'/);
    }
  });

  it('JSON routes keep the JSON-only policy', async () => {
    const res = await get('/health');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
  });
});

describe('admin UI assets (P4-03)', () => {
  it('serves the hashed stylesheet and script to anyone, immutable, with the right types', async () => {
    for (const asset of Object.values(ASSETS)) {
      const res = await get(`/admin/assets/${asset.file}`);
      expect(res.status).toBe(200);
      expect(res.text).toBe(asset.body);
      expect(res.headers.get('content-type')).toBe(asset.type);
      expect(res.headers.get('cache-control')).toBe(ASSET_CACHE_CONTROL);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    expect(await h.auditRows()).toEqual([]);
  });

  it('unknown or path-like names are a 404 that is never cached', async () => {
    for (const name of [
      'nope.css',
      'admin.css',
      encodeURIComponent('../admin.css'),
      `${ASSETS.css.file}x`,
      encodeURIComponent(`/${ASSETS.css.file}`),
    ]) {
      const res = await get(`/admin/assets/${name}`);
      expect(res.status, name).toBe(404);
      expect(res.headers.get('cache-control'), name).toBe('no-store');
    }
    expect(UI_ASSET_ROUTES.length).toBe(1);
  });
});
