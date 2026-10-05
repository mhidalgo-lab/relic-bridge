// SPDX-License-Identifier: Apache-2.0
// The /admin sub-app and the kit (P4-03): page and form guards, CSRF-checked forms, flash, admin API calls, errors.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  ASSET_CACHE_CONTROL,
  ASSETS,
  adminPath,
  createUiKit,
  flashCookie,
  readFlash,
  UI_CSP,
} from '../src/index.ts';
import { fakeDeps, mount, ORIGIN, same, uiApp } from './fixtures.ts';

const req = (app: Hono, path: string, init: RequestInit = {}) => app.request(`${ORIGIN}${path}`, init);

/** The policy written out once on purpose: a loosened `UI_CSP` must fail here (P4-20, review Q1). */
const EXPECTED_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'";

describe('csp', () => {
  it('is the literal strict policy', () => {
    expect(UI_CSP).toBe(EXPECTED_CSP);
  });
});

describe('pages', () => {
  it('renders the overview for each role; only admins and owners load users through the admin API', async () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      const fake = fakeDeps();
      const res = await req(uiApp(fake), '/admin', { headers: same(role) });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
      const html = await res.text();
      expect(html).toContain(`${role}@example.com`);
      if (role === 'member') {
        expect(fake.calls).toEqual([]);
        expect(html).not.toContain('<table>');
      } else {
        expect(fake.calls).toEqual([{ method: 'GET', path: '/users', query: { limit: '5' } }]);
        expect(html).toContain('<td>b@example.com</td><td>member</td><td>disabled</td>');
      }
    }
  });

  it('says so when the admin API answers with an error', async () => {
    const fake = fakeDeps();
    fake.adminAnswer = () => ({ status: 503, body: { error: { code: 'unavailable' } } });
    const html = await (await req(uiApp(fake), '/admin', { headers: same('owner') })).text();
    expect(html).toContain('The user list could not be loaded.');
  });

  it('no session: sign-in redirect with next; a dead cookie is cleared', async () => {
    const app = uiApp(fakeDeps());
    const none = await req(app, '/admin?tab=1');
    expect(none.status).toBe(303);
    expect(none.headers.get('location')).toBe('/auth/login?next=%2Fadmin%3Ftab%3D1');
    expect(none.headers.get('set-cookie')).toBeNull();
    const dead = await req(app, '/admin', { headers: { cookie: 'rb_session=gone' } });
    expect(dead.headers.get('set-cookie')).toMatch(/^rb_session=; Path=\/; Max-Age=0/);
  });

  it('a throttled failure answers what the server says instead of the redirect', async () => {
    const fake = fakeDeps({
      authenticate: async () => ({
        ok: false,
        presented: true,
        response: new Response('slow down', { status: 429 }),
      }),
    });
    expect((await req(uiApp(fake), '/admin')).status).toBe(429);
  });

  it('the pre-auth hook can stop a request before the session is read', async () => {
    let looked = false;
    const fake = fakeDeps({
      beforeAuth: () => new Response('limited', { status: 429 }),
      authenticate: async () => {
        looked = true;
        return { ok: false, presented: false };
      },
    });
    expect((await req(uiApp(fake), '/admin')).status).toBe(429);
    expect(looked).toBe(false);
  });

  it('a page above the viewer’s role is a 403 page and an audited refusal', async () => {
    const fake = fakeDeps();
    const kit = createUiKit(fake.deps);
    const ui = new Hono();
    ui.get(
      '/owners',
      kit.page('owner', (_c, page) => page.html('ok' as never)),
    );
    const res = await req(mount(ui), '/admin/owners', { headers: same('admin') });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
    expect(fake.forbidden).toEqual(['admin:role']);
  });

  it('errors render the generic 500 page: no message, no stack', async () => {
    const fake = fakeDeps();
    fake.adminAnswer = () => {
      throw new Error('secret detail at /srv/app.ts:12');
    };
    const res = await req(uiApp(fake), '/admin', { headers: same('owner') });
    expect(res.status).toBe(500);
    const html = await res.text();
    expect(html).toContain('Something went wrong');
    expect(html).toContain('00000000-0000-4000-8000-000000000000');
    expect(html).not.toMatch(/secret detail|app\.ts|at \//);
    expect(fake.errors).toHaveLength(1);
  });
});

describe('assets', () => {
  it('serves exactly the generated assets with their types and immutable caching', async () => {
    const app = uiApp(fakeDeps());
    for (const asset of Object.values(ASSETS)) {
      const res = await req(app, `/admin/assets/${asset.file}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(asset.type);
      expect(res.headers.get('cache-control')).toBe(ASSET_CACHE_CONTROL);
      const body = await res.text();
      expect(body).toBe(asset.body);
      const digest = await crypto.subtle.digest('SHA-384', new TextEncoder().encode(body));
      expect(asset.integrity).toBe(`sha384-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`);
    }
    expect((await req(app, '/admin/assets/admin.css')).status).toBe(404);
  });
});

describe('forms', () => {
  function formApp() {
    const fake = fakeDeps();
    const kit = createUiKit({ ...fake.deps, maxFormBytes: 1024 });
    const seen: string[] = [];
    const ui = new Hono();
    ui.post(
      '/things',
      kit.form('admin', async (c, principal, form) => {
        seen.push(form.fields.get('label') ?? '');
        expect(form.fields.has('_csrf')).toBe(false);
        await kit.callAdmin(c, principal, { method: 'POST', path: '/things', body: { label: 'x' } }, form);
        return kit.redirect('/admin/things', 'saved');
      }),
    );
    // A handler that forgets the form: the kit refuses the change.
    ui.post(
      '/careless',
      kit.form('member', async (c, principal) => {
        await kit.callAdmin(c, principal, { method: 'DELETE', path: '/things/1' });
        return kit.redirect('/admin');
      }),
    );
    ui.onError((error) => {
      fake.errors.push(error);
      return new Response(null, { status: 500 });
    });
    return { app: mount(ui), fake, seen, kit };
  }
  const post = (body: string, headers: Record<string, string>) => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body,
  });
  const csrf = (role: string) => `${role.toUpperCase()}-${'c'.repeat(37)}`;

  it('accepts a same-origin post with the right token, then redirects with a flash', async () => {
    const { app, fake, seen } = formApp();
    const res = await req(
      app,
      '/admin/things',
      post(`_csrf=${csrf('admin')}&label=a%26b`, same('admin', { origin: ORIGIN })),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/things');
    expect(res.headers.get('set-cookie')).toBe('rb_flash=saved; Path=/; Max-Age=60; HttpOnly; SameSite=Lax');
    expect(seen).toEqual(['a&b']);
    expect(fake.calls).toEqual([{ method: 'POST', path: '/things', body: { label: 'x' } }]);
  });

  it('refuses missing, wrong, repeated and other sessions’ tokens; foreign origins; cross-site posts', async () => {
    const { app, fake, seen } = formApp();
    const cases: [string, Record<string, string>, string][] = [
      ['label=x', same('admin', { origin: ORIGIN }), 'csrf'],
      ['_csrf=wrong&label=x', same('admin', { origin: ORIGIN }), 'csrf'],
      [`_csrf=${csrf('owner')}&label=x`, same('admin', { origin: ORIGIN }), 'csrf'],
      [`_csrf=${csrf('admin')}&_csrf=${csrf('admin')}`, same('admin', { origin: ORIGIN }), 'csrf'],
      [`_csrf=${csrf('admin')}`, same('admin', { origin: 'https://evil.example' }), 'origin_mismatch'],
      [
        `_csrf=${csrf('admin')}`,
        { cookie: 'rb_session=admin', 'sec-fetch-site': 'cross-site' },
        'cross_site',
      ],
      [`_csrf=${csrf('admin')}`, { cookie: 'rb_session=admin', 'sec-fetch-site': 'same-site' }, 'cross_site'],
      [`_csrf=${csrf('admin')}`, { cookie: 'rb_session=admin' }, 'origin_missing'],
      [`_csrf=${csrf('member')}`, same('member', { origin: ORIGIN }), 'role'],
    ];
    for (const [body, headers] of cases) {
      const res = await req(app, '/admin/things', post(body, headers));
      expect(res.status, body).toBe(403);
      expect(res.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
    }
    expect(fake.forbidden).toEqual(
      cases.map(
        ([, headers, reason]) => `${/rb_session=(\w+)/.exec(headers['cookie'] as string)?.[1]}:${reason}`,
      ),
    );
    expect(seen).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('refuses other body types and oversized bodies (declared or streamed)', async () => {
    const { app, seen } = formApp();
    const ok = same('admin', { origin: ORIGIN });
    const json = await req(app, '/admin/things', {
      method: 'POST',
      headers: { ...ok, 'content-type': 'application/json' },
      body: JSON.stringify({ _csrf: csrf('admin') }),
    });
    expect(json.status).toBe(415);
    const big = `_csrf=${csrf('admin')}&pad=${'x'.repeat(2048)}`;
    expect((await req(app, '/admin/things', post(big, ok))).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const streamed = await req(app, '/admin/things', {
      method: 'POST',
      headers: { ...ok, 'content-type': 'application/x-www-form-urlencoded' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(streamed.status).toBe(413);
    expect(seen).toEqual([]);
  });

  it('an unauthenticated post goes to sign-in without being read', async () => {
    const { app } = formApp();
    const res = await req(
      app,
      '/admin/things',
      post('label=x', { 'sec-fetch-site': 'same-origin', origin: ORIGIN }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/auth/login?next=%2Fadmin');
  });

  it('callAdmin refuses changes without the verified form of the same request', async () => {
    const { app, fake } = formApp();
    const res = await req(
      app,
      '/admin/careless',
      post(`_csrf=${csrf('member')}`, same('member', { origin: ORIGIN })),
    );
    expect(res.status).toBe(500);
    expect(fake.calls).toEqual([]);
    expect(String(fake.errors[0])).toContain('verified form');
  });
});

describe('helpers', () => {
  it('adminPath encodes every value as one path segment', () => {
    expect(adminPath`/users/${'usr_1'}/sessions/revoke`).toBe('/users/usr_1/sessions/revoke');
    expect(adminPath`/users/${'../keys/rotate'}`).toBe('/users/..%2Fkeys%2Frotate');
    expect(adminPath`/tokens/${'a?b#c'}`).toBe('/tokens/a%3Fb%23c');
    for (const bad of ['', '.', '..'])
      expect(() => adminPath`/users/${bad}/sessions/revoke`, bad).toThrow(TypeError);
  });

  it('flash cookies carry known codes only', () => {
    expect(readFlash(undefined, false)).toEqual({ present: false, message: null });
    expect(readFlash('rb_flash=saved', false).message?.text).toBe('Saved.');
    expect(readFlash('a=1; rb_flash=<script>', false)).toEqual({ present: true, message: null });
    expect(readFlash('rb_flash=toString', false)).toEqual({ present: true, message: null });
    expect(readFlash('__Host-rb_flash=saved', true).message?.kind).toBe('success');
    expect(flashCookie('saved', true)).toBe(
      '__Host-rb_flash=saved; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure',
    );
  });

  it('a page shows the flash once and clears it', async () => {
    const res = await req(uiApp(fakeDeps()), '/admin', {
      headers: same('member', { cookie: 'rb_session=member; rb_flash=revoked' }),
    });
    const html = await res.text();
    expect(html).toContain('<div class="flash flash-success" role="status">Revoked.</div>');
    expect(res.headers.get('set-cookie')).toBe('rb_flash=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    const plain = await req(uiApp(fakeDeps()), '/admin', { headers: same('member') });
    expect(plain.headers.get('set-cookie')).toBeNull();
  });

  it('redirects stay on this site', () => {
    const kit = createUiKit(fakeDeps().deps);
    expect(() => kit.redirect('//evil.example')).toThrow(TypeError);
    expect(() => kit.redirect('https://evil.example')).toThrow(TypeError);
    expect(() => createUiKit({ ...fakeDeps().deps, maxFormBytes: 10 })).toThrow(RangeError);
  });
});
