// SPDX-License-Identifier: Apache-2.0
// P4-01 on Workers (workerd, local D1): sign-in through generic OIDC and Cloudflare Access against the mock IdP
// (jose on WebCrypto in workerd), login state in D1 `kv` (single use across Worker instances), a setup link that
// makes the owner, and the boot refusal of half-configured sign-in.
import { env } from 'cloudflare:workers';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1Storage } from '@relic-bridge/storage/d1';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CF_AUD,
  CF_TEAM,
  createMockIdp,
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  MOCK_ISSUER,
  type MockIdp,
} from '../../../packages/auth/test/mock-idp.ts';
import type { WorkerEnv } from '../src/env.ts';
import { createWorker } from '../src/worker.ts';
import { fakeCtx, wipeD1 } from './helpers.ts';

const db = env.DB as D1Database;
const ADMIN = env.RB_ADMIN_TOKEN as string;
const PUBLIC = 'https://bridge.example.com';

let idp: MockIdp;
let lines: string[];

const signInEnv = (over: Record<string, string> = {}): WorkerEnv => ({
  ...(env as WorkerEnv),
  RB_PUBLIC_URL: PUBLIC,
  RB_OIDC_ISSUER: MOCK_ISSUER,
  RB_OIDC_CLIENT_ID: MOCK_CLIENT_ID,
  RB_OIDC_CLIENT_SECRET: MOCK_CLIENT_SECRET,
  RB_CF_ACCESS_TEAM: CF_TEAM,
  RB_CF_ACCESS_AUD: CF_AUD,
  RB_RATE_LIMIT: 'off',
  ...over,
});

const worker = () => createWorker({ identityFetch: idp.fetch, logSink: (l) => lines.push(l) });

async function send(
  w: ReturnType<typeof createWorker>,
  workerEnv: WorkerEnv,
  path: string,
  init: RequestInit = {},
) {
  const ctx = fakeCtx();
  const res = await w.fetch(new Request(`${PUBLIC}${path}`, init), workerEnv, ctx);
  const text = await res.text();
  await ctx.settle();
  return { res, text };
}

beforeEach(async () => {
  await wipeD1(db);
  await createD1Storage(db); // migrations
  idp = await createMockIdp();
  lines = [];
});

describe('sign-in on the Worker', () => {
  it('a setup link + OIDC login makes the owner; the state is single use across isolates', async () => {
    const workerEnv = signInEnv();
    const a = worker();
    const issued = await send(a, workerEnv, '/api/admin/v1/setup-links', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'oidc' }),
    });
    expect(issued.res.status).toBe(201);
    const link = new URL((JSON.parse(issued.text) as { data: { url: string } }).data.url);

    const start = await send(a, workerEnv, `${link.pathname}${link.search}`);
    expect(start.res.status).toBe(302);
    const cookie = (start.res.headers.get('set-cookie') ?? '').split(';')[0] as string;
    expect(cookie).toMatch(/^__Host-rb_login=/);
    const callback = await idp.authorize(start.res.headers.get('location') as string);
    // Another isolate (another Worker instance) finishes the login: the transaction lives in D1.
    const b = worker();
    const done = await send(b, workerEnv, `${callback.pathname}${callback.search}`, { headers: { cookie } });
    expect(done.res.status).toBe(200);
    expect(done.text).toContain('Signed in as owner@example.com (owner)');
    // Replay on the first isolate: consumed.
    const replay = await send(a, workerEnv, `${callback.pathname}${callback.search}`, {
      headers: { cookie },
    });
    expect(replay.res.status).toBe(400);

    const storage = await createD1Storage(db);
    expect((await storage.users.list()).map((u) => [u.email, u.role, u.idp])).toEqual([
      ['owner@example.com', 'owner', 'oidc:oidc'],
    ]);
    const actions = (await storage.auditLog.list({ limit: 50 })).map((r) => `${r.action}:${r.status}`);
    expect(actions).toEqual(
      expect.arrayContaining(['setup_link.create:ok', 'login.ok:ok', 'login.denied:denied']),
    );
    const out = lines.join('\n');
    expect(out).not.toContain(MOCK_CLIENT_SECRET);
    expect(out).not.toContain(link.searchParams.get('setup') as string);
  });

  it('Cloudflare Access: a valid assertion signs in a pre-created user; wrong AUD and expiry are refused', async () => {
    const storage = await createD1Storage(db);
    await storage.users.create({ id: 'usr_cf', email: 'owner@example.com', role: 'admin' });
    const w = worker();
    const workerEnv = signInEnv();
    const ok = await send(w, workerEnv, '/auth/cf-access', {
      headers: { 'cf-access-jwt-assertion': await idp.accessAssertion() },
    });
    expect(ok.res.status).toBe(200);
    expect((await storage.users.get('usr_cf'))?.idp).toBe('cf-access');
    for (const claims of [{ aud: ['b'.repeat(64)] }, { exp: Math.floor(Date.now() / 1000) - 600 }]) {
      const res = await send(w, workerEnv, '/auth/cf-access', {
        headers: { 'cf-access-jwt-assertion': await idp.accessAssertion(claims) },
      });
      expect(res.res.status).toBe(403);
    }
  });

  it('a half-configured provider or a public host outside RB_ALLOWED_HOSTS fails the boot', async () => {
    for (const over of [
      { RB_OIDC_CLIENT_SECRET: '' },
      { RB_PUBLIC_URL: 'http://bridge.example.com' },
      { RB_ALLOWED_HOSTS: 'other.example.com' },
    ]) {
      lines = [];
      const res = await send(worker(), signInEnv(over), '/health');
      expect(res.res.status).toBe(503);
      expect(lines.join('\n')).toContain('worker boot failed');
    }
    // Sign-in off: the routes don't exist.
    const off = await send(worker(), { ...(env as WorkerEnv), RB_RATE_LIMIT: 'off' }, '/auth/login');
    expect(off.res.status).toBe(404);
  });
});
