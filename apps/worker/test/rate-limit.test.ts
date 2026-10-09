// SPDX-License-Identifier: Apache-2.0
// Rate limiting on Workers (P3-04): the layered limiter, the Worker wiring (binding as shared backstop, fail open,
// per-IP auth-failure throttle per isolate) and the pass-through prerequisites (shared fingerprint secret + binding).

import { env } from 'cloudflare:workers';
import type { RateLimit } from '@cloudflare/workers-types';
import { MemoryRateLimiter } from '@relic-bridge/http-app';
import { describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env.ts';
import { SHARED_KEY_PREFIXES, WorkersRateLimiter } from '../src/rate-limit.ts';
import { createWorker } from '../src/worker.ts';
import { call, fakeCtx, mockNerdGraph, NR_KEY, seed } from './helpers.ts';

const MASTER_KEY = env.RB_MASTER_KEY as string;
const rule = { requests: 3, perSeconds: 60 };

function fakeBinding(answer: (key: string) => boolean | Error = () => true): RateLimit & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }) => {
      keys.push(key);
      const r = answer(key);
      if (r instanceof Error) throw r;
      return { success: r };
    },
  };
}

describe('WorkersRateLimiter', () => {
  it('enforces the exact rule per isolate and asks the binding only for shared namespaces', async () => {
    const binding = fakeBinding();
    const rl = new WorkersRateLimiter({ binding });
    for (let i = 0; i < 3; i++) expect((await rl.take('token:t1', rule)).allowed).toBe(true);
    expect((await rl.take('token:t1', rule)).allowed).toBe(false);
    // The refused call never reached the binding.
    expect(binding.keys).toEqual(['token:t1', 'token:t1', 'token:t1']);
    await rl.take('fail:1.2.3.4', rule);
    expect(binding.keys).not.toContain('fail:1.2.3.4');
    expect(SHARED_KEY_PREFIXES).toEqual(['ip:', 'token:', 'grant:', 'key:']);
  });

  it('refuses when the binding refuses (another isolate or location used the allowance)', async () => {
    const rl = new WorkersRateLimiter({ binding: fakeBinding(() => false), bindingPeriodSeconds: 10 });
    expect(await rl.take('grant:g', rule)).toEqual({ allowed: false, retryAfterMs: 10_000, remaining: 0 });
  });

  it('peek consumes nothing and never calls the binding', async () => {
    const binding = fakeBinding();
    const rl = new WorkersRateLimiter({ binding, local: new MemoryRateLimiter() });
    for (let i = 0; i < 5; i++) expect((await rl.peek('ip:x', rule)).allowed).toBe(true);
    expect(binding.keys).toEqual([]);
    for (let i = 0; i < 3; i++) await rl.take('ip:x', rule);
    expect((await rl.peek('ip:x', rule)).allowed).toBe(false);
  });

  it('works without a binding (isolate buckets only) and lets a binding error propagate to the fail-open guard', async () => {
    const local = new WorkersRateLimiter();
    expect((await local.take('ip:x', rule)).allowed).toBe(true);
    const broken = new WorkersRateLimiter({ binding: fakeBinding(() => new Error('down')) });
    await expect(broken.take('ip:x', rule)).rejects.toThrow('down');
  });
});

const headers = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};
const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
});

describe('Worker rate limiting', () => {
  it('counts per-IP requests in the binding under the client address and 429s when it refuses', async () => {
    const { storage, token } = await seed(MASTER_KEY);
    const binding = fakeBinding((key) => key !== 'ip:192.0.2.9');
    const e: WorkerEnv = { ...env, RATE_LIMITER: binding };
    const worker = createWorker({ openStorage: () => storage, logSink: () => {} });
    const ok = await call(worker, e, fakeCtx(), '/p/prod/mcp', {
      method: 'POST',
      ip: '192.0.2.8',
      headers: { ...headers, Authorization: `Bearer ${token}` },
      body: initialize,
    });
    expect(ok.status).toBe(200);
    expect(binding.keys).toContain('ip:192.0.2.8');
    expect(binding.keys.some((k) => k.startsWith('token:'))).toBe(true);
    expect(binding.keys.some((k) => k.startsWith('grant:'))).toBe(true);

    const limited = await call(worker, e, fakeCtx(), '/p/prod/mcp', {
      method: 'POST',
      ip: '192.0.2.9',
      headers: { ...headers, Authorization: `Bearer ${token}` },
      body: initialize,
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
  });

  it('fails open and logs when the binding throws', async () => {
    const { storage, token } = await seed(MASTER_KEY);
    const lines: string[] = [];
    const e: WorkerEnv = { ...env, RATE_LIMITER: fakeBinding(() => new Error('boom')) };
    const worker = createWorker({ openStorage: () => storage, logSink: (l) => lines.push(l) });
    const res = await call(worker, e, fakeCtx(), '/p/prod/mcp', {
      method: 'POST',
      ip: '192.0.2.8',
      headers: { ...headers, Authorization: `Bearer ${token}` },
      body: initialize,
    });
    expect(res.status).toBe(200);
    expect(lines.some((l) => l.includes('rate limiter failed (allowing)'))).toBe(true);
  });

  it('the auth-failure throttle (isolate-local, peek) never reaches the binding and spares other addresses', async () => {
    const { storage } = await seed(MASTER_KEY);
    const binding = fakeBinding();
    const e: WorkerEnv = { ...env, RATE_LIMITER: binding };
    const worker = createWorker({ openStorage: () => storage, logSink: () => {} });
    const bad = (ip: string) =>
      call(worker, e, fakeCtx(), '/p/prod/mcp', {
        method: 'POST',
        ip,
        headers: { ...headers, Authorization: `Bearer rb_${'z'.repeat(40)}` },
        body: '{}',
      });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await bad('198.51.100.1')).status);
    expect(statuses.at(-1)).toBe(429);
    expect((await bad('198.51.100.2')).status).toBe(401);
    expect(binding.keys.every((k) => !k.startsWith('fail:'))).toBe(true);
  });

  it('serves the valid MCP and admin tokens from an IP that sprayed bad ones (P3-13, review M6)', async () => {
    const { storage, token } = await seed(MASTER_KEY);
    const e: WorkerEnv = { ...env, RATE_LIMITER: fakeBinding() };
    const worker = createWorker({ openStorage: () => storage, logSink: () => {} });
    const ip = '198.51.100.7';
    const mcp = (bearer: string) =>
      call(worker, e, fakeCtx(), '/p/prod/mcp', {
        method: 'POST',
        ip,
        headers: { ...headers, Authorization: `Bearer ${bearer}` },
        body: initialize,
      });
    const admin = (bearer: string) =>
      call(worker, e, fakeCtx(), '/api/admin/v1/projects', {
        ip,
        headers: { Authorization: `Bearer ${bearer}` },
      });
    for (let i = 0; i < 6; i++) await mcp(`rb_${'z'.repeat(40)}`);
    for (let i = 0; i < 6; i++) await admin(`not-the-admin-token-${i}-${'q'.repeat(24)}`);
    // Locked for failures, on both routes.
    expect((await mcp(`rb_${'z'.repeat(40)}`)).status).toBe(429);
    expect((await admin(`not-the-admin-token-x-${'q'.repeat(24)}`)).status).toBe(429);
    // The valid tokens are served.
    expect((await mcp(token)).status).toBe(200);
    expect((await admin(env.RB_ADMIN_TOKEN as string)).status).toBe(200);
    // And the lock still holds for failures.
    expect((await mcp(`rb_${'z'.repeat(40)}`)).status).toBe(429);
  });

  it('boots without the binding (isolate buckets) and warns', async () => {
    const { storage } = await seed(MASTER_KEY);
    const lines: string[] = [];
    const e: WorkerEnv = { ...env, RATE_LIMITER: undefined };
    const worker = createWorker({ openStorage: () => storage, logSink: (l) => lines.push(l) });
    expect((await call(worker, e, fakeCtx(), '/health')).status).toBe(200);
    expect(lines.some((l) => l.includes('RATE_LIMITER binding missing'))).toBe(true);
  });
});

describe('pass-through on Workers', () => {
  const secret = 'f'.repeat(48);
  const ptCall = (worker: ReturnType<typeof createWorker>, e: WorkerEnv) =>
    call(worker, e, fakeCtx(), '/passthrough/mcp', {
      method: 'POST',
      ip: '192.0.2.50',
      headers: { ...headers, 'X-NewRelic-Api-Key': NR_KEY },
      body: initialize,
    });

  it('refuses to boot without the fingerprint secret or the binding', async () => {
    const { storage } = await seed(MASTER_KEY);
    const lines: string[] = [];
    const base: WorkerEnv = { ...env, RB_PASSTHROUGH: 'on', RATE_LIMITER: fakeBinding() };
    const w1 = createWorker({ openStorage: () => storage, logSink: (l) => lines.push(l) });
    expect((await call(w1, base, fakeCtx(), '/health')).status).toBe(503);
    const w2 = createWorker({ openStorage: () => storage, logSink: (l) => lines.push(l) });
    const noBinding: WorkerEnv = { ...base, RB_FINGERPRINT_SECRET: secret, RATE_LIMITER: undefined };
    expect((await call(w2, noBinding, fakeCtx(), '/health')).status).toBe(503);
    const w3 = createWorker({ openStorage: () => storage, logSink: (l) => lines.push(l) });
    const short: WorkerEnv = { ...base, RB_FINGERPRINT_SECRET: 'short' };
    expect((await call(w3, short, fakeCtx(), '/health')).status).toBe(503);
    expect(lines.filter((l) => l.includes('RB_FINGERPRINT_SECRET')).length).toBeGreaterThanOrEqual(2);
    expect(lines.filter((l) => l.includes(secret))).toEqual([]);
  });

  it('two isolates sharing the secret charge the same limiter key; the key itself never reaches it', async () => {
    const { storage } = await seed(MASTER_KEY);
    const binding = fakeBinding();
    const e: WorkerEnv = {
      ...env,
      RB_PASSTHROUGH: 'on',
      RB_FINGERPRINT_SECRET: secret,
      RATE_LIMITER: binding,
    };
    const open = () => storage;
    const a = createWorker({ openStorage: open, fetch: mockNerdGraph().fetch, logSink: () => {} });
    const b = createWorker({ openStorage: open, fetch: mockNerdGraph().fetch, logSink: () => {} });
    expect((await ptCall(a, e)).status).toBe(200);
    expect((await ptCall(b, e)).status).toBe(200);
    const keyed = binding.keys.filter((k) => k.startsWith('key:pt_'));
    expect(keyed).toHaveLength(2);
    expect(new Set(keyed).size).toBe(1);
    expect(binding.keys.join(' ')).not.toContain(NR_KEY);
  });
});
