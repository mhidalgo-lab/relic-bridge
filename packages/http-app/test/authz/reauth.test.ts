// SPDX-License-Identifier: Apache-2.0
// Re-authentication for sensitive admin actions (P8-73, THREAT_MODEL T13/T14): a session whose sign-in is older than
// the window (default 10 minutes) gets one `403 forbidden` / `reauth_required` on every sensitive route, audited, and
// nothing changes; a fresh sign-in (a new session, as `/auth/callback` creates) succeeds; non-sensitive routes and the
// member self-service routes are unaffected; the admin token is exempt. Runs on Node (memory) and in workerd (D1).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_TOKEN,
  type Captured,
  createHarness,
  type Harness,
  NR_KEY_ADMIN,
  PUBLIC_ORIGIN,
} from './harness.ts';
import { ADMIN_ROUTES } from './matrix.ts';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.scan();
});

const MINUTE = 60_000;
/** Past the default 10-minute window, well inside the 30-minute idle timeout. */
const STALE = 11 * MINUTE;

type Who = { readonly headers: Readonly<Record<string, string>> };
const TOKEN: Who = { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } };
const call = (who: Who, method: string, path: string, body?: unknown) =>
  h.send(
    new Request(`${PUBLIC_ORIGIN}/api/admin/v1${path}`, {
      method,
      headers: { ...who.headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const errorOf = (r: Captured) => JSON.parse(r.text).error as Record<string, unknown> | undefined;

const importBody = ADMIN_ROUTES.find((r) => r.pattern.endsWith('/config/import'))?.body;

interface Action {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

/** Every sensitive action, on targets that exist (so a fresh session reaches the handler's effect). */
async function sensitiveActions(): Promise<Action[]> {
  const bound = await h.addUser('bound@example.com', 'admin');
  await h.world.storage.users.update(bound, { idp: 'github', idpSubject: '4242' });
  const member = await h.addUser('member-r@example.com', 'member');
  const other = await h.addUser('other-r@example.com', 'member');
  const signedOut = await h.addUser('signed-out@example.com', 'member');
  const credential = await h.addCredential();
  const project = await h.addProject('reauth-target');
  const { grantId } = await h.addTenant('reauth-tokens');
  return [
    { name: 'keys rotate', method: 'POST', path: '/keys/rotate', body: {} },
    { name: 'config import', method: 'POST', path: '/config/import', body: importBody },
    { name: 'setup link', method: 'POST', path: '/setup-links', body: {} },
    {
      name: 'unbind',
      method: 'POST',
      path: `/users/${bound}/unbind`,
      body: { confirm: 'bound@example.com' },
    },
    { name: 'oauth client remove', method: 'POST', path: '/oauth/clients/remove', body: { clientId: 'x' } },
    { name: 'oauth registration', method: 'POST', path: '/oauth/registration', body: { enabled: false } },
    {
      name: 'credential rotate',
      method: 'POST',
      path: `/credentials/${credential}/rotate`,
      body: { apiKey: NR_KEY_ADMIN },
    },
    { name: 'project delete', method: 'DELETE', path: `/projects/${project}` },
    {
      name: 'create admin',
      method: 'POST',
      path: '/users',
      body: { email: 'new-admin@example.com', role: 'admin' },
    },
    {
      name: 'create owner',
      method: 'POST',
      path: '/users',
      body: { email: 'new-owner@example.com', role: 'owner' },
    },
    { name: 'promote', method: 'PATCH', path: `/users/${member}`, body: { role: 'admin' } },
    { name: 'disable', method: 'PATCH', path: `/users/${other}`, body: { disabled: true } },
    { name: 'sign out another user', method: 'POST', path: `/users/${signedOut}/sessions/revoke` },
    {
      name: 'end every user session',
      method: 'POST',
      path: '/users/sessions/revoke-all',
      body: { confirm: 'end all sessions' },
    },
    {
      name: 'token never expires',
      method: 'POST',
      path: '/tokens',
      body: { grantId, label: 'a', ttlSeconds: 'never' },
    },
    {
      name: 'token above 90 days',
      method: 'POST',
      path: '/tokens',
      body: { grantId, label: 'b', ttlSeconds: 90 * 86_400 + 1 },
    },
  ];
}

describe('re-authentication for sensitive admin actions (P8-73)', () => {
  it('a stale session is refused on every sensitive route with one body, audited, and nothing changes', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const actions = await sensitiveActions();
    h.world.clock.advance(STALE);
    const usersBefore = JSON.stringify(
      (await h.world.storage.users.list()).map((u) => [u.id, u.role, u.disabledAt, u.idp]),
    );
    const tokensBefore = (await h.world.storage.accessTokens.list()).length;

    const bodies = new Set<string>();
    for (const a of actions) {
      const res = await call(owner, a.method, a.path, a.body);
      expect(res.status, a.name).toBe(403);
      expect(errorOf(res), a.name).toMatchObject({ code: 'forbidden', detail: 'reauth_required' });
      bodies.add(res.text);
    }
    expect(bodies.size).toBe(1);

    expect(
      JSON.stringify((await h.world.storage.users.list()).map((u) => [u.id, u.role, u.disabledAt, u.idp])),
    ).toBe(usersBefore);
    expect((await h.world.storage.accessTokens.list()).length).toBe(tokensBefore);
    const kv = (await h.world.storage.kv.list({ limit: 1000 })).keys.map((k) => k.name);
    expect(kv.some((k) => k.startsWith('setup:'))).toBe(false);

    const rows = (await h.auditRows()).filter(
      (r) => r.status === 'denied' && r.details?.['reason'] === 'reauth_required',
    );
    expect(rows).toHaveLength(actions.length);
    for (const row of rows) expect(row.userId).toBe(owner.userId);
  });

  it('after a fresh sign-in (a new session) the same actions go through', async () => {
    const stale = await h.addSession({ role: 'owner' });
    const actions = await sensitiveActions();
    h.world.clock.advance(STALE);
    const fresh = await h.addSession({ userId: stale.userId });
    // "End every user's sessions" signs the stale session out for good, so it runs last, below.
    const endAll = actions.find((a) => a.name === 'end every user session') as Action;
    for (const a of actions.filter((x) => x !== endAll)) {
      const res = await call(fresh, a.method, a.path, a.body);
      expect(res.status, `${a.name}: ${res.text.slice(0, 200)}`).not.toBe(403);
      expect(res.status, `${a.name}: ${res.text.slice(0, 200)}`).toBeLessThan(500);
    }
    // The window is the session's own sign-in time: the stale session is still refused next to the fresh one.
    expect(errorOf(await call(stale, 'POST', '/keys/rotate', {}))?.['detail']).toBe('reauth_required');
    expect(errorOf(await call(stale, endAll.method, endAll.path, endAll.body))?.['detail']).toBe(
      'reauth_required',
    );
    const done = await call(fresh, endAll.method, endAll.path, endAll.body);
    expect(done.status, done.text).toBe(200);
  });

  it('the window boundary: allowed just inside it, refused at it', async () => {
    const owner = await h.addSession({ role: 'owner' });
    h.world.clock.advance(10 * MINUTE - 1000);
    expect((await call(owner, 'POST', '/setup-links', {})).status).toBe(201);
    h.world.clock.advance(1000);
    expect(errorOf(await call(owner, 'POST', '/setup-links', {}))?.['detail']).toBe('reauth_required');
  });

  it('nothing the client sends makes a stale session fresh', async () => {
    const owner = await h.addSession({ role: 'owner' });
    h.world.clock.advance(STALE);
    const res = await h.send(
      new Request(`${PUBLIC_ORIGIN}/api/admin/v1/keys/rotate?reauth=1&fresh=1`, {
        method: 'POST',
        headers: {
          ...owner.headers,
          'content-type': 'application/json',
          'x-reauth': '1',
          date: new Date(h.world.clock.now() - STALE).toUTCString(),
        },
        body: JSON.stringify({ authenticatedAt: h.world.clock.now(), reauth: true }),
      }),
    );
    expect(res.status).toBe(403);
    expect(errorOf(res)?.['detail']).toBe('reauth_required');
  });

  it('the admin token is exempt', async () => {
    const actions = await sensitiveActions();
    h.world.clock.advance(STALE);
    for (const a of actions) {
      const res = await call(TOKEN, a.method, a.path, a.body);
      expect(res.status, `${a.name}: ${res.text.slice(0, 200)}`).not.toBe(403);
      expect(res.status, a.name).toBeLessThan(500);
    }
  });

  it('non-sensitive routes are unaffected for a stale session', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const member = await h.addUser('plain@example.com', 'member');
    const { grantId } = await h.addTenant('reauth-plain');
    const project = await h.addProject('reauth-keep');
    h.world.clock.advance(STALE);
    const expectations: [string, string, unknown, number][] = [
      ['GET', '/users', undefined, 200],
      ['GET', '/session', undefined, 200],
      ['POST', '/users', { email: 'plain-new@example.com' }, 201],
      ['POST', '/users', { email: 'plain-new2@example.com', role: 'member' }, 201],
      ['PATCH', `/users/${member}`, { displayName: 'Plain' }, 200],
      ['POST', '/tokens', { grantId, label: 'default ttl' }, 201],
      ['POST', '/tokens', { grantId, label: '90 days', ttlSeconds: 90 * 86_400 }, 201],
      ['PATCH', `/projects/${project}`, { disabled: true }, 200],
      ['POST', `/users/${owner.userId}/sessions/revoke`, undefined, 200],
    ];
    for (const [method, path, body, status] of expectations) {
      const res = await call(owner, method, path, body);
      expect(res.status, `${method} ${path}: ${res.text.slice(0, 200)}`).toBe(status);
    }
  });

  it('member self-service (/me/*) is not sensitive: a stale member session keeps working', async () => {
    const member = await h.addSession({ role: 'member' });
    h.world.clock.advance(STALE);
    const added = await call(member, 'POST', '/me/credentials', {
      label: 'mine',
      region: 'US',
      apiKey: NR_KEY_ADMIN,
    });
    expect(added.status, added.text.slice(0, 200)).toBe(201);
    const id = (JSON.parse(added.text) as { data: { id: string } }).data.id;
    for (const [method, path, body] of [
      ['GET', '/me/credentials', undefined],
      ['PATCH', `/me/credentials/${id}`, { label: 'renamed' }],
      ['POST', `/me/credentials/${id}/rotate`, { apiKey: NR_KEY_ADMIN }],
      ['GET', '/me/tokens', undefined],
      ['DELETE', `/me/credentials/${id}`, undefined],
    ] as const) {
      const res = await call(member, method, path, body);
      expect(res.status, `${method} ${path}: ${res.text.slice(0, 200)}`).toBeLessThan(300);
    }
  });
});

describe('the admin UI sends a stale session through sign-in and back (P8-73)', () => {
  const formPost = (
    s: { readonly cookie: string; readonly csrf: string },
    path: string,
    fields: Record<string, string>,
    referer: string,
  ) =>
    h.send(
      new Request(`${PUBLIC_ORIGIN}${path}`, {
        method: 'POST',
        headers: {
          cookie: s.cookie,
          origin: PUBLIC_ORIGIN,
          ...(referer === '' ? {} : { referer }),
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ _csrf: s.csrf, ...fields }).toString(),
      }),
    );

  it('a promotion from the user page goes through sign-in and back to that page', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const member = await h.addUser('ui-member@example.com', 'member');
    const page = `/admin/users/${member}`;
    h.world.clock.advance(STALE);

    const refused = await formPost(
      owner,
      page,
      { displayName: '', role: 'admin' },
      `${PUBLIC_ORIGIN}${page}`,
    );
    expect(refused.status, refused.text.slice(0, 300)).toBe(303);
    const location = new URL(refused.headers.get('location') as string, PUBLIC_ORIGIN);
    expect(location.pathname).toBe('/auth/login');
    expect(location.searchParams.get('next')).toBe(page);
    expect(location.searchParams.get('reauth')).toBe('1');
    // The session is kept (no cookie cleared), the user is unchanged.
    expect(refused.headers.get('set-cookie')).toBeNull();
    expect((await h.world.storage.users.get(member))?.role).toBe('member');

    // The sign-in page explains why, and its provider links keep `next`.
    const login = await h.send(new Request(`${PUBLIC_ORIGIN}${location.pathname}${location.search}`));
    expect(login.status).toBe(200);
    expect(login.text).toContain('This change needs a recent sign-in');
    expect(login.text).toContain(`next=${encodeURIComponent(page)}`);

    // Signing in creates a new session for the same user: the same form now succeeds.
    const fresh = await h.addSession({ userId: owner.userId });
    const done = await formPost(fresh, page, { displayName: '', role: 'admin' }, `${PUBLIC_ORIGIN}${page}`);
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe(page);
    expect((await h.world.storage.users.get(member))?.role).toBe('admin');
  });

  it('a foreign, non-admin or missing Referer falls back to the overview', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const member = await h.addUser('ui-member2@example.com', 'member');
    h.world.clock.advance(STALE);
    for (const referer of ['https://elsewhere.example/admin/users', `${PUBLIC_ORIGIN}/auth/login`, '']) {
      const res = await formPost(
        owner,
        `/admin/users/${member}`,
        { displayName: '', role: 'admin' },
        referer,
      );
      expect(res.status).toBe(303);
      const location = new URL(res.headers.get('location') as string, PUBLIC_ORIGIN);
      expect(location.searchParams.get('next')).toBe('/admin');
    }
  });
});
