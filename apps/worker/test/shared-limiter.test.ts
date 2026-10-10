// SPDX-License-Identifier: Apache-2.0
// The Durable Object limiter (P7-10) inside workerd with real object stubs: the concurrency semaphore (FIFO slots,
// leases, wait timeouts), the persisted token buckets (eviction, cleanup alarm), the Workers rate limiter on top of
// it, and the Worker under load from several simulated isolates sharing one New Relic key.
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Client } from '@modelcontextprotocol/client';
import { setGrantQuota } from '@relic-bridge/auth';
import type { FetchLike } from '@relic-bridge/core';
import { createRateLimitHooks, type McpRequestInfo, MemoryRateLimiter } from '@relic-bridge/http-app';
import { createMemoryStorage, usagePeriods } from '@relic-bridge/storage';
import { describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env.ts';
import { DURABLE_KEY_PREFIXES, WorkersRateLimiter } from '../src/rate-limit.ts';
import { parseWorkerSettings, WorkerConfigError } from '../src/settings.ts';
import {
  type AcquireResult,
  createDurableQuotaStore,
  createSharedConcurrency,
  type SharedLimiterNamespace,
  type SharedLimiterRpc,
} from '../src/shared-limiter.ts';
import { createWorker } from '../src/worker.ts';
import { call, connect, fakeCtx, mockNerdGraph, NR_KEY, seed } from './helpers.ts';

const MASTER_KEY = env.RB_MASTER_KEY as string;
const ns = env.SHARED_LIMITER as SharedLimiterNamespace;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Object names no other test (or run) used: storage persists across tests in one workerd. */
const fresh = (prefix: string): SharedLimiterRpc => ns.getByName(`${prefix}${crypto.randomUUID()}`);
const state = <T>(p: Promise<T>, ms = 50): Promise<T | 'pending'> =>
  Promise.race([p, sleep(ms).then(() => 'pending' as const)]);
const lease = (r: AcquireResult): string => {
  if (!r.ok) throw new Error('expected a slot');
  return r.lease;
};

describe('SharedLimiter: concurrency', () => {
  it('grants up to max slots and hands freed ones to waiters in order', async () => {
    const stub = fresh('concurrency:');
    const a = lease(await stub.acquire(2, 60_000, 5_000));
    const b = lease(await stub.acquire(2, 60_000, 5_000));
    const c = stub.acquire(2, 60_000, 5_000);
    const d = stub.acquire(2, 60_000, 5_000);
    expect(await state(c)).toBe('pending');
    await stub.release(a);
    expect((await c).ok).toBe(true);
    expect(await state(d)).toBe('pending');
    await stub.release(b);
    expect((await d).ok).toBe(true);
  });

  it('a lease that is never released frees its slot when it expires (crashed or cancelled holder)', async () => {
    const stub = fresh('concurrency:');
    lease(await stub.acquire(1, 150, 5_000));
    const started = Date.now();
    const next = await stub.acquire(1, 60_000, 5_000);
    expect(next.ok).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it('a call that waits too long, or may not wait, is refused with the time until a slot frees', async () => {
    const stub = fresh('concurrency:');
    lease(await stub.acquire(1, 60_000, 0));
    const timedOut = await stub.acquire(1, 60_000, 50);
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) expect(timedOut.retryAfterMs).toBeGreaterThan(50_000);
    expect((await stub.acquire(1, 60_000, 0)).ok).toBe(false);
  });

  it('unknown and repeated releases are harmless and never free a second slot', async () => {
    const stub = fresh('concurrency:');
    await stub.release('not-a-lease');
    const a = lease(await stub.acquire(1, 60_000, 0));
    await stub.release(a);
    await stub.release(a);
    lease(await stub.acquire(1, 60_000, 0));
    expect((await stub.acquire(1, 60_000, 0)).ok).toBe(false);
  });

  it('refuses out-of-range arguments for good (without throwing across RPC)', async () => {
    const stub = fresh('concurrency:');
    const never = { ok: false, retryAfterMs: Number.POSITIVE_INFINITY };
    expect(await stub.acquire(0, 60_000, 0)).toEqual(never);
    expect(await stub.acquire(26, 60_000, 0)).toEqual(never);
    expect(await stub.acquire(1, 0, 0)).toEqual(never);
    expect(await stub.acquire(1, 60_000, 60_000)).toEqual(never);
  });

  it('keeps no storage for concurrency objects (counters in memory only)', async () => {
    const stub = fresh('concurrency:');
    lease(await stub.acquire(1, 60_000, 0));
    const keys = await runInDurableObject(stub, async (_i, s: DurableObjectState) => [
      ...(await s.storage.list()).keys(),
    ]);
    expect(keys).toEqual([]);
  });
});

describe('SharedLimiter: token buckets', () => {
  const rule = { requests: 3, perSeconds: 60 };

  it('takes, refuses and peeks like the isolate bucket, and survives eviction', async () => {
    const stub = fresh('fail:');
    for (let i = 0; i < 3; i++) expect((await stub.take(rule)).allowed).toBe(true);
    const refused = await stub.take(rule);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(15_000);
    expect((await stub.peek(rule)).allowed).toBe(false);
    await evictDurableObject(stub);
    expect((await stub.peek(rule)).allowed).toBe(false);
    expect((await stub.take(rule)).allowed).toBe(false);
  });

  it('peek stores nothing; a cost above capacity is refused for good', async () => {
    const stub = fresh('fail:');
    expect((await stub.peek(rule)).allowed).toBe(true);
    const big = await stub.take(rule, 4);
    expect(big.allowed).toBe(false);
    expect(big.retryAfterMs).toBe(Number.POSITIVE_INFINITY);
    const stored = await runInDurableObject(stub, (_i, s: DurableObjectState) => s.storage.get('bucket'));
    expect(stored).toBeUndefined();
    expect((await stub.take({ requests: 0, perSeconds: 1 })).allowed).toBe(false);
  });

  it('the alarm deletes a bucket once it is full again, and re-arms while it is not', async () => {
    const stub = fresh('signin:');
    await stub.take({ requests: 2, perSeconds: 60 });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const kept = await runInDurableObject(stub, async (_i, s: DurableObjectState) => ({
      bucket: await s.storage.get('bucket'),
      alarm: await s.storage.getAlarm(),
    }));
    expect(kept.bucket).toBeDefined();
    expect(kept.alarm).not.toBeNull();

    const quick = fresh('oauth:');
    await quick.take({ requests: 10, perSeconds: 1 });
    await sleep(150);
    // workerd may already have run the alarm on its own (it was due); run it now otherwise.
    await runDurableObjectAlarm(quick);
    const keys = await runInDurableObject(quick, async (_i, s: DurableObjectState) => [
      ...(await s.storage.list()).keys(),
    ]);
    expect(keys).toEqual([]);
    expect((await quick.peek({ requests: 10, perSeconds: 1 })).remaining).toBe(10);
  });
});

/** Records the object names asked for; optionally fails every call. */
function spyNamespace(fail = false): SharedLimiterNamespace & { names: string[] } {
  const names: string[] = [];
  return {
    names,
    getByName(name) {
      names.push(name);
      if (fail) throw new Error('durable object unavailable');
      return ns.getByName(name);
    },
  };
}

describe('WorkersRateLimiter with the shared limiter', () => {
  const rule = { requests: 3, perSeconds: 300 };

  it('counts fail:, signin:, oauth: and write: across isolates (take and peek)', async () => {
    expect(DURABLE_KEY_PREFIXES).toEqual(['fail:', 'signin:', 'oauth:', 'write:']);
    const durable = spyNamespace();
    const a = new WorkersRateLimiter({ durable });
    const b = new WorkersRateLimiter({ durable });
    const key = `fail:203.0.113.${Math.floor(Math.random() * 250)}-${crypto.randomUUID()}`;
    expect((await a.take(key, rule)).allowed).toBe(true);
    expect((await a.take(key, rule)).allowed).toBe(true);
    expect((await b.take(key, rule)).allowed).toBe(true);
    // Each isolate alone has tokens left; the deployment has none.
    expect((await b.take(key, rule)).allowed).toBe(false);
    expect((await a.peek(key, rule)).allowed).toBe(false);
    const write = `write:grt_${crypto.randomUUID()}`;
    for (let i = 0; i < 3; i++) await [a, b][i % 2]?.take(write, rule);
    expect((await b.take(write, rule)).allowed).toBe(false);
  });

  it('leaves ip:, token:, grant: and key: to the binding and the isolate', async () => {
    const durable = spyNamespace();
    const rl = new WorkersRateLimiter({ durable });
    for (const k of ['ip:x', 'token:t', 'grant:g', 'key:k']) await rl.take(k, rule);
    expect(await rl.peek('ip:x', rule)).toMatchObject({ allowed: true });
    expect(durable.names).toEqual([]);
  });

  it('an unreachable object degrades to the isolate bucket (a limit, never unlimited) and logs', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = {
      warn: (msg: string, f?: Record<string, unknown>) => lines.push({ msg, ...f }),
    } as unknown as import('@relic-bridge/core').Logger;
    const rl = new WorkersRateLimiter({
      durable: spyNamespace(true),
      logger,
      local: new MemoryRateLimiter(),
    });
    for (let i = 0; i < 3; i++) expect((await rl.take('fail:198.51.100.3', rule)).allowed).toBe(true);
    expect((await rl.take('fail:198.51.100.3', rule)).allowed).toBe(false);
    expect((await rl.peek('fail:198.51.100.3', rule)).allowed).toBe(false);
    expect(lines[0]).toMatchObject({ msg: expect.stringContaining('per isolate'), check: 'fail:' });
    expect(JSON.stringify(lines)).not.toContain('198.51.100.3');
  });
});

describe('write limit fails closed (P7-24)', () => {
  const rule = { requests: 3, perSeconds: 300 };

  it('refuses write: keys, take and peek, when the bound object is unreachable; reads keep the isolate fallback', async () => {
    const rl = new WorkersRateLimiter({ durable: spyNamespace(true), local: new MemoryRateLimiter() });
    expect(await rl.take('write:grt_1', rule)).toMatchObject({ allowed: false, retryAfterMs: 60_000 });
    expect(await rl.peek('write:grt_1', rule)).toMatchObject({ allowed: false });
    expect((await rl.take('fail:203.0.113.9', rule)).allowed).toBe(true);
    expect((await rl.take('grant:grt_1', rule)).allowed).toBe(true);
  });

  it('without the object, write: stays on the isolate bucket (the startup warning says so)', async () => {
    const rl = new WorkersRateLimiter({ local: new MemoryRateLimiter() });
    expect((await rl.take('write:grt_2', rule)).allowed).toBe(true);
  });

  it('a write tool call gets 429 while a read still passes through the hooks', async () => {
    const limiter = new WorkersRateLimiter({ durable: spyNamespace(true), local: new MemoryRateLimiter() });
    const hooks = createRateLimitHooks({ limiter, getClientIp: () => '203.0.113.7' });
    const info = (name: string): McpRequestInfo =>
      ({
        tokenId: 'tok_1',
        grantId: 'grt_3',
        listen: false,
        mcpMethod: 'tools/call',
        mcpName: name,
        access: { tools: ['whoami', 'acknowledge_issue'], rateLimit: null },
      }) as unknown as McpRequestInfo;
    const c = { get: () => undefined } as never;
    const write = await hooks.beforeMcp?.(c, info('acknowledge_issue'));
    expect(write?.status).toBe(429);
    expect(await hooks.beforeMcp?.(c, info('whoami'))).toBeUndefined();
  });

  it('charges one unit per confirmed elicitation write across isolates, on the Durable Object bucket (P7-35)', async () => {
    const durable = spyNamespace();
    const grantId = `grt_${crypto.randomUUID()}`;
    const hooks = (limiter: WorkersRateLimiter) =>
      createRateLimitHooks({
        limiter,
        rules: {
          ip: null,
          authFailures: null,
          token: null,
          grant: null,
          write: { requests: 2, perSeconds: 3600 },
        },
        getClientIp: () => '203.0.113.7',
      });
    const [a, b] = [new WorkersRateLimiter({ durable }), new WorkersRateLimiter({ durable })].map(hooks);
    const info = (writeRound: McpRequestInfo['writeRound']): McpRequestInfo =>
      ({
        tokenId: 'tok_1',
        grantId,
        listen: false,
        mcpMethod: 'tools/call',
        mcpName: 'close_issue',
        writeRound,
        access: { tools: ['close_issue'], rateLimit: null },
      }) as unknown as McpRequestInfo;
    const c = { get: () => undefined } as never;
    // Two writes, each a question round and an answered round, spread over two isolates.
    for (const hook of [a, b]) {
      expect(await hook?.beforeMcp?.(c, info('question'))).toBeUndefined();
      expect(await hook?.beforeMcp?.(c, info('answered'))).toBeUndefined();
    }
    // Question rounds and dry runs stay free; every shape that can mutate is refused, on either isolate.
    for (const hook of [a, b]) {
      expect(await hook?.beforeMcp?.(c, info('question'))).toBeUndefined();
      expect(await hook?.beforeMcp?.(c, info('dry_run'))).toBeUndefined();
      expect((await hook?.beforeMcp?.(c, info('answered')))?.status).toBe(429);
      expect((await hook?.beforeMcp?.(c, info('confirm')))?.status).toBe(429);
      expect((await hook?.beforeMcp?.(c, info(undefined)))?.status).toBe(429);
    }
    expect(durable.names.length).toBeGreaterThan(0);
  });

  it('RB_WRITE_TOOLS=on without the shared limiter warns', () => {
    const base = { RB_WRITE_TOOLS: 'on' };
    expect(parseWorkerSettings(base).warnings.join(' ')).toContain('without RB_SHARED_LIMITER');
    expect(parseWorkerSettings({ ...base, RB_SHARED_LIMITER: 'rules' }).warnings.join(' ')).not.toContain(
      'without RB_SHARED_LIMITER',
    );
  });
});

describe('createSharedConcurrency', () => {
  it('runs the task without a slot when the object is unreachable, and refuses when the queue times out', async () => {
    const warned: string[] = [];
    const logger = { warn: (m: string) => warned.push(m) } as unknown as import('@relic-bridge/core').Logger;
    const broken = createSharedConcurrency(spyNamespace(true), { max: 1, logger });
    expect(await broken('cred').run(async () => 42)).toBe(42);
    expect(warned[0]).toContain('per isolate');

    const limiter = createSharedConcurrency(ns, { max: 1, waitMs: 50 })(`c_${crypto.randomUUID()}`);
    let release!: () => void;
    const holding = limiter.run(() => new Promise<void>((r) => (release = r)));
    await sleep(20);
    await expect(limiter.run(async () => 1)).rejects.toMatchObject({ code: 'RB_LIMIT_RATE' });
    release();
    await holding;
    expect(await limiter.run(async () => 2)).toBe(2);
    expect(() => createSharedConcurrency(ns, { max: 0 })).toThrow(RangeError);
  });

  it('releases the slot when the task throws', async () => {
    const limiter = createSharedConcurrency(ns, { max: 1, waitMs: 0 })(`c_${crypto.randomUUID()}`);
    await expect(limiter.run(async () => Promise.reject(new Error('nerdgraph down')))).rejects.toThrow(
      'nerdgraph down',
    );
    expect(await limiter.run(async () => 'next')).toBe('next');
  });
});

describe('RB_SHARED_LIMITER settings and boot', () => {
  it('is off by default and accepts rules / on only', () => {
    expect(parseWorkerSettings({}).sharedLimiter).toBe('off');
    expect(parseWorkerSettings({ RB_SHARED_LIMITER: 'Rules' }).sharedLimiter).toBe('rules');
    expect(parseWorkerSettings({ RB_SHARED_LIMITER: 'on' }).sharedLimiter).toBe('on');
    expect(() => parseWorkerSettings({ RB_SHARED_LIMITER: 'yes' })).toThrow(WorkerConfigError);
    expect(
      parseWorkerSettings({ RB_SHARED_LIMITER: 'rules', RB_RATE_LIMIT: 'off' }).warnings.join(' '),
    ).toContain('no rules to share');
  });

  it('reports what it shares, and falls back with a warning when the binding is missing', async () => {
    const { storage } = await seed(MASTER_KEY);
    const boot = async (e: WorkerEnv) => {
      const lines: string[] = [];
      const w = createWorker({ openStorage: () => storage, logSink: (l) => lines.push(l) });
      expect((await call(w, e, fakeCtx(), '/health')).status).toBe(200);
      return lines.join('\n');
    };
    expect(await boot({ ...env })).toContain('"sharedLimiter":"off"');
    expect(await boot({ ...env, RB_SHARED_LIMITER: 'rules' })).toContain('"sharedLimiter":"rules"');
    expect(await boot({ ...env, RB_SHARED_LIMITER: 'on' })).toContain('"sharedLimiter":"rules+concurrency"');
    const missing = await boot({ ...env, RB_SHARED_LIMITER: 'on', SHARED_LIMITER: undefined });
    expect(missing).toContain('SHARED_LIMITER binding is missing');
    expect(missing).toContain('"sharedLimiter":"off"');
  });

  it('shares the auth-failure throttle between isolates when on', async () => {
    const { storage } = await seed(MASTER_KEY);
    const e: WorkerEnv = { ...env, RB_SHARED_LIMITER: 'rules' };
    const isolates = [0, 1, 2].map(() => createWorker({ openStorage: () => storage, logSink: () => {} }));
    const ip = `192.0.2.${100 + Math.floor(Math.random() * 100)}`;
    const statuses: number[] = [];
    // The default rule allows 10 failures per 5 minutes per address; spread over three isolates.
    for (let i = 0; i < 12; i++) {
      const w = isolates[i % 3] as ReturnType<typeof createWorker>;
      const res = await call(w, e, fakeCtx(), '/p/prod/mcp', {
        method: 'POST',
        ip,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer rb_${'z'.repeat(40)}` },
        body: '{}',
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

/**
 * NerdGraph stand-in that enforces a concurrency limit like New Relic does: above `limit` requests in flight for the
 * key it answers 429. Records the peak.
 */
function concurrencyLimitedNerdGraph(limit: number, holdMs: number) {
  let inFlight = 0;
  const stats = { peak: 0, calls: 0, tooMany: 0 };
  const fetch: FetchLike = async () => {
    inFlight++;
    stats.calls++;
    stats.peak = Math.max(stats.peak, inFlight);
    try {
      if (inFlight > limit) {
        stats.tooMany++;
        return new Response('{"errors":[{"message":"Too many concurrent requests"}]}', {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '1' },
        });
      }
      await sleep(holdMs);
      return new Response(
        JSON.stringify({
          data: {
            actor: { user: { id: 7, name: 'A', email: 'a@example.com' }, accounts: [{ id: 1, name: 'one' }] },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    } finally {
      inFlight--;
    }
  };
  return { fetch, stats };
}

/** 4 simulated isolates (separate Worker instances, each with its own runtime and semaphores) x 5 parallel calls. */
async function load(mode: 'off' | 'on') {
  const { storage, token } = await seed(MASTER_KEY);
  const nerdGraph = concurrencyLimitedNerdGraph(5, 40);
  const e: WorkerEnv = { ...env, RB_SHARED_LIMITER: mode, RB_CONCURRENCY: '5', RB_QUERY_CACHE: 'off' };
  const clients: Client[] = [];
  for (let i = 0; i < 4; i++) {
    const w = createWorker({ openStorage: () => storage, fetch: nerdGraph.fetch, logSink: () => {} });
    clients.push(await connect(w, e, fakeCtx(), token));
  }
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      (clients[i % 4] as Client).callTool({ name: 'whoami', arguments: {} }),
    ),
  );
  await Promise.all(clients.map((c) => c.close()));
  return { stats: nerdGraph.stats, errors: results.filter((r) => r.isError === true).length };
}

describe('20 parallel clients on one key across isolates', () => {
  it('without the shared limiter, isolates together exceed the key limit (baseline)', async () => {
    const { stats } = await load('off');
    expect(stats.peak).toBeGreaterThan(5);
    expect(stats.tooMany).toBeGreaterThan(0);
  });

  it('with RB_SHARED_LIMITER=on, never more than RB_CONCURRENCY calls in flight and no NerdGraph 429', async () => {
    const { stats, errors } = await load('on');
    expect(stats.peak).toBeLessThanOrEqual(5);
    expect(stats.tooMany).toBe(0);
    expect(errors).toBe(0);
    expect(stats.calls).toBe(20);
  });
});

describe('object names', () => {
  it('pass-through concurrency is keyed by the fingerprint id, never the New Relic key', async () => {
    const { storage } = await seed(MASTER_KEY);
    const durable = spyNamespace();
    const e: WorkerEnv = {
      ...env,
      RB_PASSTHROUGH: 'on',
      RB_FINGERPRINT_SECRET: 'f'.repeat(48),
      RB_SHARED_LIMITER: 'on',
      SHARED_LIMITER: durable,
    };
    const w = createWorker({ openStorage: () => storage, fetch: mockNerdGraph().fetch, logSink: () => {} });
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-NewRelic-Api-Key': NR_KEY,
    };
    const rpc = (id: number, method: string, params: Record<string, unknown>) =>
      call(w, e, fakeCtx(), '/passthrough/mcp', {
        method: 'POST',
        ip: '192.0.2.77',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
    const init = await rpc(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    });
    expect(init.status).toBe(200);
    const res = await rpc(2, 'tools/call', { name: 'whoami', arguments: {} });
    expect(res.status).toBe(200);
    const names = durable.names.filter((n) => n.startsWith('concurrency:'));
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => /^concurrency:pt_[0-9a-f]+$/.test(n))).toBe(true);
    expect(durable.names.join(' ')).not.toContain(NR_KEY);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Quota counters (P7-12)
// ---------------------------------------------------------------------------------------------------------------

const DAY = 'd2026-10-06';
const MONTH = 'm2026-10';

describe('SharedLimiter: quota counters', () => {
  it('reserve is atomic across concurrent callers: 40 calls against a cap of 10 succeed exactly 10 times', async () => {
    const stub = fresh('quota:');
    const results = await Promise.all(Array.from({ length: 40 }, () => stub.quotaReserve(DAY, 10)));
    expect(results.filter((r) => r !== null)).toHaveLength(10);
    expect((await stub.quotaGet([DAY]))[DAY]).toEqual({ queries: 10, inspected: 0 });
    // No cap counts without limit; a missing period is absent.
    expect((await stub.quotaReserve(MONTH, null))?.queries).toBe(1);
    expect(Object.keys(await stub.quotaGet([DAY, MONTH, 'd2026-01-01']))).toEqual([DAY, MONTH]);
  });

  it('adds inspected events, releases a query (never below zero) and ignores bad arguments', async () => {
    const stub = fresh('quota:');
    await Promise.all(Array.from({ length: 10 }, () => stub.quotaAdd(DAY, 3)));
    expect(await stub.quotaGet([DAY])).toEqual({ [DAY]: { queries: 0, inspected: 30 } });
    await stub.quotaReserve(DAY, null);
    await stub.quotaRelease(DAY);
    await stub.quotaRelease(DAY);
    expect((await stub.quotaGet([DAY]))[DAY]?.queries).toBe(0);
    expect(await stub.quotaReserve("d2026-10-06' OR 1=1", null)).toBeNull();
    expect(await stub.quotaReserve(DAY, 0)).toBeNull();
    expect((await stub.quotaAdd(DAY, -5)).inspected).toBe(30);
    expect(await stub.quotaGet([])).toEqual({});
    expect(await stub.quotaAdd('nonsense', 5)).toEqual({ queries: 0, inspected: 0 });
  });

  it('survives eviction, and the alarm drops periods that have ended but keeps the current ones', async () => {
    const stub = fresh('quota:');
    const now = usagePeriods(Date.now());
    await stub.quotaReserve(now.day, null);
    await stub.quotaReserve(now.month, null);
    // Periods long over: written through the API like any other, then dropped by the alarm.
    await stub.quotaReserve('d2020-01-01', null);
    await stub.quotaAdd('m2020-01', 9);
    await evictDurableObject(stub);
    expect((await stub.quotaGet([now.day]))[now.day]?.queries).toBe(1);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(Object.keys(await stub.quotaGet([now.day, now.month, 'd2020-01-01', 'm2020-01'])).sort()).toEqual(
      [now.day, now.month].sort(),
    );
    const alarm = await runInDurableObject(stub, (_i, s: DurableObjectState) => s.storage.getAlarm());
    expect(alarm).not.toBeNull();
  });
});

describe('createDurableQuotaStore', () => {
  it('uses the grant’s own object, and falls back to the storage counters (never unlimited) when it is unreachable', async () => {
    const storage = createMemoryStorage();
    await storage.projects.create({ id: 'p', slug: 'p', defaultAccountId: 1, allowedAccountIds: [1] });
    await storage.grants.create({ id: 'grt_q', projectId: 'p', label: 'svc' });
    const spy = spyNamespace();
    const store = createDurableQuotaStore(spy, { fallback: storage.grantUsage });
    expect(await store.reserve('grt_q', DAY, 2)).toEqual({ queries: 1, inspected: 0 });
    expect(spy.names).toEqual(['quota:grt_q']);
    expect(await storage.grantUsage.get('grt_q', [DAY])).toEqual({});

    const logs: string[] = [];
    const down = createDurableQuotaStore(spyNamespace(true), {
      fallback: storage.grantUsage,
      logger: {
        warn: (m: string) => logs.push(m),
        info: () => undefined,
        debug: () => undefined,
        error: () => undefined,
        child() {
          return this;
        },
      },
    });
    expect(await down.reserve('grt_q', DAY, 1)).toEqual({ queries: 1, inspected: 0 });
    expect(await down.reserve('grt_q', DAY, 1)).toBeNull();
    await down.addInspected('grt_q', DAY, 7);
    expect(await down.get('grt_q', [DAY])).toEqual({ [DAY]: { queries: 1, inspected: 7 } });
    expect(await down.getMany(['grt_q', 'other'], [DAY])).toEqual({
      grt_q: { [DAY]: { queries: 1, inspected: 7 } },
    });
    expect(logs.filter((l) => l.includes('quota counted in storage'))).toHaveLength(1);
  });
});

/** 4 simulated isolates x 5 parallel `whoami` calls against a grant capped at 8 calls a day. */
async function quotaLoad(mode: 'off' | 'on') {
  const { storage, token } = await seed(MASTER_KEY);
  const grant = (await storage.grants.list())[0];
  if (grant === undefined) throw new Error('no grant');
  await setGrantQuota(storage, grant.id, { day: { queries: 8 } });
  const nerdGraph = concurrencyLimitedNerdGraph(25, 5);
  const e: WorkerEnv = { ...env, RB_SHARED_LIMITER: mode, RB_QUERY_CACHE: 'off' };
  const clients: Client[] = [];
  for (let i = 0; i < 4; i++) {
    const w = createWorker({ openStorage: () => storage, fetch: nerdGraph.fetch, logSink: () => {} });
    clients.push(await connect(w, e, fakeCtx(), token));
  }
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      (clients[i % 4] as Client).callTool({ name: 'whoami', arguments: {} }),
    ),
  );
  await Promise.all(clients.map((c) => c.close()));
  const day = usagePeriods(Date.now()).day;
  return {
    ok: results.filter((r) => r.isError !== true).length,
    denied: results.filter((r) => r.isError === true).length,
    calls: nerdGraph.stats.calls,
    inStorage: (await storage.grantUsage.get(grant.id, [day]))[day]?.queries ?? 0,
    inObject: (await ns.getByName(`quota:${grant.id}`).quotaGet([day]))[day]?.queries ?? 0,
  };
}

describe('quota across isolates', () => {
  it('with storage counters (shared limiter off): exactly the cap gets through, counted in storage', async () => {
    const r = await quotaLoad('off');
    expect(r).toMatchObject({ ok: 8, denied: 12, inStorage: 8, inObject: 0 });
    expect(r.calls).toBe(8);
  });

  it('with the shared limiter on: exactly the cap gets through, counted in the grant’s object, not in storage', async () => {
    const r = await quotaLoad('on');
    expect(r).toMatchObject({ ok: 8, denied: 12, inStorage: 0, inObject: 8 });
    expect(r.calls).toBe(8);
  });
});
