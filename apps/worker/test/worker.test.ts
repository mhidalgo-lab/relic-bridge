// SPDX-License-Identifier: Apache-2.0
// The Worker host inside workerd (P3-01): MCP through the Worker's fetch, fail-closed boot, per-isolate runtime,
// `waitUntil` audit writes and the client address from `CF-Connecting-IP`.
import { env } from 'cloudflare:workers';
import { MigrationError } from '@relic-bridge/storage';
import { describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env.ts';
import { BOOT_RETRY_MS, createWorker, type OpenStorage } from '../src/worker.ts';
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
  it('keeps one runtime per isolate (keyring, caches, app); concurrent cold requests boot on their own', async () => {
    const { storage } = await seed(MASTER_KEY);
    let opened = 0;
    const openStorage: OpenStorage = () => {
      opened++;
      return storage;
    };
    const log = logs();
    const worker = createWorker({ openStorage, logSink: log.sink });
    // No request awaits another request's boot (workerd ties I/O to the request that started it).
    const responses = await Promise.all([1, 2, 3].map(() => call(worker, env, fakeCtx(), '/health')));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(opened).toBe(3);
    // Later requests reuse the runtime that was kept.
    expect((await call(worker, env, fakeCtx(), '/version')).status).toBe(200);
    expect((await call(worker, env, fakeCtx(), '/health')).status).toBe(200);
    expect(opened).toBe(3);
    expect(log.lines.filter((l) => l['msg'] === 'worker runtime ready')).toHaveLength(1);
    expect(log.lines.find((l) => l['msg'] === 'worker runtime ready')).toMatchObject({
      plan: 'free',
      callBudget: 50,
    });
  });

  it('fails closed without the master key, then retries after the backoff window', async () => {
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
    const first = await call(worker, broken, fakeCtx(), '/health');
    expect(first.status).toBe(503);
    expect(first.headers.get('Retry-After')).toBe('5');
    expect(await first.text()).toBe('{"error":"unavailable"}');
    expect(log.lines.find((l) => l['msg'] === 'worker boot failed')).toMatchObject({
      error: 'CryptoError',
      code: 'master_key_missing',
    });
    // Within the window: no new boot attempt.
    t += BOOT_RETRY_MS - 1;
    expect((await call(worker, broken, fakeCtx(), '/health')).status).toBe(503);
    expect(log.lines.filter((l) => l['msg'] === 'worker boot failed')).toHaveLength(1);
    // After it: the boot runs again (and the storage was never opened without a key).
    t += 2;
    expect((await call(worker, broken, fakeCtx(), '/health')).status).toBe(503);
    expect(log.lines.filter((l) => l['msg'] === 'worker boot failed')).toHaveLength(2);
    expect(opened).toBe(0);
    // A fixed environment (a new deployment hands the isolate a new env) boots at once.
    expect((await call(worker, env, fakeCtx(), '/health')).status).toBe(200);
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
      ['RB_PASSTHROUGH', 'on'],
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
