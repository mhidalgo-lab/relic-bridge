// SPDX-License-Identifier: Apache-2.0
// Authorization matrix (P2-12, THREAT_MODEL T2/T3/T15/T19): every route × every kind of caller. A denial must be the
// route family's single answer (byte-identical apart from the request id), reach no credential or NerdGraph, write an
// `auth.denied` audit row with the stable reason, and leak no secret anywhere. Every MCP denial has a positive control:
// the same caller without the defect gets in.
import { DENY_REASONS } from '@relic-bridge/auth';
import { Secret } from '@relic-bridge/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHttpApp } from '../../src/index.ts';
import { NR_KEY, T0 } from '../fixtures.ts';
import {
  ADMIN_TOKEN,
  authzHostKind,
  type Captured,
  createHarness,
  type Harness,
  PUBLIC_ORIGIN,
} from './harness.ts';
import {
  ADMIN_PRINCIPALS,
  ADMIN_ROUTES,
  CONSENT_ROUTES,
  IDENTITY_ROUTES,
  isSelfService,
  MCP_PRINCIPALS,
  MCP_ROUTES,
  OAUTH_ROUTES,
  PASSTHROUGH_PRINCIPALS,
  PASSTHROUGH_ROUTES,
  PUBLIC_ROUTES,
  type RouteCase,
  requestFor,
  sessionCheck,
  UI_ASSET_ROUTES,
  UI_ROUTES,
  WILDCARD_ROUTES,
} from './matrix.ts';

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.scan();
});

/** Everything a client can observe about a response except the per-request id. */
function observable(r: Captured): string {
  const headers = [...r.headers.entries()]
    .filter(([name]) => name !== 'x-request-id')
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({ status: r.status, headers, body: r.text });
}

async function expectDenied(
  route: RouteCase,
  reference: Captured,
  res: Captured,
  reason: string,
  what: string,
) {
  try {
    expect(res.status).toBe(401);
    // T19: nothing distinguishes one denial from another (no slug, token, grant or user enumeration).
    expect(observable(res)).toBe(observable(reference));
    expect(res.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const row = await h.deniedRow(res.requestId as string);
    expect(row).toMatchObject({ kind: 'auth', status: 'denied', errorCode: reason });
    // A refusal row names nobody: the caller is not authenticated.
    expect(row).toMatchObject({ userId: null, grantId: null, tokenId: null, projectId: null });
  } catch (error) {
    throw new Error(`${route.method} ${route.path} — ${what}: ${(error as Error).message}`);
  }
}

describe('MCP routes × principals', () => {
  it('the reference denial is the generic 401 and carries no detail', async () => {
    for (const route of MCP_ROUTES) {
      const res = await h.send(requestFor(route, { headers: {}, slug: 'prod' }));
      expect(res.status).toBe(401);
      expect(res.text).toBe('{"error":"unauthorized"}');
      expect(res.headers.get('www-authenticate')).toBe('Bearer realm="relic-bridge"');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  for (const principal of MCP_PRINCIPALS) {
    it(`${principal.name} → 401 (${principal.reason})`, async () => {
      const valid = await principal.valid(h);
      for (const route of MCP_ROUTES) {
        // Positive control: the baseline gets past authentication on this route.
        const control = await h.send(requestFor(route, valid));
        expect(control.status, `${route.method} control for ${principal.name}`).not.toBe(401);
        expect(control.status).not.toBe(403);
      }
      const broken = await principal.broken(h, valid);
      const callsBefore = h.nerdGraph.calls.length;
      for (const route of MCP_ROUTES) {
        const reference = await h.send(requestFor(route, { headers: {}, slug: 'prod' }));
        const res = await h.send(requestFor(route, broken));
        await expectDenied(route, reference, res, principal.reason, principal.name);
      }
      expect(h.nerdGraph.calls.length).toBe(callsBefore);
    });
  }

  it('a denial is the same on every method, slug and principal (one answer to compare)', async () => {
    const seen = new Set<string>();
    for (const principal of MCP_PRINCIPALS.slice(0, 8)) {
      const broken = await principal.broken(h, await principal.valid(h));
      for (const route of MCP_ROUTES) {
        const res = await h.send(requestFor(route, broken));
        seen.add(JSON.stringify({ status: res.status, body: res.text }));
      }
    }
    expect([...seen]).toEqual([JSON.stringify({ status: 401, body: '{"error":"unauthorized"}' })]);
  });

  it('a cached grant is still bound to its project, and a revocation ends it within the TTL (T15)', async () => {
    const app = h.makeApp({ accessCacheTtlMs: 30_000 });
    const post = MCP_ROUTES[0] as RouteCase;
    const eu = { headers: { authorization: `Bearer ${h.world.tokens.eu}` }, slug: 'eu' };
    expect((await h.send(requestFor(post, eu), app)).status).toBe(200);
    expect((await h.send(requestFor(post, { ...eu, slug: 'prod' }), app)).status).toBe(401);
    await h.world.storage.grants.update(
      (await h.world.storage.grants.list({ projectId: h.world.projectIds.eu }))[0]?.id as string,
      { revokedAt: h.world.clock.now() },
    );
    expect((await h.send(requestFor(post, eu), app)).status).toBe(200);
    h.world.clock.advance(30_000);
    expect((await h.send(requestFor(post, eu), app)).status).toBe(401);
  });
});

describe('pass-through routes × principals (P2-15)', () => {
  const ptApp = () => h.makeApp({ passthrough: {} });
  const NR = { 'x-newrelic-api-key': NR_KEY };

  it('do not exist unless pass-through is configured, whatever the caller presents', async () => {
    for (const route of PASSTHROUGH_ROUTES) {
      for (const headers of [{}, NR, { authorization: `Bearer ${h.world.tokens.prod}` }]) {
        const res = await h.send(requestFor(route, { headers }));
        expect(res.status).toBe(404);
        expect(res.text).toBe('{"error":"not_found"}');
      }
    }
    expect(h.nerdGraph.calls).toEqual([]);
  });

  it('the reference denial is one 401 that does not invite OAuth discovery', async () => {
    const app = ptApp();
    for (const route of PASSTHROUGH_ROUTES) {
      const res = await h.send(requestFor(route, { headers: {} }), app);
      expect(res.status).toBe(401);
      expect(res.text).toBe('{"error":"unauthorized"}');
      expect(res.headers.get('www-authenticate')).toBe('NewRelic-Api-Key realm="relic-bridge-passthrough"');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  for (const principal of PASSTHROUGH_PRINCIPALS) {
    it(`${principal.name} → 401 (${principal.reason})`, async () => {
      const app = ptApp();
      for (const route of PASSTHROUGH_ROUTES) {
        const control = await h.send(requestFor(route, { headers: NR }), app);
        expect(control.status, `${route.method} control`).not.toBe(401);
        expect(control.status).not.toBe(403);
      }
      const presented = await principal.present(h);
      const callsBefore = h.nerdGraph.calls.length;
      for (const route of PASSTHROUGH_ROUTES) {
        const reference = await h.send(requestFor(route, { headers: {} }), app);
        const res = await h.send(requestFor(route, presented), app);
        await expectDenied(route, reference, res, principal.reason, principal.name);
      }
      const calls = h.nerdGraph.calls.slice(callsBefore);
      if (principal.reachesNerdGraph) {
        // Only the validation query, never a tool call, and never with another key.
        expect(calls.map((c) => c.op)).toEqual(PASSTHROUGH_ROUTES.map(() => 'RbIdentity'));
        expect(calls.every((c) => c.apiKey !== NR_KEY)).toBe(true);
      } else {
        expect(calls).toEqual([]);
      }
    });
  }
});

describe('admin routes × principals', () => {
  for (const principal of ADMIN_PRINCIPALS) {
    it(`${principal.name} → 401 (${principal.reason}) on every admin route`, async () => {
      const presented = await principal.present(h);
      const users = (await h.world.storage.users.list()).length;
      const adminRows = (await h.world.storage.auditLog.list({ kind: 'admin' })).length;
      let reason = principal.reason;
      for (const route of ADMIN_ROUTES) {
        const reference = await h.send(requestFor(route, { headers: {} }));
        expect(reference.status).toBe(401);
        expect(JSON.parse(reference.text)).toEqual({
          error: { code: 'unauthorized', message: 'admin authentication required' },
        });
        expect(reference.headers.get('www-authenticate')).toBe('Bearer realm="relic-bridge-admin"');
        const res = await h.send(requestFor(route, presented));
        await expectDenied(route, reference, res, reason, principal.name);
        reason = principal.reasonAfterFirst ?? principal.reason;
      }
      // Nothing changed and no admin action was recorded.
      expect((await h.world.storage.users.list()).length).toBe(users);
      expect((await h.world.storage.auditLog.list({ kind: 'admin' })).length).toBe(adminRows);
      expect(h.nerdGraph.calls).toEqual([]);
    });
  }

  const adminControlStatus = controlStatus;

  it('positive control: the admin token gets the expected answer on every admin route', async () => {
    for (const route of ADMIN_ROUTES) {
      const res = await h.send(requestFor(route, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }));
      // Self-service routes belong to a user: the admin token is nobody there.
      if (isSelfService(route)) {
        expect(res.status, `${route.method} ${route.path}`).toBe(403);
        expect(JSON.parse(res.text).error).toMatchObject({ code: 'forbidden', detail: 'no_user' });
        continue;
      }
      const want = adminControlStatus(route);
      expect(res.status, `${route.method} ${route.path}`).toBe(want);
      if (want === 404) expect(JSON.parse(res.text).error.code).toBe('not_found');
    }
  });

  // The Worker's admin switch (`RB_ADMIN_TOKEN` unset) is tested in apps/worker/test/worker.test.ts.
  it.skipIf(authzHostKind() !== 'http-app')(
    'every admin route is 404 when the admin API is off, whatever the caller presents',
    async () => {
      const off = createHttpApp({ storage: h.world.storage, keyring: h.world.keyring, clock: h.world.clock });
      for (const route of ADMIN_ROUTES) {
        for (const headers of [{}, { authorization: `Bearer ${ADMIN_TOKEN}` }]) {
          const res = await h.send(requestFor(route, { headers }), off);
          expect(res.status).toBe(404);
          expect(res.text).toBe('{"error":"not_found"}');
        }
      }
    },
  );
});

/** Samples reference ids that don't exist (404 `not_found`); the rest must succeed: 200, or 201 for creates. */
function controlStatus(route: RouteCase): number {
  const dangling =
    route.path.includes('_none') ||
    route.path.endsWith('/no-such-endpoint') ||
    (route.method === 'POST' &&
      (route.path.endsWith('/grants') || route.path.endsWith('/tokens')) &&
      route.body !== undefined);
  if (dangling) return 404;
  // OAuth is off in these apps: the client list is empty, the rest is 404 (P5-08).
  if (route.path.endsWith('/oauth/clients/remove') || route.path.endsWith('/oauth/registration')) return 404;
  if (route.path.endsWith('/keys/rotate') || route.path.includes('/config/')) return 200;
  return route.method === 'POST' ? 201 : 200;
}

const UNSAFE = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const OWNER_ONLY = new Set([
  'POST /api/admin/v1/keys/rotate',
  'POST /api/admin/v1/setup-links',
  'POST /api/admin/v1/config/export',
  'POST /api/admin/v1/config/import',
  'POST /api/admin/v1/users/:id/unbind',
  'GET /api/admin/v1/oauth/clients',
  'POST /api/admin/v1/oauth/clients/remove',
  'GET /api/admin/v1/oauth/registration',
  'POST /api/admin/v1/oauth/registration',
]);
const ANY_ROLE = new Set(['GET /api/admin/v1/session', 'GET /api/admin/v1/audit']);

describe('admin routes × session principals (P4-02)', () => {
  /** What changing state looks like: users, setup links and session rows, and successful admin rows. */
  async function snapshot() {
    const kv = await h.world.storage.kv.list({ limit: 1000 });
    // Refusals are recorded (`admin.forbidden`, or `denied` rows of refused changes); changes are `ok` rows.
    const admin = (await h.auditRows()).filter((r) => r.kind === 'admin' && r.status === 'ok');
    return JSON.stringify({
      users: (await h.world.storage.users.list()).map((u) => [u.id, u.role, u.disabledAt]),
      kv: kv.keys.map((k) => k.name).filter((n) => !n.startsWith('sess-seen:')),
      admin: admin.length,
    });
  }

  async function expectForbidden(route: RouteCase, res: Captured, detail: string | null, what: string) {
    try {
      expect(res.status).toBe(403);
      if (detail === null) return;
      expect(JSON.parse(res.text).error).toMatchObject({ code: 'forbidden', detail });
    } catch (error) {
      throw new Error(`${route.method} ${route.path} — ${what}: ${(error as Error).message}`);
    }
  }

  it('positive control: an owner session gets what the admin token gets, on every admin route', async () => {
    const owner = await h.addSession({ role: 'owner' });
    for (const route of ADMIN_ROUTES) {
      const res = await h.send(requestFor(route, { headers: owner.headers }));
      expect(res.status, `${route.method} ${route.path}`).toBe(controlStatus(route));
    }
    // Changes made in a session name the user in the audit log.
    const rows = (await h.auditRows()).filter((r) => r.kind === 'admin' && r.status === 'ok');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.userId).toBe(owner.userId);
      expect(row.details).toMatchObject({ via: 'session' });
    }
  });

  it('an admin session: owner-only routes are 403 (role), the rest answer like the owner', async () => {
    const admin = await h.addSession({ role: 'admin' });
    for (const route of ADMIN_ROUTES) {
      const res = await h.send(requestFor(route, { headers: admin.headers }));
      if (OWNER_ONLY.has(`${route.method} ${route.pattern}`)) {
        await expectForbidden(route, res, 'role', 'admin session');
      } else {
        expect(res.status, `${route.method} ${route.path}`).toBe(controlStatus(route));
      }
    }
  });

  it('a member session: 403 on every admin route but GET /session, and nothing changes', async () => {
    const member = await h.addSession({ role: 'member' });
    const before = await snapshot();
    for (const route of ADMIN_ROUTES) {
      // Self-service routes are open to members by design; they are exercised in `member-self-service.test.ts`.
      if (isSelfService(route)) continue;
      const res = await h.send(requestFor(route, { headers: member.headers }));
      if (ANY_ROLE.has(`${route.method} ${route.pattern}`)) expect(res.status).toBe(200);
      else await expectForbidden(route, res, 'role', 'member session');
    }
    expect(await snapshot()).toBe(before);
    expect(h.nerdGraph.calls).toEqual([]);
    // Each refusal is an audited `admin.forbidden` naming the member.
    const refusals = (await h.auditRows()).filter((r) => r.action === 'admin.forbidden');
    expect(refusals.length).toBeGreaterThanOrEqual(ADMIN_ROUTES.filter((r) => !isSelfService(r)).length - 3);
    for (const row of refusals) expect(row).toMatchObject({ status: 'denied', userId: member.userId });
  });

  it('audit (P4-05): a member reads only their own rows, never usage statistics; an admin reads all', async () => {
    const member = await h.addSession({ role: 'member' });
    const other = await h.addSession({ role: 'member' });
    const admin = await h.addSession({ role: 'admin' });
    for (const [userId, action] of [
      [member.userId, 'run_nrql'],
      [other.userId, 'secret_tool'],
    ] as const) {
      await h.world.storage.auditLog.append({ ts: 1, kind: 'tool_call', action, status: 'ok', userId });
    }
    const rows = async (headers: Readonly<Record<string, string>>, query = '') => {
      const res = await h.send(
        requestFor({ method: 'GET', pattern: '', path: `/api/admin/v1/audit${query}` }, { headers }),
      );
      return {
        status: res.status,
        body: JSON.parse(res.text) as { data?: { action: string; userId: string }[] },
      };
    };
    const mine = await rows(member.headers);
    expect(mine.status).toBe(200);
    expect(mine.body.data?.every((r) => r.userId === member.userId)).toBe(true);
    expect(mine.body.data?.map((r) => r.action)).toContain('run_nrql');
    expect(JSON.stringify(mine.body)).not.toContain('secret_tool');
    // Own id is fine; someone else's is refused (and audited), and no filter combination widens the view.
    expect((await rows(member.headers, `?userId=${member.userId}`)).status).toBe(200);
    expect((await rows(member.headers, `?userId=${other.userId}`)).status).toBe(403);
    const sneaky = await rows(member.headers, '?kind=tool_call&keyId=any&order=slowest&limit=200');
    expect(JSON.stringify(sneaky.body)).not.toContain('secret_tool');
    const stats = await h.send(
      requestFor(
        { method: 'GET', pattern: '', path: '/api/admin/v1/audit/stats' },
        { headers: member.headers },
      ),
    );
    expect(stats.status).toBe(403);
    expect(JSON.stringify((await rows(admin.headers)).body)).toContain('secret_tool');
    const refused = (await h.auditRows()).filter(
      (r) => r.action === 'admin.forbidden' && r.userId === member.userId,
    );
    expect(refused.length).toBeGreaterThanOrEqual(2);
  });

  /** CSRF defects on an owner session; `detail` null: refused earlier by the global Origin check (403 too). */
  const csrfCases = (
    owner: { headers: Readonly<Record<string, string>> },
    other: { csrf: string },
  ): [string, Record<string, string>, string | null, 'unsafe' | 'all'][] => {
    const base = { ...owner.headers };
    const without = (...names: string[]) =>
      Object.fromEntries(Object.entries(base).filter(([k]) => !names.includes(k)));
    return [
      ['no CSRF token', without('x-csrf-token'), 'csrf', 'unsafe'],
      ['wrong CSRF token', { ...base, 'x-csrf-token': 'A'.repeat(43) }, 'csrf', 'unsafe'],
      ['malformed CSRF token', { ...base, 'x-csrf-token': 'nope' }, 'csrf', 'unsafe'],
      ["another session's CSRF token", { ...base, 'x-csrf-token': other.csrf }, 'csrf', 'unsafe'],
      ['Origin on another port', { ...base, origin: 'http://localhost:8080' }, 'origin_mismatch', 'unsafe'],
      ['Origin with another scheme', { ...base, origin: 'https://localhost' }, 'origin_mismatch', 'unsafe'],
      ['Origin of another site', { ...base, origin: 'https://evil.example' }, null, 'all'],
      ['no Origin and no fetch metadata', without('origin', 'sec-fetch-site'), 'origin_missing', 'unsafe'],
      [
        'cross-site fetch metadata',
        { ...without('origin'), 'sec-fetch-site': 'cross-site' },
        'cross_site',
        'all',
      ],
      [
        'same-site fetch metadata',
        { ...without('origin'), 'sec-fetch-site': 'same-site' },
        'cross_site',
        'all',
      ],
      [
        'typed-URL fetch metadata on a change',
        { ...without('origin'), 'sec-fetch-site': 'none' },
        'cross_site',
        'unsafe',
      ],
    ];
  };

  it('CSRF: a token, our Origin and same-origin fetch metadata are all required; nothing changes otherwise', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const other = await h.addSession({ role: 'owner' });
    const before = await snapshot();
    for (const [what, headers, detail, scope] of csrfCases(owner, other)) {
      for (const route of ADMIN_ROUTES) {
        if (scope === 'unsafe' && !UNSAFE.has(route.method)) continue;
        await expectForbidden(route, await h.send(requestFor(route, { headers })), detail, what);
      }
    }
    expect(await snapshot()).toBe(before);
    expect(h.nerdGraph.calls).toEqual([]);
    // Reads need no token: a same-origin page and a typed URL both get in.
    const read = ADMIN_ROUTES.find((r) => r.pattern.endsWith('/users')) as RouteCase;
    const { 'x-csrf-token': _t, origin: _o, ...plain } = owner.headers;
    expect((await h.send(requestFor(read, { headers: plain }))).status).toBe(200);
    expect((await h.send(requestFor(read, { headers: { ...plain, 'sec-fetch-site': 'none' } }))).status).toBe(
      200,
    );
  });

  it('a bearer request ignores cookies: a member session does not lower the admin token, nor lend itself', async () => {
    const member = await h.addSession({ role: 'member' });
    const rotate = ADMIN_ROUTES.find((r) => r.pattern.endsWith('/keys/rotate')) as RouteCase;
    const withToken = { ...member.headers, authorization: `Bearer ${ADMIN_TOKEN}` };
    expect((await h.send(requestFor(rotate, { headers: withToken }))).status).toBe(200);
    // A bearer request needs no CSRF token or Origin (a browser can't attach the header cross-site).
    const bare = { authorization: `Bearer ${ADMIN_TOKEN}`, 'sec-fetch-site': 'cross-site' };
    expect((await h.send(requestFor(rotate, { headers: bare }))).status).toBe(200);
    const me = await h.send(
      requestFor(ADMIN_ROUTES.find((r) => r.pattern.endsWith('/session')) as RouteCase, {
        headers: withToken,
      }),
    );
    expect(JSON.parse(me.text).data).toMatchObject({ kind: 'admin_token', role: 'owner', csrfToken: null });
  });

  it('GET /session tells the session its role, user, CSRF token and expiries', async () => {
    const admin = await h.addSession({ role: 'admin' });
    const res = await h.send(
      requestFor(ADMIN_ROUTES.find((r) => r.pattern.endsWith('/session')) as RouteCase, {
        headers: admin.headers,
      }),
    );
    expect(res.status).toBe(200);
    const data = JSON.parse(res.text).data;
    expect(data).toMatchObject({ kind: 'session', role: 'admin', csrfToken: admin.csrf, provider: 'github' });
    expect(data.user.id).toBe(admin.userId);
    expect(data.expiresAt).toBe(h.world.clock.now() + 12 * 3_600_000);
    expect(data.idleExpiresAt).toBe(h.world.clock.now() + 30 * 60_000);
  });

  it('roles: privilege changes end sessions; nobody demotes or disables themselves; admins leave owners alone', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const admin = await h.addSession({ role: 'admin' });
    const member = await h.addSession({ role: 'member' });
    const memberPhone = await h.addSession({ userId: member.userId });
    const patch = (who: { headers: Readonly<Record<string, string>> }, id: string, body: unknown) =>
      h.send(
        new Request(`${PUBLIC_ORIGIN}/api/admin/v1/users/${id}`, {
          method: 'PATCH',
          headers: { ...who.headers, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    const post = (who: { headers: Readonly<Record<string, string>> }, path: string, body?: unknown) =>
      h.send(
        new Request(`${PUBLIC_ORIGIN}/api/admin/v1${path}`, {
          method: 'POST',
          headers: { ...who.headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    const me = (who: { headers: Readonly<Record<string, string>> }) => h.send(sessionCheck(who.headers));
    const detail = (r: Captured) => `${r.status} ${JSON.parse(r.text).error?.detail ?? ''}`;

    // Self-changes of role or status are refused; a display name is fine.
    expect(detail(await patch(owner, owner.userId, { role: 'member' }))).toBe('403 self');
    expect(detail(await patch(owner, owner.userId, { disabled: true }))).toBe('403 self');
    expect((await patch(owner, owner.userId, { displayName: 'Me' })).status).toBe(200);
    // Admins: no owners made, touched or signed out.
    expect(detail(await patch(admin, member.userId, { role: 'owner' }))).toBe('403 owner');
    expect(detail(await patch(admin, owner.userId, { displayName: 'x' }))).toBe('403 owner');
    expect(detail(await post(admin, `/users/${owner.userId}/sessions/revoke`))).toBe('403 owner');
    expect(detail(await post(admin, '/users', { email: 'o2@example.com', role: 'owner' }))).toBe('403 owner');
    // Members: only their own sessions.
    expect(detail(await post(member, `/users/${admin.userId}/sessions/revoke`))).toBe('403 role');
    expect(detail(await post(member, '/users/usr_none/sessions/revoke'))).toBe('403 role');
    expect((await me(owner)).status).toBe(200);
    expect((await me(admin)).status).toBe(200);

    // A role change ends every session of that user, at once.
    expect((await patch(admin, member.userId, { role: 'admin' })).status).toBe(200);
    expect((await me(member)).status).toBe(401);
    expect((await me(memberPhone)).status).toBe(401);
    // Disabling too; and a disabled user's fresh session (minted directly) still fails.
    expect((await patch(owner, admin.userId, { disabled: true })).status).toBe(200);
    expect((await me(admin)).status).toBe(401);
    expect((await me(await h.addSession({ userId: admin.userId }))).status).toBe(401);
    // Sign out everywhere (self).
    const ownerLaptop = await h.addSession({ userId: owner.userId });
    const out = await post(owner, `/users/${owner.userId}/sessions/revoke`);
    expect(JSON.parse(out.text).data).toEqual({ userId: owner.userId, revoked: 2 });
    expect((await me(ownerLaptop)).status).toBe(401);

    const actions = (await h.auditRows())
      .filter((r) => r.kind === 'admin')
      .map((r) => `${r.action}:${r.status}`);
    expect(actions).toEqual(
      expect.arrayContaining(['user.update:denied', 'session.revoke_all:ok', 'session.revoke_all:denied']),
    );
  });
});

describe('sign-out (P4-02)', () => {
  const logout = (headers: Record<string, string>, body?: string) =>
    new Request(`${PUBLIC_ORIGIN}/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      ...(body === undefined ? {} : { body }),
    });

  it('needs the CSRF token from our own origin; then ends the session server-side', async () => {
    const s = await h.addSession({ role: 'owner' });
    const { 'x-csrf-token': _t, ...noToken } = s.headers;
    for (const [headers, body] of [
      [noToken, undefined],
      [noToken, '_csrf=wrong'],
      [{ ...noToken, origin: 'http://localhost:9999' }, `_csrf=${s.csrf}`],
      [{ ...noToken, 'sec-fetch-site': 'cross-site' }, `_csrf=${s.csrf}`],
    ] as const) {
      const res = await h.send(logout({ ...headers }, body));
      expect(res.status).toBe(403);
      expect((await h.send(sessionCheck(s.headers))).status).toBe(200);
    }
    const ok = await h.send(logout({ ...noToken }, `_csrf=${s.csrf}`));
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/auth/login');
    expect(ok.headers.get('set-cookie')).toMatch(/^rb_session=; Path=\/; Max-Age=0; HttpOnly; SameSite=Lax$/);
    expect((await h.send(sessionCheck(s.headers))).status).toBe(401);
    // The header form works too, and everywhere=1 ends every session of the user.
    const a = await h.addSession({ role: 'member' });
    const b = await h.addSession({ userId: a.userId });
    expect((await h.send(logout({ ...a.headers }, 'everywhere=1'))).status).toBe(303);
    expect((await h.send(sessionCheck(b.headers))).status).toBe(401);
    const actions = (await h.auditRows()).map((r) => `${r.action}:${r.status}`);
    expect(actions).toEqual(
      expect.arrayContaining(['admin.forbidden:denied', 'session.revoke:ok', 'session.revoke_all:ok']),
    );
  });

  it('without a live session it only clears the cookie; without a cookie it clears nothing', async () => {
    for (const cookie of ['rb_session=garbage', `rb_session=usr_a.${'A'.repeat(43)}`]) {
      const res = await h.send(logout({ cookie }));
      expect(res.status).toBe(303);
      expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    }
    // A cross-site form arrives without the (SameSite=Lax) cookie: no forced sign-out of this browser.
    const bare = await h.send(logout({ 'sec-fetch-site': 'cross-site', origin: 'http://localhost:9999' }));
    expect(bare.status).toBe(303);
    expect(bare.headers.get('set-cookie')).toBeNull();
    // A disabled user's session is ended for good.
    const s = await h.addSession({ role: 'admin' });
    await h.world.storage.users.update(s.userId, { disabledAt: T0 });
    expect((await h.send(logout({ cookie: s.cookie }))).status).toBe(303);
    await h.world.storage.users.update(s.userId, { disabledAt: null });
    expect((await h.send(sessionCheck(s.headers))).status).toBe(401);
  });

  it('refuses a body over 2 KiB', async () => {
    const s = await h.addSession({ role: 'owner' });
    const res = await h.send(logout({ ...s.headers }, `_csrf=${s.csrf}&pad=${'x'.repeat(4096)}`));
    expect(res.status).toBe(413);
    expect((await h.send(sessionCheck(s.headers))).status).toBe(200);
  });
});

describe('sign-in routes (P4-01)', () => {
  const route = (pattern: string) => IDENTITY_ROUTES.find((r) => r.pattern === pattern) as RouteCase;
  /** What a client sees, with the request id (also printed on the failure page) taken out. */
  const seen = (r: Captured) =>
    observable(r)
      .replaceAll(r.requestId ?? '<none>', '<request-id>')
      .replace(/"x-request-id","[^"]*"/, '');
  /** Every credential the app knows, presented every way: none of them is an identity. */
  const callers = (): { headers: Record<string, string>; query?: string }[] => [
    { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
    { headers: { authorization: `Bearer ${h.world.tokens.prod}` } },
    { headers: { cookie: `rb_admin=${ADMIN_TOKEN}; rb_login=${'A'.repeat(43)}` } },
    { headers: { cookie: `CF_Authorization=${h.world.tokens.prod}` } },
    { headers: {}, query: `token=${ADMIN_TOKEN}&state=${'A'.repeat(43)}&code=x` },
    { headers: { 'cf-access-jwt-assertion': '' } },
  ];

  it('confer nothing on bearer tokens, cookies or query credentials', async () => {
    const users = (await h.world.storage.users.list()).length;
    for (const pattern of ['/auth/callback/:provider', '/auth/cf-access']) {
      const r = route(pattern);
      const reference = await h.send(requestFor(r, { headers: {} }));
      expect(reference.status, pattern).toBe(pattern === '/auth/cf-access' ? 403 : 400);
      for (const caller of callers()) {
        const res = await h.send(requestFor(r, caller));
        expect(res.status, `${pattern} ${JSON.stringify(caller)}`).toBe(reference.status);
        if (caller.query === undefined) expect(seen(res)).toBe(seen(reference));
      }
    }
    expect((await h.world.storage.users.list()).length).toBe(users);
    expect(h.idpCalls).toEqual([]);
    const rows = await h.auditRows();
    expect(rows.filter((r) => r.action === 'login.ok')).toEqual([]);
    const denied = rows.filter((r) => r.action === 'login.denied');
    expect(denied.length).toBeGreaterThanOrEqual(2 * (callers().length + 1));
    for (const row of denied) {
      expect(row).toMatchObject({
        kind: 'auth',
        status: 'denied',
        userId: null,
        grantId: null,
        tokenId: null,
      });
      expect(['invalid_callback', 'unknown_state', 'missing_assertion']).toContain(row.errorCode);
    }
    expect(rows.filter((r) => r.kind === 'admin')).toEqual([]);
  });

  it('positive control: the chooser lists the providers; starting a login redirects to the IdP with PKCE', async () => {
    const chooser = await h.send(requestFor(route('/auth/login'), { headers: {} }));
    expect(chooser.status).toBe(200);
    expect(chooser.text).toContain('href="/auth/login/github"');
    expect(chooser.text).toContain('href="/auth/cf-access"');
    const start = await h.send(requestFor(route('/auth/login/:provider'), { headers: {} }));
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get('location') as string);
    expect(`${location.origin}${location.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(location.searchParams.get('redirect_uri')).toBe('http://localhost/auth/callback/github');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(start.headers.get('set-cookie')).toMatch(
      /^rb_login=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly/,
    );
    // Unknown providers are the ordinary 404.
    const unknown = await h.send(new Request('http://localhost/auth/login/nope'));
    expect(`${unknown.status} ${unknown.text}`).toBe('404 {"error":"not_found"}');
    expect(h.idpCalls).toEqual([]);
  });

  it.skipIf(authzHostKind() !== 'http-app')('do not exist unless sign-in is configured', async () => {
    const off = createHttpApp({ storage: h.world.storage, keyring: h.world.keyring, clock: h.world.clock });
    for (const r of IDENTITY_ROUTES) {
      const res = await h.send(requestFor(r, { headers: {} }), off);
      expect(`${res.status} ${res.text}`).toBe('404 {"error":"not_found"}');
    }
  });
});

describe('public routes', () => {
  it('answer the same to everyone and reveal nothing about callers or projects', async () => {
    const callers = [
      {},
      { authorization: `Bearer ${h.world.tokens.prod}` },
      { authorization: `Bearer ${ADMIN_TOKEN}` },
      { authorization: 'Bearer not-a-token' },
    ];
    for (const route of PUBLIC_ROUTES) {
      const answers = new Set<string>();
      for (const headers of callers) {
        const res = await h.send(requestFor(route, { headers }));
        expect(res.status).toBe(200);
        answers.add(res.text);
      }
      expect(answers.size, route.path).toBe(1);
      const body = JSON.parse([...answers][0] as string) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(route.path === '/health' ? ['status'] : ['name', 'version']);
    }
    // No row: public routes don't authenticate, so they can't fail authentication.
    expect(await h.auditRows()).toEqual([]);
  });

  it('unknown routes are the same 404 for everyone', async () => {
    const answers = new Set<string>();
    for (const headers of [{}, { authorization: `Bearer ${h.world.tokens.prod}` }]) {
      for (const path of ['/admin-panel', '/p/prod', '/p/prod/mcp/extra', '/api/admin/v2/users', '/.env']) {
        const res = await h.send(new Request(`http://localhost${path}`, { headers }));
        answers.add(`${res.status} ${res.text}`);
      }
    }
    expect([...answers]).toEqual(['404 {"error":"not_found"}']);
  });
});

// Hono's route table belongs to the HTTP app; the Worker mounts that same app, so the guard runs once there.
describe.skipIf(authzHostKind() !== 'http-app')('guard: every route is in the matrix', () => {
  /** Hono's route table of a fully configured app (admin API and CORS on). */
  function discover(): { handlers: Set<string>; wildcards: Set<string> } {
    const app = createHttpApp({
      storage: h.world.storage,
      keyring: h.world.keyring,
      corsOrigins: ['https://app.example.com'],
      admin: { token: new Secret(ADMIN_TOKEN), storage: h.world.storage },
      passthrough: {},
      identity: {
        publicUrl: 'http://localhost',
        providers: [],
        policy: { emails: [], domains: [], githubOrgs: [], autoProvision: 'off' },
        storage: h.world.storage,
      },
      // The built-in consent screen (P5-04) adds its routes.
      oauth: {},
    });
    const handlers = new Set<string>();
    const wildcards = new Set<string>();
    for (const r of app.routes) {
      if (r.method === 'ALL') wildcards.add(r.path);
      else handlers.add(`${r.method} ${r.path}`);
    }
    return { handlers, wildcards };
  }

  it('fails when the app serves a route the matrix does not list, or the matrix lists a gone route', () => {
    const { handlers, wildcards } = discover();
    const listed = new Set(
      [
        ...MCP_ROUTES,
        ...PASSTHROUGH_ROUTES,
        ...ADMIN_ROUTES,
        ...IDENTITY_ROUTES,
        ...UI_ROUTES,
        ...UI_ASSET_ROUTES,
        ...PUBLIC_ROUTES,
        ...OAUTH_ROUTES,
        ...CONSENT_ROUTES,
      ]
        .filter((r) => !r.pattern.endsWith('/*'))
        .map((r) => `${r.method} ${r.pattern}`),
    );
    const unlisted = [...handlers].filter((r) => !listed.has(r));
    const gone = [...listed].filter((r) => !handlers.has(r));
    expect(unlisted, 'routes missing from test/authz/matrix.ts').toEqual([]);
    expect(gone, 'matrix routes the app no longer serves').toEqual([]);
    // Middleware and catch-alls: each one is known and explained; a new one needs a matrix decision.
    const wild = [...wildcards].filter((p) => p !== '/p/*'); // CORS preflight middleware (on when configured)
    expect(wild.sort()).toEqual(Object.keys(WILDCARD_ROUTES).sort());
  });

  it('the matrix covers every MCP deny reason the resolver and the token check can give', () => {
    const covered = new Set(MCP_PRINCIPALS.map((p) => p.reason));
    // Reachable only through corrupt storage or a caller bug, covered by the resolver's unit tests (P2-04).
    const unitOnly = new Set([
      'invalid_request',
      'grant_not_found',
      'principal_mismatch',
      'user_not_found',
      'credential_missing',
      'credential_not_found',
      'invalid_config',
    ]);
    const missing = DENY_REASONS.filter((r) => !covered.has(r) && !unitOnly.has(r));
    expect(missing).toEqual([]);
    for (const r of [
      'missing_token',
      'malformed_header',
      'malformed',
      'bad_checksum',
      'unknown',
      'revoked',
      'expired',
    ]) {
      expect(covered.has(r), r).toBe(true);
    }
  });
});

describe('config export / import (P7-06)', () => {
  const KEY_OWN = 'NRAK-CONFIGOWNKEY0123456789ABCDEF';
  const KEY_OTHER = 'NRAK-CONFIGOTHERKEY0123456789ABCD';
  const wrapKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const kdf = {
    name: 'pbkdf2-sha256',
    iterations: 600_000,
    salt: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))),
  };
  const exportRoute = (): RouteCase =>
    ADMIN_ROUTES.find((r) => r.pattern.endsWith('/config/export')) as RouteCase;
  const importRoute = (): RouteCase =>
    ADMIN_ROUTES.find((r) => r.pattern.endsWith('/config/import')) as RouteCase;
  const withBody = (route: RouteCase, body: unknown): RouteCase => ({ ...route, body });

  async function addKey(ownerUserId: string, key: string, label: string) {
    const { createCredential } = await import('@relic-bridge/auth');
    await createCredential(
      {
        storage: h.world.storage,
        keyring: h.world.keyring,
        clock: h.world.clock,
        validate: async () => ({
          user: { id: 7, email: 'a@example.com', name: 'A' },
          accounts: [{ id: 1, name: 'one' }],
        }),
      },
      { label, region: 'US', apiKey: new Secret(key), ownerUserId },
    );
  }

  it("an owner session seals its own personal keys but never a colleague's", async () => {
    const owner = await h.addSession({ role: 'owner' });
    const other = await h.addUser('colleague@example.com', 'member');
    await addKey(owner.userId, KEY_OWN, 'own');
    await addKey(other, KEY_OTHER, 'theirs');
    const res = await h.send(
      requestFor(withBody(exportRoute(), { wrapKey, kdf }), { headers: owner.headers }),
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text);
    expect(body.data.credentials.map((c: { label: string }) => c.label).sort()).toContain('theirs');
    expect(body.warnings.some((w: string) => w.includes('personal key of another user'))).toBe(true);
    expect(res.text).not.toContain(KEY_OWN);
    expect(res.text).not.toContain(KEY_OTHER);
    expect(body.data.secrets.sealed.length).toBeGreaterThan(40);
    // The audit row names who and how much, never a value.
    const row = (await h.auditRows()).find((r) => r.action === 'config.export');
    expect(row).toMatchObject({ status: 'ok', userId: owner.userId });
  });

  it('admin and member sessions, and callers without credentials, are refused and nothing changes', async () => {
    for (const route of [exportRoute(), importRoute()]) {
      for (const role of ['admin', 'member'] as const) {
        const session = await h.addSession({ role });
        const before = JSON.stringify(await h.world.storage.projects.list());
        const res = await h.send(requestFor(route, { headers: session.headers }));
        expect(res.status, `${role} ${route.pattern}`).toBe(403);
        expect(JSON.parse(res.text).error).toMatchObject({ code: 'forbidden', detail: 'role' });
        expect(JSON.stringify(await h.world.storage.projects.list())).toBe(before);
      }
      expect((await h.send(requestFor(route, { headers: {} }))).status).toBe(401);
      expect((await h.send(requestFor(route, { headers: { authorization: 'Bearer nope' } }))).status).toBe(
        401,
      );
    }
  });

  it('an apply from an admin session creates nothing', async () => {
    const admin = await h.addSession({ role: 'admin' });
    const bundle = {
      format: 'relic-bridge-config',
      version: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      users: [{ email: 'intruder@example.com', displayName: null, role: 'owner' }],
      credentials: [],
      projects: [],
      grants: [],
      settings: {},
    };
    const users = JSON.stringify((await h.world.storage.users.list()).map((u) => u.id));
    const res = await h.send(
      requestFor(withBody(importRoute(), { bundle, apply: true }), { headers: admin.headers }),
    );
    expect(res.status).toBe(403);
    expect(JSON.stringify((await h.world.storage.users.list()).map((u) => u.id))).toBe(users);
  });
});
