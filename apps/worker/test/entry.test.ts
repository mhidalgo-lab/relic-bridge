// SPDX-License-Identifier: Apache-2.0
// The deployed entry (`src/index.ts` via `wrangler.jsonc`) inside workerd, on the local D1 database: bindings exist,
// the default storage is D1 (migrated at boot), and MCP works end to end with a token issued through storage.

import { env, exports } from 'cloudflare:workers';
import type { D1Database } from '@cloudflare/workers-types';
import { generateTokenString } from '@relic-bridge/auth';
import { createD1Storage, type D1DatabaseLike, type D1PreparedStatementLike } from '@relic-bridge/storage/d1';
import { describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env.ts';
import { createWorker, type WorkerHandler } from '../src/worker.ts';
import { call, connect, fakeCtx, seed, wipeD1 } from './helpers.ts';

const MASTER_KEY = env.RB_MASTER_KEY as string;

/** The deployed entry as a handler (it reads its own `env`; ours is ignored). */
const deployed: WorkerHandler = {
  scheduled: async () => {},
  fetch: (request) => exports.default.fetch(request),
};

/** A D1 binding that counts round trips (`all`/`run`/`batch`) and records the SQL of each. */
function countingD1(db: D1Database): { db: D1DatabaseLike; calls: string[] } {
  const calls: string[] = [];
  const real = db as unknown as D1DatabaseLike;
  const unwrap = new WeakMap<D1PreparedStatementLike, D1PreparedStatementLike>();
  const wrap = (s: D1PreparedStatementLike, sql: string): D1PreparedStatementLike => {
    const w: D1PreparedStatementLike = {
      bind: (...values) => wrap(s.bind(...values), sql),
      all: () => {
        calls.push(sql);
        return s.all();
      },
      run: () => {
        calls.push(sql);
        return s.run();
      },
    };
    unwrap.set(w, s);
    return w;
  };
  return {
    calls,
    db: {
      prepare: (sql) => wrap(real.prepare(sql), sql),
      batch: (statements) => {
        calls.push('batch');
        return real.batch(statements.map((w) => unwrap.get(w) ?? w));
      },
    },
  };
}

describe('Worker entry (wrangler.jsonc) on local D1', () => {
  it('declares the D1, KV and rate-limit bindings', () => {
    expect(typeof env.DB?.prepare).toBe('function');
    expect(typeof env.OAUTH_KV?.get).toBe('function');
    expect(typeof env.RATE_LIMITER?.limit).toBe('function');
    expect(env.RB_PLAN).toBe('free');
  });

  it('serves /health, then MCP initialize and tools/list with a token issued through D1 storage', async () => {
    // Health first: the entry boots and migrates the empty database itself.
    const health = await exports.default.fetch('https://rb.example.workers.dev/health');
    expect(health.status).toBe(200);
    expect(health.headers.get('Cache-Control')).toBe('no-store');

    const storage = await createD1Storage(env.DB as D1Database);
    const { token } = await seed(MASTER_KEY, storage);
    const ctx = fakeCtx();
    const client = await connect(deployed, env, ctx, token);
    expect(client.getServerVersion()?.name).toBe('relic-bridge');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('run_nrql');
    await client.close();

    const wrong = await call(deployed, env, ctx, '/p/prod/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.slice(0, -4)}AAAA`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(wrong.status).toBe(401);
  });

  it('resolves access from D1 on a cache miss and makes no D1 call on a cache hit', async () => {
    await wipeD1(env.DB as D1Database);
    const counted = countingD1(env.DB as D1Database);
    const storage = await createD1Storage(counted.db);
    const { token } = await seed(MASTER_KEY, storage);
    const worker = createWorker({ openStorage: () => storage, logSink: () => {} });
    // Audit off: its background inserts are writes, not access resolution.
    const workerEnv: WorkerEnv = { ...env, RB_AUDIT: 'off' };
    const ctx = fakeCtx();
    expect((await call(worker, workerEnv, ctx, '/health')).status).toBe(200); // boot: key checks

    let mark = counted.calls.length;
    const client = await connect(worker, workerEnv, ctx, token); // initialize: cache miss
    await ctx.settle();
    const miss = counted.calls.slice(mark);
    // P3-09: token, project, grant, user and credential in ONE batch round trip, plus the throttled last_used_at
    // write (in the background). Before: five reads in three round trips.
    const touch = (q: string): boolean => /^UPDATE access_tokens SET last_used_at/i.test(q);
    expect(miss.filter((q) => !touch(q))).toEqual(['batch']);
    expect(miss.filter(touch)).toHaveLength(1);

    mark = counted.calls.length;
    await client.listTools(); // cache hit
    await ctx.settle();
    expect(counted.calls.slice(mark)).toEqual([]);
    await client.close();
  });

  it('costs one D1 call for an unknown token and for a known token denied on another slug', async () => {
    await wipeD1(env.DB as D1Database);
    const counted = countingD1(env.DB as D1Database);
    const storage = await createD1Storage(counted.db);
    const { token } = await seed(MASTER_KEY, storage);
    const worker = createWorker({ openStorage: () => storage, logSink: () => {} });
    const workerEnv: WorkerEnv = { ...env, RB_AUDIT: 'off' };
    const ctx = fakeCtx();
    expect((await call(worker, workerEnv, ctx, '/health')).status).toBe(200);
    const garbage = `${token.slice(0, 8)}${'Z'.repeat(token.length - 8)}`;
    const attempt = async (bearer: string, slug: string): Promise<string[]> => {
      const mark = counted.calls.length;
      const res = await call(worker, workerEnv, ctx, `/p/${slug}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(401);
      await ctx.settle();
      return counted.calls.slice(mark).filter((q) => !/^UPDATE access_tokens SET last_used_at/i.test(q));
    };
    // A garbage token (bad checksum) is refused offline; an unknown token and a known one denied on another slug
    // cost the same single call (before P3-09: one read vs. three round trips).
    expect(await attempt(garbage, 'prod')).toEqual([]);
    expect(await attempt(generateTokenString(), 'prod')).toEqual(['batch']);
    expect(await attempt(token, 'other')).toEqual(['batch']);
  });
});
