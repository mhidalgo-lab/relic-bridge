// SPDX-License-Identifier: Apache-2.0
// P4-07 security review, sessions, CSRF, roles and authorization (P4-02, P4-05 API): regression tests for the findings
// fixed in the review ("fix:") and the attacks probed that hold. Report: docs/reviews/phase-4-admin-security-review.md.
import { INSECURE_SESSION_COOKIE, loadSession, SESSION_COOKIE } from '@relic-bridge/auth';
import { silentLogger } from '@relic-bridge/core';
import { createMemoryStorage } from '@relic-bridge/storage';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSessionManager, type SessionManager } from '../src/index.ts';
import { type Captured, createHarness, type Harness, PUBLIC_ORIGIN } from './authz/harness.ts';
import { ManualClock, T0 } from './fixtures.ts';

const A = '/api/admin/v1';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.scan();
});

type Hdrs = Readonly<Record<string, string>>;
const call = (method: string, path: string, headers: Hdrs, body?: unknown, extra: Hdrs = {}) =>
  h.send(
    new Request(`${PUBLIC_ORIGIN}${path}`, {
      method,
      headers: {
        ...headers,
        ...extra,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
// biome-ignore lint/suspicious/noExplicitAny: probe answers are walked loosely
const j = (r: Captured) => JSON.parse(r.text) as Record<string, any>;

// ------------------------------------------------------------------------------------------------ cookies / manager
describe('session cookie and fixation (manager level)', () => {
  const build = (publicUrl: string) => {
    const storage = createMemoryStorage({ now: () => T0 });
    const clock = new ManualClock();
    const user = { id: 'usr_v', email: 'v@example.com', role: 'owner', disabledAt: null } as never;
    const mgr: SessionManager = createSessionManager({
      publicUrl,
      kv: storage.kv,
      users: { get: async () => user },
      clock,
      logger: silentLogger,
      runInBackground: () => undefined,
    });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('requestId' as never, 'r1' as never);
      await next();
    });
    app.post('/login', (c) =>
      mgr.login(c, {
        user,
        provider: 'github',
        identity: { idp: 'github' },
        outcome: 'existing',
        next: '/admin',
      } as never),
    );
    return { mgr, app, storage, clock };
  };

  it('https: __Host- cookie, Secure, HttpOnly, SameSite, Path=/, no Domain; server stores only the hash', async () => {
    const { app, storage } = build('https://rb.example.com');
    const res = await app.request('/login', { method: 'POST' });
    const sc = res.headers.get('set-cookie') as string;
    expect(sc.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(sc).toMatch(/; Path=\//);
    expect(sc).toMatch(/; HttpOnly/);
    expect(sc).toMatch(/; Secure/);
    expect(sc).toMatch(/; SameSite=Lax/);
    expect(sc).not.toMatch(/Domain=/i);
    const value = sc.split(';')[0]?.split('=')[1] as string;
    const secret = value.split('.').pop() as string;
    expect(secret).toHaveLength(43);
    const keys = (await storage.kv.list({ prefix: 'sess' })).keys.map((k) => k.name);
    expect(keys.length).toBe(2);
    for (const k of keys) {
      expect(k).not.toContain(secret);
      expect(await storage.kv.get(k)).not.toContain(secret);
    }
  });

  it('http loopback: rb_session without Secure (documented), still HttpOnly', async () => {
    const { app } = build('http://localhost:8787');
    const sc = (await app.request('/login', { method: 'POST' })).headers.get('set-cookie') as string;
    expect(sc.startsWith(`${INSECURE_SESSION_COOKIE}=`)).toBe(true);
    expect(sc).not.toMatch(/Secure/);
    expect(sc).toMatch(/HttpOnly/);
  });

  it('sign-in rotates: a planted / previous cookie is revoked and never reused', async () => {
    const { app, storage, clock } = build('https://rb.example.com');
    const first = await app.request('/login', { method: 'POST' });
    const planted = (first.headers.get('set-cookie') as string).split(';')[0] as string;
    const second = await app.request('/login', { method: 'POST', headers: { cookie: planted } });
    const fresh = (second.headers.get('set-cookie') as string).split(';')[0] as string;
    expect(fresh).not.toBe(planted);
    const old = planted.split('=')[1] as string;
    const timeouts = { idleMs: 30 * 60_000, absoluteMs: 12 * 3600_000 };
    expect((await loadSession(storage.kv, old, timeouts, clock)).ok).toBe(false);
    expect((await loadSession(storage.kv, fresh.split('=')[1], timeouts, clock)).ok).toBe(true);
  });

  it('cookie tossing: the session cookie named twice is malformed (no first/last-wins confusion)', async () => {
    const { mgr } = build('https://rb.example.com');
    const app = new Hono();
    app.get('/', (c) => c.json({ v: mgr.readCookie(c) }));
    const r = await app.request('/', { headers: { cookie: `${SESSION_COOKIE}=a; ${SESSION_COOKIE}=b` } });
    expect((await r.json()).v).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ API-level probes
describe('CSRF / method / content-type tricks on the admin API', () => {
  it('method override headers and query do not turn a safe or other method into a change', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const victim = await h.addUser('victim@example.com', 'member');
    const before = (await h.world.storage.users.get(victim))?.disabledAt;
    for (const [m, extra, q] of [
      ['GET', { 'x-http-method-override': 'PATCH' }, ''],
      ['GET', { 'x-method-override': 'PATCH' }, ''],
      ['POST', { 'x-http-method-override': 'DELETE' }, ''],
      ['GET', {}, '?_method=PATCH&disabled=true'],
    ] as const) {
      const r = await call(m, `${A}/users/${victim}${q}`, owner.headers, undefined, extra);
      expect([200, 404, 400, 405]).toContain(r.status);
    }
    expect((await h.world.storage.users.get(victim))?.disabledAt).toBe(before);
  });

  it('HEAD/OPTIONS on mutating routes never mutate and do not open them to a stranger', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const target = await h.addSession({ role: 'member' });
    for (const m of ['HEAD', 'OPTIONS']) {
      const r = await call(m, `${A}/users/${target.userId}/sessions/revoke`, owner.headers);
      expect([404, 405]).toContain(r.status);
      const none = await call(m, `${A}/users`, {});
      expect(none.status).toBe(401);
    }
    expect((await call('GET', `${A}/session`, target.headers)).status).toBe(200);
  });

  it('text/plain JSON body (a cross-site form) with a valid session but no CSRF header is 403, not processed', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const { 'x-csrf-token': _t, ...noCsrf } = owner.headers;
    const r = await h.send(
      new Request(`${PUBLIC_ORIGIN}${A}/users`, {
        method: 'POST',
        headers: { ...noCsrf, 'content-type': 'text/plain' },
        body: JSON.stringify({ email: 'x@example.com' }),
      }),
    );
    expect(r.status).toBe(403);
    expect((await h.world.storage.users.list()).some((u) => u.email === 'x@example.com')).toBe(false);
  });

  it('CSRF token only in query / body / cookie is not accepted; Origin "null" and case variants are refused', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const { 'x-csrf-token': _t, ...noCsrf } = owner.headers;
    const body = { email: 'q@example.com' };
    const tries: [string, string, Hdrs, unknown][] = [
      ['query', `${A}/users?csrf=${owner.csrf}&_csrf=${owner.csrf}`, noCsrf, body],
      ['body', `${A}/users`, noCsrf, { ...body, _csrf: owner.csrf }],
      ['cookie', `${A}/users`, { ...noCsrf, cookie: `${owner.cookie}; x-csrf-token=${owner.csrf}` }, body],
      ['origin null', `${A}/users`, { ...owner.headers, origin: 'null' }, body],
      ['origin upper', `${A}/users`, { ...owner.headers, origin: 'HTTP://LOCALHOST' }, body],
      ['origin trailing slash', `${A}/users`, { ...owner.headers, origin: 'http://localhost/' }, body],
      ['origin userinfo', `${A}/users`, { ...owner.headers, origin: 'http://localhost@evil.example' }, body],
      [
        'two csrf values',
        `${A}/users`,
        { ...owner.headers, 'x-csrf-token': `${owner.csrf}, ${owner.csrf}` },
        body,
      ],
    ];
    for (const [what, path, headers, b] of tries) {
      const r = await call('POST', path, headers, b);
      expect(r.status, what).toBe(400 === r.status ? 400 : 403);
      expect(r.status, what).toBe(403);
    }
    expect((await h.world.storage.users.list()).some((u) => u.email === 'q@example.com')).toBe(false);
  });

  it('bearer vs cookie: a bad Authorization header is judged alone (no fallback to the valid cookie)', async () => {
    const owner = await h.addSession({ role: 'owner' });
    for (const auth of ['Bearer nope', 'Basic Zm9vOmJhcg==', '', 'Bearer', `bearer ${'a'.repeat(40)}`]) {
      const r = await call('GET', `${A}/users`, owner.headers, undefined, { authorization: auth });
      expect(r.status, auth).toBe(401);
    }
  });

  it('duplicate session cookie (tossing) is rejected even if one copy is valid', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const r = await call('GET', `${A}/session`, {
      ...owner.headers,
      cookie: `${owner.cookie}; ${owner.cookie}`,
    });
    expect(r.status).toBe(401);
  });

  it('session id is not accepted from query string / other cookie names / the admin token as cookie', async () => {
    const owner = await h.addSession({ role: 'owner' });
    expect((await call('GET', `${A}/session?rb_session=${owner.value}`, {})).status).toBe(401);
    expect((await call('GET', `${A}/session`, { cookie: `__Host-rb_session=${owner.value}` })).status).toBe(
      401,
    );
  });
});

describe('roles', () => {
  const patch = (who: { headers: Hdrs }, id: string, body: unknown) =>
    call('PATCH', `${A}/users/${id}`, who.headers, body);

  it('mass assignment / odd fields on PATCH and POST /users are refused', async () => {
    const admin = await h.addSession({ role: 'admin' });
    const m = await h.addUser('m@example.com', 'member');
    for (const body of [
      { role: 'member', id: 'usr_x' },
      { email: 'e@example.com' },
      { idp: 'github' },
      { disabledAt: null },
      { role: 'OWNER' },
      { role: ['owner'] },
      { role: { toString: 'owner' } },
      JSON.parse('{"__proto__":{"role":"owner"}}'),
      JSON.parse('{"constructor":{"prototype":{"role":"owner"}}}'),
    ]) {
      const r = await patch(admin, m, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    const r = await call('POST', `${A}/users`, admin.headers, {
      email: 'n@example.com',
      role: 'member',
      disabledAt: 1,
    });
    expect(r.status).toBe(400);
    expect((await h.world.storage.users.get(m))?.role).toBe('member');
  });

  it('admin cannot reach owner: promote, create owner, setup link, rotate keys, touch owner, other roles via case/space', async () => {
    const admin = await h.addSession({ role: 'admin' });
    const owner = await h.addSession({ role: 'owner' });
    const m = await h.addUser('m2@example.com', 'member');
    expect((await patch(admin, m, { role: 'owner' })).status).toBe(403);
    expect(
      (await call('POST', `${A}/users`, admin.headers, { email: 'o@example.com', role: 'owner' })).status,
    ).toBe(403);
    expect((await call('POST', `${A}/setup-links`, admin.headers, {})).status).toBe(403);
    expect((await call('POST', `${A}/keys/rotate`, admin.headers, {})).status).toBe(403);
    expect((await patch(admin, owner.userId, { disabled: true })).status).toBe(403);
    expect((await patch(admin, owner.userId, { role: 'member' })).status).toBe(403);
    expect((await patch(admin, owner.userId, { displayName: 'pwn' })).status).toBe(403);
    // enable path on a disabled owner
    await h.world.storage.users.update(owner.userId, { disabledAt: T0 });
    expect((await patch(admin, owner.userId, { disabled: false })).status).toBe(403);
    await h.world.storage.users.update(owner.userId, { disabledAt: null });
    expect((await h.world.storage.users.get(owner.userId))?.role).toBe('owner');
  });

  it('a member cannot reach any admin route (incl. path-normalisation variants of the member-allowed ones)', async () => {
    const member = await h.addSession({ role: 'member' });
    for (const path of [
      `${A}/audit/stats`,
      `${A}/audit/stats/`,
      `${A}/%61udit/stats`,
      `${A}/audit/../users`,
      `${A}/users`,
      `${A}/users/`,
      `${A}/tokens`,
      `${A}//users`,
      `${A}/session/../users`,
      `${A}/openapi.json`,
    ]) {
      const r = await call('GET', path, member.headers);
      expect([403, 404, 401], path).toContain(r.status);
      expect(r.text, path).not.toContain('"data"');
    }
  });

  it('a member in audit: userId override, query pollution, arrays, case and encodings never show others', async () => {
    const member = await h.addSession({ role: 'member' });
    const other = await h.addSession({ role: 'owner' });
    await call('GET', `${A}/users`, other.headers); // owner activity
    await call('POST', `${A}/users`, other.headers, { email: 'seen@example.com' });
    const rows = async (qs: string) => {
      const r = await call('GET', `${A}/audit${qs}`, member.headers);
      // biome-ignore lint/suspicious/noExplicitAny: probe answers are walked loosely
      return { r, data: r.status === 200 ? (j(r)['data'] as any[]) : [] };
    };
    const queries = [
      `?userId=${other.userId}`,
      `?userId=${member.userId}&userId=${other.userId}`,
      `?userId=${other.userId}&userId=${member.userId}`,
      `?userId[]=${other.userId}`,
      `?userId=${other.userId.toUpperCase()}`,
      `?userId=${encodeURIComponent(` ${other.userId}`)}`,
      `?userId=`,
      `?kind=admin&keyId=any`,
      `?order=slowest`,
      `?limit=200&since=0`,
      `?grantId=${h.world.grantIds.prod}`,
      `?projectId=${h.world.projectIds.prod}`,
    ];
    for (const q of queries) {
      const { r, data } = await rows(q);
      expect([200, 400, 403], q).toContain(r.status);
      for (const row of data) expect(row.userId, q).toBe(member.userId);
    }
    // same via /audit/ trailing slash and uppercase path
    for (const p of [`${A}/audit/`, `${A}/AUDIT`]) {
      const r = await call('GET', p, member.headers);
      if (r.status === 200) for (const row of j(r)['data']) expect(row.userId).toBe(member.userId);
    }
  });

  it('a member holds no admin data via the session endpoint (no other user, no secrets)', async () => {
    const member = await h.addSession({ role: 'member' });
    const r = await call('GET', `${A}/session`, member.headers);
    expect(r.status).toBe(200);
    expect(Object.keys(j(r)['data']['user']).sort()).toEqual(
      ['createdAt', 'disabledAt', 'displayName', 'email', 'id', 'idp', 'role', 'updatedAt'].sort(),
    );
  });
});

describe('audit and stats bounds', () => {
  it('stats: window, limit, groupBy, since/until abuse is bounded (400) or capped', async () => {
    const admin = await h.addSession({ role: 'admin' });
    const day = 86_400_000;
    const now = h.world.clock.now();
    const bad = [
      `since=${now - 91 * day}&until=${now}`,
      `since=0&until=${now}`,
      `since=-9999999999999&until=${now}`,
      `since=${now}&until=${now}`,
      `since=NaN`,
      `since=1e400`,
      `limit=101`,
      `limit=0`,
      `limit=-1`,
      `limit=1e3`,
      `limit=10.5`,
      `groupBy=constructor`,
      `groupBy=action;DROP TABLE audit_log`,
      `groupBy=action&groupBy=day`,
      `action=${'a'.repeat(65)}`,
      `action=a'%20OR%201=1--`,
      `userId=a'%20OR%201=1--`,
      `projectId=%00`,
    ];
    for (const q of bad) {
      const r = await call('GET', `${A}/audit/stats?${q}`, admin.headers);
      expect(r.status, q).toBe(400);
    }
    const ok = await call(
      'GET',
      `${A}/audit/stats?since=${now - 90 * day}&until=${now}&limit=100&groupBy=day`,
      admin.headers,
    );
    expect(ok.status).toBe(200);
    expect(j(ok)['data'].length).toBeLessThanOrEqual(100);
  });

  it('audit list: bounds, injection-shaped filters and cursors are 400, never 500', async () => {
    const admin = await h.addSession({ role: 'admin' });
    const bad = [
      `limit=201`,
      `limit=0`,
      `offset=5`,
      `cursor=${'A'.repeat(201)}`,
      `cursor=!!!`,
      `cursor=${btoa('a:1; DROP')}`,
      `since=drop`,
      `until=${'9'.repeat(40)}`,
      `action=x'%20OR%20'1'='1`,
      `projectId=prj_1'%20OR%20'1'='1`,
      `keyId=pt_zzzz`,
      `kind=admin%27--`,
      `status=ok&status=denied`,
      `order=slowest&cursor=a`,
    ];
    for (const q of bad) {
      const r = await call('GET', `${A}/audit?${q}`, admin.headers);
      expect(r.status, q).toBeLessThan(500);
      expect([200, 400], q).toContain(r.status);
      if (r.status === 400) expect(r.text).not.toMatch(/SQL|sqlite|SELECT|stack|node_modules/i);
    }
  });

  it('error bodies for odd input never echo internals or stack traces', async () => {
    const admin = await h.addSession({ role: 'admin' });
    const res = [
      await call('POST', `${A}/users`, admin.headers, undefined, {}),
      await h.send(
        new Request(`${PUBLIC_ORIGIN}${A}/users`, {
          method: 'POST',
          headers: { ...admin.headers, 'content-type': 'application/json' },
          body: '{"email":',
        }),
      ),
      await call('GET', `${A}/users/${'x'.repeat(5000)}`, admin.headers),
      await call('GET', `${A}/users/%ff%fe`, admin.headers),
    ];
    for (const r of res) {
      expect(r.status).toBeLessThan(500);
      expect(r.text).not.toMatch(/node_modules|at \w+ \(|SQLITE|stack/i);
    }
  });
});

describe('UI export (GET /admin/audit.csv)', () => {
  it('fix: a cross-site top-level navigation does not start a download of audit data (lands on the audit page)', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const r = await h.send(
      new Request(`${PUBLIC_ORIGIN}/admin/audit.csv`, {
        headers: {
          cookie: owner.cookie,
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        },
      }),
    );
    // Finding L5 (fixed): a link on another site must not save the audit log to the visitor's disk.
    expect(r.headers.get('content-disposition') ?? '').not.toMatch(/attachment/);
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/admin/audit');
  });

  it('is refused as a subresource / fetch cross-site', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const r = await h.send(
      new Request(`${PUBLIC_ORIGIN}/admin/audit.csv`, {
        headers: {
          cookie: owner.cookie,
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'no-cors',
          'sec-fetch-dest': 'image',
        },
      }),
    );
    expect(r.status).toBe(403);
  });

  it("member export carries only the member's rows", async () => {
    const member = await h.addSession({ role: 'member' });
    const owner = await h.addSession({ role: 'owner' });
    await call('POST', `${A}/users`, owner.headers, { email: 'csv@example.com' });
    const r = await h.send(
      new Request(`${PUBLIC_ORIGIN}/admin/audit.csv?user=${owner.userId}`, {
        headers: { cookie: member.cookie, 'sec-fetch-site': 'same-origin' },
      }),
    );
    expect(r.text).not.toContain(owner.userId);
    expect(r.text).not.toContain('csv@example.com');
  });
});

describe('sessions end', () => {
  it('idle and absolute timeouts through the API; activity extends idle but never the absolute lifetime', async () => {
    const s = await h.addSession({ role: 'owner' });
    for (let i = 0; i < 35; i++) {
      h.world.clock.advance(20 * 60_000);
      expect((await call('GET', `${A}/session`, s.headers)).status).toBe(200);
    }
    h.world.clock.advance(30 * 60_000);
    // > 12 h since sign-in now: absolute lifetime ends it despite constant activity.
    expect((await call('GET', `${A}/session`, s.headers)).status).toBe(401);
  });

  it('admin-token disable and role change end sessions of the target everywhere (incl. other sessions)', async () => {
    const a1 = await h.addSession({ role: 'admin' });
    const a2 = await h.addSession({ userId: a1.userId });
    const hdr = { authorization: `Bearer ${(await import('./authz/harness.ts')).ADMIN_TOKEN}` };
    expect((await call('PATCH', `${A}/users/${a1.userId}`, hdr, { role: 'member' })).status).toBe(200);
    expect((await call('GET', `${A}/session`, a1.headers)).status).toBe(401);
    expect((await call('GET', `${A}/session`, a2.headers)).status).toBe(401);
  });

  it('fix: re-enabling a user does not resurrect sessions that survived a disable done outside the API', async () => {
    const s = await h.addSession({ role: 'admin' });
    await h.world.storage.users.update(s.userId, { disabledAt: T0 }); // e.g. the CLI on the database
    expect((await call('GET', `${A}/session`, s.headers)).status).toBe(401);
    await h.world.storage.users.update(s.userId, { disabledAt: null });
    h.world.clock.advance(6_000); // past the 5 s per-isolate user cache
    // Finding L6 (fixed): the session was deleted when it was refused while the user was disabled.
    expect((await call('GET', `${A}/session`, s.headers)).status).toBe(401);
  });

  it('fix: re-enabling through the API ends sessions that were never used while the user was disabled', async () => {
    const s = await h.addSession({ role: 'admin' });
    await h.world.storage.users.update(s.userId, { disabledAt: T0 }); // outside the API, session untouched meanwhile
    const hdr = { authorization: `Bearer ${(await import('./authz/harness.ts')).ADMIN_TOKEN}` };
    expect((await call('PATCH', `${A}/users/${s.userId}`, hdr, { disabled: false })).status).toBe(200);
    h.world.clock.advance(6_000);
    expect((await call('GET', `${A}/session`, s.headers)).status).toBe(401);
  });
});
