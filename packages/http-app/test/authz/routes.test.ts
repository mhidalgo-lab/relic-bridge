// SPDX-License-Identifier: Apache-2.0
// Authorization matrix (P2-12, THREAT_MODEL T2/T3/T15/T19): every route × every kind of caller. A denial must be the
// route family's single answer (byte-identical apart from the request id), reach no credential or NerdGraph, write an
// `auth.denied` audit row with the stable reason, and leak no secret anywhere. Every MCP denial has a positive control:
// the same caller without the defect gets in.
import { DENY_REASONS } from '@relic-bridge/auth';
import { Secret } from '@relic-bridge/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHttpApp } from '../../src/index.ts';
import { ADMIN_TOKEN, type Captured, createHarness, type Harness } from './harness.ts';
import {
  ADMIN_PRINCIPALS,
  ADMIN_ROUTES,
  MCP_PRINCIPALS,
  MCP_ROUTES,
  PUBLIC_ROUTES,
  type RouteCase,
  requestFor,
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

describe('admin routes × principals', () => {
  for (const principal of ADMIN_PRINCIPALS) {
    it(`${principal.name} → 401 (${principal.reason}) on every admin route`, async () => {
      const presented = await principal.present(h);
      const users = (await h.world.storage.users.list()).length;
      const adminRows = (await h.world.storage.auditLog.list({ kind: 'admin' })).length;
      for (const route of ADMIN_ROUTES) {
        const reference = await h.send(requestFor(route, { headers: {} }));
        expect(reference.status).toBe(401);
        expect(JSON.parse(reference.text)).toEqual({
          error: { code: 'unauthorized', message: 'admin authentication required' },
        });
        expect(reference.headers.get('www-authenticate')).toBe('Bearer realm="relic-bridge-admin"');
        const res = await h.send(requestFor(route, presented));
        await expectDenied(route, reference, res, principal.reason, principal.name);
      }
      // Nothing changed and no admin action was recorded.
      expect((await h.world.storage.users.list()).length).toBe(users);
      expect((await h.world.storage.auditLog.list({ kind: 'admin' })).length).toBe(adminRows);
      expect(h.nerdGraph.calls).toEqual([]);
    });
  }

  it('positive control: the admin token passes authentication on every admin route', async () => {
    for (const route of ADMIN_ROUTES) {
      const res = await h.send(requestFor(route, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }));
      expect(res.status, `${route.method} ${route.path}`).not.toBe(401);
    }
  });

  it('every admin route is 404 when the admin API is off, whatever the caller presents', async () => {
    const off = createHttpApp({ storage: h.world.storage, keyring: h.world.keyring, clock: h.world.clock });
    for (const route of ADMIN_ROUTES) {
      for (const headers of [{}, { authorization: `Bearer ${ADMIN_TOKEN}` }]) {
        const res = await h.send(requestFor(route, { headers }), off);
        expect(res.status).toBe(404);
        expect(res.text).toBe('{"error":"not_found"}');
      }
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
      for (const path of ['/admin', '/p/prod', '/p/prod/mcp/extra', '/api/admin/v2/users', '/.env']) {
        const res = await h.send(new Request(`http://localhost${path}`, { headers }));
        answers.add(`${res.status} ${res.text}`);
      }
    }
    expect([...answers]).toEqual(['404 {"error":"not_found"}']);
  });
});

describe('guard: every route is in the matrix', () => {
  /** Hono's route table of a fully configured app (admin API and CORS on). */
  function discover(): { handlers: Set<string>; wildcards: Set<string> } {
    const app = createHttpApp({
      storage: h.world.storage,
      keyring: h.world.keyring,
      corsOrigins: ['https://app.example.com'],
      admin: { token: new Secret(ADMIN_TOKEN), storage: h.world.storage },
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
      [...MCP_ROUTES, ...ADMIN_ROUTES, ...PUBLIC_ROUTES]
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
