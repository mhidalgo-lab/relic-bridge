// SPDX-License-Identifier: Apache-2.0
// The Worker host inside workerd (P3-01): MCP through the Worker's fetch, fail-closed boot, per-isolate runtime,
// `waitUntil` audit writes and the client address from `CF-Connecting-IP`.
import { env } from 'cloudflare:workers';
import type { FetchLike } from '@relic-bridge/core';
import { MigrationError } from '@relic-bridge/storage';
import { describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env.ts';
import { BOOT_BACKOFF_MS, BOOT_RETRY_MS, createWorker, type OpenStorage } from '../src/worker.ts';
import { call, connect, fakeCtx, mockNerdGraph, NR_KEY, seed } from './helpers.ts';

const MASTER_KEY = env.RB_MASTER_KEY as string;
const ADMIN_TOKEN = env.RB_ADMIN_TOKEN as string;

function logs(): { sink: (line: string) => void; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  return { sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>), lines };
}

describe('Worker MCP endpoint', () => {
  it('serves initialize and tools/list for a device token', async () => {
    const { storage, token } = await seed(MASTER_KEY);
    const nerdgraph = mockNerdGraph();
    const worker = createWorker({ openStorage: () => storage, fetch: nerdgraph.fetch, logSink: () => {} });
    const ctx = fakeCtx();
    const client = await connect(worker, env, ctx, token);
    expect(client.getServerVersion()?.name).toBe('relic-bridge');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('whoami');
    expect(tools.find((t) => t.name === 'run_nrql')?.annotations?.readOnlyHint).toBe(true);

    // A tool call reaches NerdGraph with the stored (decrypted) key and is audited in the background.
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    expect(result.isError ?? false).toBe(false);
    expect(nerdgraph.keys).toEqual([NR_KEY]);
    await client.close();
    await ctx.settle();
    expect(ctx.tasks.length).toBeGreaterThan(0);
    const rows = await storage.auditLog.list({ kind: 'tool_call' });
    expect(rows.map((r) => r.action)).toEqual(['whoami']);
  });

  it('answers 401 for a wrong token and records the CF-Connecting-IP address through waitUntil', async () => {
    const { storage } = await seed(MASTER_KEY);
    const worker = createWorker({ openStorage: () => storage, logSink: () => {} });
    const ctx = fakeCtx();
    const res = await call(worker, env, ctx, '/p/prod/mcp', {
      method: 'POST',
      ip: '203.0.113.7',
      headers: {
        Authorization: `Bearer rb_${'x'.repeat(40)}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    await ctx.settle();
    const [row] = await storage.auditLog.list({ action: 'auth.denied' });
    expect(row?.details).toMatchObject({ ip: '203.0.113.7' });
  });

  it('throttles auth failures per CF-Connecting-IP, not globally', async () => {
    const { storage } = await seed(MASTER_KEY);
    const worker = createWorker({ openStorage: () => storage, logSink: () => {} });
    const bad = (ip: string) =>
      call(worker, env, fakeCtx(), '/p/prod/mcp', {
        method: 'POST',
        ip,
        headers: { Authorization: `Bearer rb_${'y'.repeat(40)}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await bad('192.0.2.1')).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect((await bad('192.0.2.2')).status).toBe(401);
  });

  it('enables the admin API with the RB_ADMIN_TOKEN secret only', async () => {
    const { storage } = await seed(MASTER_KEY);
    const worker = createWorker({ openStorage: () => storage, logSink: () => {} });
    const admin = (token: string) =>
      call(worker, env, fakeCtx(), '/api/admin/v1/projects', {
        headers: { Authorization: `Bearer ${token}` },
      });
    expect((await admin(ADMIN_TOKEN)).status).toBe(200);
    expect((await admin(`${ADMIN_TOKEN}x`)).status).toBe(401);

    const noAdmin: WorkerEnv = { ...env, RB_ADMIN_TOKEN: undefined };
    const other = createWorker({ openStorage: () => storage, logSink: () => {} });
    const res = await call(other, noAdmin, fakeCtx(), '/api/admin/v1/projects', {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('Worker boot', () => {
  it('keeps one runtime per isolate (keyring, caches, app); concurrent cold requests share one boot', async () => {
    const { storage } = await seed(MASTER_KEY);
    let opened = 0;
    const openStorage: OpenStorage = () => {
      opened++;
      return storage;
    };
    const log = logs();
    const worker = createWorker({ openStorage, logSink: log.sink });
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => call(worker, env, fakeCtx(), '/health')),
    );
    expect(new Set(responses.map((r) => r.status))).toEqual(new Set([200]));
    expect(opened).toBe(1);
    // Later requests reuse the runtime that was kept.
    expect((await call(worker, env, fakeCtx(), '/version')).status).toBe(200);
    expect((await call(worker, env, fakeCtx(), '/health')).status).toBe(200);
    expect(opened).toBe(1);
    expect(log.lines.filter((l) => l['msg'] === 'worker runtime ready')).toHaveLength(1);
    expect(log.lines.find((l) => l['msg'] === 'worker runtime ready')).toMatchObject({
      plan: 'free',
      callBudget: 45,
    });
  });

  it('fails closed without the master key, backs off exponentially, and recovers with a fixed environment', async () => {
    const { storage } = await seed(MASTER_KEY);
    let t = 1_000_000;
    let opened = 0;
    const log = logs();
    const worker = createWorker({
      openStorage: () => {
        opened++;
        return storage;
      },
      logSink: log.sink,
      now: () => t,
    });
    const broken: WorkerEnv = { ...env, RB_MASTER_KEY: undefined };
    const failures = () => log.lines.filter((l) => l['msg'] === 'worker boot failed').length;
    const first = await call(worker, broken, fakeCtx(), '/health');
    expect(first.status).toBe(503);
    expect(first.headers.get('Retry-After')).toBe('5');
    const body = await first.text();
    expect(body).toBe('{"error":"unavailable"}');
    expect(log.lines.find((l) => l['msg'] === 'worker boot failed')).toMatchObject({
      error: 'CryptoError',
      code: 'master_key_missing',
    });
    // Within the window: no new boot attempt, a shrinking Retry-After.
    t += BOOT_RETRY_MS - 1000;
    const waiting = await call(worker, broken, fakeCtx(), '/health');
    expect(waiting.status).toBe(503);
    expect(waiting.headers.get('Retry-After')).toBe('1');
    expect(failures()).toBe(1);
    // Each later failure waits longer, up to the ceiling.
    for (let i = 0; i < BOOT_BACKOFF_MS.length; i++) {
      const step = BOOT_BACKOFF_MS[Math.min(i + 1, BOOT_BACKOFF_MS.length - 1)] as number;
      t += i === 0 ? 1000 : (BOOT_BACKOFF_MS[Math.min(i, BOOT_BACKOFF_MS.length - 1)] as number);
      const res = await call(worker, broken, fakeCtx(), '/health');
      expect(res.status).toBe(503);
      expect(failures()).toBe(i + 2);
      expect(res.headers.get('Retry-After')).toBe(String(step / 1000));
      expect(await res.text()).toBe(body);
    }
    const ceiling = BOOT_BACKOFF_MS[BOOT_BACKOFF_MS.length - 1] as number;
    t += ceiling - 1;
    expect((await call(worker, broken, fakeCtx(), '/health')).status).toBe(503);
    expect(failures()).toBe(BOOT_BACKOFF_MS.length + 1);
    t += 1;
    expect((await call(worker, broken, fakeCtx(), '/health')).status).toBe(503);
    expect(failures()).toBe(BOOT_BACKOFF_MS.length + 2);
    expect(opened).toBe(0);
    // A fixed environment recovers within the ceiling (here at once: a new env), and the backoff is reset.
    expect((await call(worker, env, fakeCtx(), '/health')).status).toBe(200);
  });

  it('logs one failure for many concurrent requests on a failing boot', async () => {
    const log = logs();
    const worker = createWorker({ logSink: log.sink });
    const broken: WorkerEnv = { ...env, RB_MASTER_KEY: undefined };
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => call(worker, broken, fakeCtx(), '/health')),
    );
    expect(new Set(responses.map((r) => r.status))).toEqual(new Set([503]));
    expect(log.lines.filter((l) => l['msg'] === 'worker boot failed')).toHaveLength(1);
  });

  it('does not hang waiters when the boot owner never settles (cancelled request)', async () => {
    const { storage } = await seed(MASTER_KEY);
    let opened = 0;
    const openStorage: OpenStorage = () => {
      opened++;
      // The first boot's I/O never completes, as if its request had been cancelled.
      return opened === 1 ? new Promise<never>(() => {}) : storage;
    };
    const worker = createWorker({ openStorage, logSink: () => {}, bootWaitMs: 30 });
    const stuck = call(worker, env, fakeCtx(), '/health');
    const waiters = await Promise.all([1, 2, 3].map(() => call(worker, env, fakeCtx(), '/health')));
    expect(waiters.map((r) => r.status)).toEqual([200, 200, 200]);
    // The waiters timed out together: one replacement boot, not one each.
    expect(opened).toBe(2);
    void stuck;
  });

  it('refuses a master key that does not match the stored key checks', async () => {
    const { storage } = await seed(MASTER_KEY);
    const log = logs();
    const worker = createWorker({ openStorage: () => storage, logSink: log.sink });
    const other = `v1:${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))}`;
    const res = await call(worker, { ...env, RB_MASTER_KEY: other }, fakeCtx(), '/health');
    expect(res.status).toBe(503);
    const line = log.lines.find((l) => l['msg'] === 'worker boot failed');
    expect(line?.['error']).toBe('CryptoError');
    expect(JSON.stringify(log.lines)).not.toContain(other.slice(3));
  });

  it('fails closed on invalid vars and names the variable', async () => {
    const { storage } = await seed(MASTER_KEY);
    for (const [name, value] of [
      ['RB_PLAN', 'enterprise'],
      ['RB_ACCESS_CACHE_TTL', '600'],
      ['RB_ADMIN_TOKEN', 'short'],
    ] as const) {
      const log = logs();
      const worker = createWorker({ openStorage: () => storage, logSink: log.sink });
      const res = await call(worker, { ...env, [name]: value }, fakeCtx(), '/health');
      expect(res.status, name).toBe(503);
      expect(
        log.lines.find((l) => l['msg'] === 'worker boot failed'),
        name,
      ).toMatchObject({
        error: 'WorkerConfigError',
        variable: name,
      });
      if (name === 'RB_ADMIN_TOKEN') expect(JSON.stringify(log.lines)).not.toContain('"short"');
    }
  });

  it('refuses a predictable or placeholder admin token at boot without logging it (P3-13)', async () => {
    const { storage } = await seed(MASTER_KEY);
    for (const value of ['a'.repeat(40), 'Xy7#kP2q'.repeat(5), `changeme-${ADMIN_TOKEN}`]) {
      const log = logs();
      const worker = createWorker({ openStorage: () => storage, logSink: log.sink });
      const res = await call(worker, { ...env, RB_ADMIN_TOKEN: value }, fakeCtx(), '/health');
      expect(res.status, value).toBe(503);
      const failure = log.lines.find((l) => l['msg'] === 'worker boot failed');
      expect(failure, value).toMatchObject({ error: 'WorkerConfigError', variable: 'RB_ADMIN_TOKEN' });
      expect(String(failure?.['detail'])).toMatch(/too predictable|placeholder/);
      expect(JSON.stringify(log.lines)).not.toContain(value.slice(0, 16));
    }
  });

  it('boots with a hand-made admin token but warns, without logging it (P3-13)', async () => {
    const { storage } = await seed(MASTER_KEY);
    const value = 'kitchen-window-garden-sofa-lamp-river';
    const log = logs();
    const worker = createWorker({ openStorage: () => storage, logSink: log.sink });
    expect((await call(worker, { ...env, RB_ADMIN_TOKEN: value }, fakeCtx(), '/health')).status).toBe(200);
    expect(log.lines.some((l) => String(l['msg']).includes('does not look randomly generated'))).toBe(true);
    expect(JSON.stringify(log.lines)).not.toContain(value);
    // The generated test token does not warn.
    const quiet = logs();
    const ok = createWorker({ openStorage: () => storage, logSink: quiet.sink });
    expect((await call(ok, env, fakeCtx(), '/health')).status).toBe(200);
    expect(quiet.lines.some((l) => String(l['msg']).includes('does not look randomly generated'))).toBe(
      false,
    );
  });

  it('answers 503 while the storage cannot be opened (missing binding, failed migration)', async () => {
    const log = logs();
    const noDb = createWorker({ logSink: log.sink });
    const res = await call(noDb, { ...env, DB: undefined }, fakeCtx(), '/p/prod/mcp', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(log.lines.find((l) => l['msg'] === 'worker boot failed')).toMatchObject({
      error: 'WorkerStorageUnavailableError',
      detail: 'the DB (D1) binding is missing',
    });
    const broken = createWorker({
      logSink: log.sink,
      openStorage: () => {
        throw new MigrationError('database schema version 99 is newer than this build');
      },
    });
    expect((await call(broken, env, fakeCtx(), '/health')).status).toBe(503);
    expect(log.lines.filter((l) => l['msg'] === 'worker boot failed').at(-1)).toMatchObject({
      error: 'MigrationError',
      code: 'migration',
    });
  });
});

describe('Plan limits', () => {
  const withVars = (vars: Record<string, string>): WorkerEnv => ({ ...env, ...vars }) as WorkerEnv;
  const text = (result: unknown): string =>
    ((result as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('\n');

  it('hides tools the budget cannot pay for and says so in whoami', async () => {
    const { storage, token } = await seed(MASTER_KEY);
    const worker = createWorker({
      openStorage: () => storage,
      fetch: mockNerdGraph().fetch,
      logSink: () => {},
    });
    const small = withVars({ RB_CALL_BUDGET: '5' });
    const client = await connect(worker, small, fakeCtx(), token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('run_nrql');
    expect(names).not.toContain('get_golden_metrics');
    const who = await client.callTool({ name: 'whoami', arguments: {} });
    expect(text(who)).toMatch(/Not offered here: get_golden_metrics/);
    expect(
      (who as { structuredContent?: { limits?: { callBudget?: number } } }).structuredContent?.limits,
    ).toMatchObject({ callBudget: 5 });
    await client.close();
  });

  it('applies the plan response ceiling to the connection limits', async () => {
    const { storage, token } = await seed(MASTER_KEY);
    const worker = createWorker({
      openStorage: () => storage,
      fetch: mockNerdGraph().fetch,
      logSink: () => {},
    });
    const client = await connect(worker, withVars({ RB_MAX_RESPONSE_BYTES: '4096' }), fakeCtx(), token);
    const who = await client.callTool({ name: 'whoami', arguments: {} });
    expect(
      (who as { structuredContent?: { limits?: { maxResponseBytes?: number } } }).structuredContent?.limits,
    ).toMatchObject({ maxResponseBytes: 4096 });
    await client.close();
  });

  it('a query that never finishes stops polling inside the budget and returns a handle, not an error', async () => {
    const { storage, token } = await seed(MASTER_KEY);
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      const container = { results: [], queryProgress: { completed: false, queryId: 'q-1', retryAfter: 0 } };
      return new Response(
        JSON.stringify({ data: { actor: { account: { nrql: container, nrqlQueryProgress: container } } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const worker = createWorker({ openStorage: () => storage, fetch, logSink: () => {} });
    // Budget 4 = one submit plus the three default polls; a budget of 3 would hide run_nrql, so go through 4.
    const client = await connect(worker, withVars({ RB_CALL_BUDGET: '4' }), fakeCtx(), token);
    const result = await client.callTool({
      name: 'run_nrql',
      arguments: { nrql: 'SELECT count(*) FROM Transaction' },
    });
    expect(result.isError ?? false).toBe(false);
    expect(text(result)).toMatch(/q-1/);
    expect(calls).toBeLessThanOrEqual(4);
    await client.close();
  }, 20_000);

  it('a failing NerdGraph is a tool error within the budget, never a 500', async () => {
    const { storage, token } = await seed(MASTER_KEY);
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      return new Response('{}', { status: 503 });
    };
    const worker = createWorker({ openStorage: () => storage, fetch, logSink: () => {} });
    const client = await connect(worker, withVars({ RB_CALL_BUDGET: '4' }), fakeCtx(), token);
    const result = await client.callTool({
      name: 'run_nrql',
      arguments: { nrql: 'SELECT count(*) FROM Transaction' },
    });
    expect(result.isError).toBe(true);
    expect(calls).toBeLessThanOrEqual(4);
    await client.close();
  }, 30_000);
});
