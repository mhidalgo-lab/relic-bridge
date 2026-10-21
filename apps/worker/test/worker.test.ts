// SPDX-License-Identifier: Apache-2.0
// The Worker host inside workerd (P3-01): MCP through the Worker's fetch, fail-closed boot, per-isolate runtime,
// `waitUntil` audit writes and the client address from `CF-Connecting-IP`.
import { env } from 'cloudflare:workers';
import { generateMasterKey } from '@relic-bridge/auth';
import type { FetchLike } from '@relic-bridge/core';
import { MigrationError } from '@relic-bridge/storage';
import { describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env.ts';
import { BOOT_BACKOFF_MS, BOOT_RETRY_MS, createWorker, type OpenStorage } from '../src/worker.ts';
import { call, connect, fakeCtx, mockNerdGraph, NR_KEY, seed } from './helpers.ts';

const MASTER_KEY = env.RB_MASTER_KEY as string;
const ADMIN_TOKEN = env.RB_ADMIN_TOKEN as string;

/** The boot-failure 503 carries the security headers and HSTS (P8-66); returns the status. */
function unavailableStatus(res: Response): number {
  expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  return res.status;
}

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

  it('RB_TASKS: the extension is advertised by default and off removes it, with no task record (P7-34)', async () => {
    const TASKS = 'io.modelcontextprotocol/tasks';
    const rpc = async (vars: Record<string, string>, method: string, params: Record<string, unknown>) => {
      const { storage, token } = await seed(MASTER_KEY);
      const worker = createWorker({
        openStorage: () => storage,
        fetch: mockNerdGraph().fetch,
        logSink: () => {},
      });
      const res = await call(worker, { ...env, ...vars } as WorkerEnv, fakeCtx(), '/p/prod/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-method': method,
          'mcp-protocol-version': '2026-07-28',
          ...(typeof params['taskId'] === 'string' ? { 'mcp-name': params['taskId'] } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'worker-test', version: '0' },
              'io.modelcontextprotocol/clientCapabilities': { extensions: { [TASKS]: {} } },
            },
          },
        }),
      });
      return { text: await res.text(), storage };
    };
    expect((await rpc({}, 'server/discover', {})).text).toContain(TASKS);
    const off = await rpc({ RB_TASKS: 'off' }, 'server/discover', {});
    expect(off.text).not.toContain(TASKS);
    const get = await rpc({ RB_TASKS: 'off' }, 'tasks/get', { taskId: 'x'.repeat(43) });
    expect(get.text).toContain('-32601');
    expect(await get.storage.kv.list({ prefix: 'task:' })).toMatchObject({ keys: [] });
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

  it('logs one warning per deprecated variable once per isolate, never its value (P8-67)', async () => {
    const { storage } = await seed(MASTER_KEY);
    const log = logs();
    const worker = createWorker({
      openStorage: () => storage,
      logSink: log.sink,
      deprecations: [
        {
          name: 'RB_OLD_THING',
          kind: 'env',
          replacement: 'RB_NEW_THING',
          deprecatedIn: '0.1.0',
          removedIn: '999.0.0',
          docs: 'docs/guide/versioning.md',
        },
      ],
    });
    const withOld = { ...env, RB_OLD_THING: 'value-not-logged' } as WorkerEnv;
    for (let i = 0; i < 3; i++) expect((await call(worker, withOld, fakeCtx(), '/health')).status).toBe(200);
    const warned = log.lines.filter((l) => String(l['msg']).includes('RB_OLD_THING'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ level: 'warn' });
    expect(String(warned[0]?.['msg'])).toContain('RB_NEW_THING');
    expect(JSON.stringify(log.lines)).not.toContain('value-not-logged');
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
    expect(unavailableStatus(first)).toBe(503);
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
    expect(unavailableStatus(waiting)).toBe(503);
    expect(waiting.headers.get('Retry-After')).toBe('1');
    expect(failures()).toBe(1);
    // Each later failure waits longer, up to the ceiling.
    for (let i = 0; i < BOOT_BACKOFF_MS.length; i++) {
      const step = BOOT_BACKOFF_MS[Math.min(i + 1, BOOT_BACKOFF_MS.length - 1)] as number;
      t += i === 0 ? 1000 : (BOOT_BACKOFF_MS[Math.min(i, BOOT_BACKOFF_MS.length - 1)] as number);
      const res = await call(worker, broken, fakeCtx(), '/health');
      expect(unavailableStatus(res)).toBe(503);
      expect(failures()).toBe(i + 2);
      expect(res.headers.get('Retry-After')).toBe(String(step / 1000));
      expect(await res.text()).toBe(body);
    }
    const ceiling = BOOT_BACKOFF_MS[BOOT_BACKOFF_MS.length - 1] as number;
    t += ceiling - 1;
    expect(unavailableStatus(await call(worker, broken, fakeCtx(), '/health'))).toBe(503);
    expect(failures()).toBe(BOOT_BACKOFF_MS.length + 1);
    t += 1;
    expect(unavailableStatus(await call(worker, broken, fakeCtx(), '/health'))).toBe(503);
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
    expect(new Set(responses.map(unavailableStatus))).toEqual(new Set([503]));
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
    expect(unavailableStatus(res)).toBe(503);
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
      expect(unavailableStatus(res), name).toBe(503);
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
      expect(unavailableStatus(res), value).toBe(503);
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

  it('warns at boot, without ids or keys, when credentials sit under a key version the keyring lacks (P3-15)', async () => {
    const { storage } = await seed(generateMasterKey(1));
    const k2 = generateMasterKey(2);
    const log = logs();
    const worker = createWorker({ openStorage: () => storage, logSink: log.sink });
    expect((await call(worker, { ...env, RB_MASTER_KEY: k2 }, fakeCtx(), '/health')).status).toBe(200);
    const warning = log.lines.find((l) => String(l['msg']).includes('cannot be decrypted'));
    expect(warning).toMatchObject({ level: 'warn', unreadable: [{ version: 1, rows: 1 }] });
    expect(JSON.stringify(log.lines)).not.toContain(k2.split(':')[1] as string);
    // A healthy deployment stays quiet.
    const quiet = logs();
    const healthy = await seed(MASTER_KEY);
    const okWorker = createWorker({ openStorage: () => healthy.storage, logSink: quiet.sink });
    expect((await call(okWorker, env, fakeCtx(), '/health')).status).toBe(200);
    expect(quiet.lines.some((l) => String(l['msg']).includes('cannot be decrypted'))).toBe(false);
  });

  it('caps keys/rotate batchSize at 40 on the Free plan, not on Paid (P3-15)', async () => {
    const { storage } = await seed(MASTER_KEY);
    const batchSizes: Record<string, unknown[]> = {};
    for (const plan of ['free', 'paid']) {
      const worker = createWorker({ openStorage: () => storage, logSink: () => {} });
      const ctx = fakeCtx();
      const res = await call(worker, { ...env, RB_PLAN: plan }, ctx, '/api/admin/v1/keys/rotate', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ batchSize: 100 }),
      });
      expect(res.status, plan).toBe(200);
      await ctx.settle();
      batchSizes[plan] = (await storage.auditLog.list({ action: 'keys.rotate' })).map(
        (r) => r.details?.['batchSize'],
      );
    }
    expect(batchSizes['free']).toEqual([40]);
    expect(batchSizes['paid']).toEqual([100, 40]);
  });

  it('answers 503 while the storage cannot be opened (missing binding, failed migration)', async () => {
    const log = logs();
    const noDb = createWorker({ logSink: log.sink });
    const res = await call(noDb, { ...env, DB: undefined }, fakeCtx(), '/p/prod/mcp', { method: 'POST' });
    expect(unavailableStatus(res)).toBe(503);
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
    expect(unavailableStatus(await call(broken, env, fakeCtx(), '/health'))).toBe(503);
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
      (who as { structuredContent?: { limits?: { perCallBudget?: number } } }).structuredContent?.limits,
    ).toMatchObject({ perCallBudget: 5 });
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

describe('Self-monitoring (P7-08)', () => {
  const event = (r: Request) => new URL(r.url).pathname;

  it('is off by default: no export happens', async () => {
    const { storage, token } = await seed(MASTER_KEY);
    const sent: string[] = [];
    const worker = createWorker({
      openStorage: () => storage,
      fetch: mockNerdGraph().fetch,
      telemetryFetch: async (url) => {
        sent.push(String(url));
        return new Response('{}');
      },
      logSink: () => {},
    });
    const ctx = fakeCtx();
    const client = await connect(worker, env, ctx, token);
    await client.callTool({ name: 'whoami', arguments: {} });
    await client.close();
    await ctx.settle();
    expect(sent).toEqual([]);
  });

  it('exports through waitUntil when RB_OTEL=on, with the headers from the secret', async () => {
    const { storage, token } = await seed(MASTER_KEY);
    const sent: { path: string; key: string | null; body: string }[] = [];
    const worker = createWorker({
      openStorage: () => storage,
      fetch: mockNerdGraph().fetch,
      telemetryFetch: async (url, init) => {
        // A real workerd Request from the exporter's init: workerd rejects options it does not support (P8-65).
        const request = new Request(String(url), init);
        expect(request.redirect).toBe('manual');
        sent.push({
          path: event(request),
          key: new Headers(init.headers).get('api-key'),
          body: String(init.body),
        });
        return new Response('{}');
      },
      logSink: () => {},
    });
    const otelEnv = {
      ...env,
      RB_OTEL: 'on',
      RB_OTEL_ENDPOINT: 'https://otlp.example.test:4318',
      RB_OTEL_HEADERS: 'api-key=fake-license-key',
    } as WorkerEnv;
    const ctx = fakeCtx();
    const client = await connect(worker, otelEnv, ctx, token);
    await client.callTool({ name: 'whoami', arguments: {} });
    await client.close();
    await ctx.settle();
    // P7-18: the request log lines (allowlisted) ride along with the first call's export.
    expect([...new Set(sent.map((s) => s.path))].sort()).toEqual(['/v1/logs', '/v1/metrics', '/v1/traces']);
    expect(sent.every((s) => s.key === 'fake-license-key')).toBe(true);
    expect(sent.map((s) => s.body).join('')).not.toContain('a@example.com');
    expect(sent.map((s) => s.body).join('')).not.toContain('fake-license-key');
  });

  it('log lines written inside a tool call carry the span ids in workerd, and a span exists per MCP method (P8-90)', async () => {
    const { storage, token } = await seed(MASTER_KEY);
    const sent: { path: string; body: string }[] = [];
    const stderr = logs();
    const worker = createWorker({
      openStorage: () => storage,
      fetch: mockNerdGraph().fetch,
      telemetryFetch: async (url, init) => {
        sent.push({ path: event(new Request(String(url), init)), body: String(init.body) });
        return new Response('{}');
      },
      logSink: stderr.sink,
    });
    const otelEnv = {
      ...env,
      RB_OTEL: 'on',
      RB_OTEL_ENDPOINT: 'https://otlp.example.test:4318',
      RB_OTEL_HEADERS: 'api-key=fake-license-key',
    } as WorkerEnv;
    const ctx = fakeCtx();
    const client = await connect(worker, otelEnv, ctx, token);
    await client.listTools();
    // A tool error logs `tool error` from inside the call.
    await client.callTool({ name: 'get_query_result', arguments: { query_id: 'nope', account: 1 } });
    await client.close();
    await ctx.settle();
    // biome-ignore lint/suspicious/noExplicitAny: raw OTLP JSON
    const spans: any[] = sent
      .filter((s) => s.path === '/v1/traces')
      .flatMap((s) => JSON.parse(s.body).resourceSpans[0].scopeSpans[0].spans);
    const toolSpan = spans.find((s) => s.name === 'tools/call get_query_result');
    // A caller error leaves the span status Unset (P8-98) but names the code in error.type.
    expect(toolSpan.status.code).toBe(0);
    expect(toolSpan.attributes.find((a: { key: string }) => a.key === 'error.type').value.stringValue).toBe(
      'RB_QUERY_NOT_FOUND',
    );
    expect(spans.some((s) => s.name === 'tools/list')).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: raw OTLP JSON
    const records: any[] = sent
      .filter((s) => s.path === '/v1/logs')
      .flatMap((s) => JSON.parse(s.body).resourceLogs[0].scopeLogs[0].logRecords);
    const toolError = records.find((r) => r.body.stringValue === 'tool error');
    expect(toolError.traceId).toBe(toolSpan.traceId);
    expect(toolError.spanId).toBe(toolSpan.spanId);
    // The same ids are on the structured log line (Workers Logs), so a line can be found from the trace and back.
    const line = stderr.lines.find((l) => l['msg'] === 'tool error');
    expect(line?.['traceId']).toBe(toolSpan.traceId);
    expect(line?.['spanId']).toBe(toolSpan.spanId);
  });

  it('2026-07-28 tasks/list and tasks/result answered -32601 are caller faults, not ok (P8-110)', async () => {
    const TASKS = 'io.modelcontextprotocol/tasks';
    for (const [method, params] of [
      ['tasks/list', {}],
      ['tasks/result', { taskId: 'task-1' }],
    ] as const) {
      const { storage, token } = await seed(MASTER_KEY);
      const sent: { path: string; body: string }[] = [];
      const worker = createWorker({
        openStorage: () => storage,
        fetch: mockNerdGraph().fetch,
        telemetryFetch: async (url, init) => {
          sent.push({ path: event(new Request(String(url), init)), body: String(init.body) });
          return new Response('{}');
        },
        logSink: () => {},
      });
      const otelEnv = {
        ...env,
        RB_OTEL: 'on',
        RB_OTEL_ENDPOINT: 'https://otlp.example.test:4318',
        RB_OTEL_HEADERS: 'api-key=fake-license-key',
      } as WorkerEnv;
      const ctx = fakeCtx();
      const res = await call(worker, otelEnv, ctx, '/p/prod/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-method': method,
          'mcp-protocol-version': '2026-07-28',
          ...(typeof params['taskId'] === 'string' ? { 'mcp-name': params['taskId'] } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'worker-test', version: '0' },
              'io.modelcontextprotocol/clientCapabilities': { extensions: { [TASKS]: {} } },
            },
          },
        }),
      });
      expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32601);
      await ctx.settle();
      // biome-ignore lint/suspicious/noExplicitAny: raw OTLP JSON
      const spans: any[] = sent
        .filter((s) => s.path === '/v1/traces')
        .flatMap((s) => JSON.parse(s.body).resourceSpans[0].scopeSpans[0].spans);
      const span = spans.find((s) => s.name === method);
      expect(span.status.code).toBe(0);
      const attr = (key: string) =>
        span.attributes.find((a: { key: string }) => a.key === key)?.value.stringValue;
      expect(attr('fault')).toBe('caller');
      expect(attr('error.type')).toBe('-32601');
    }
  });

  it('legacy-session tasks/list answered as an SSE -32601 is a caller fault, not ok (P8-110)', async () => {
    const { storage, token } = await seed(MASTER_KEY);
    const sent: { path: string; body: string }[] = [];
    const worker = createWorker({
      openStorage: () => storage,
      fetch: mockNerdGraph().fetch,
      telemetryFetch: async (url, init) => {
        sent.push({ path: event(new Request(String(url), init)), body: String(init.body) });
        return new Response('{}');
      },
      logSink: () => {},
    });
    const otelEnv = {
      ...env,
      RB_OTEL: 'on',
      RB_OTEL_ENDPOINT: 'https://otlp.example.test:4318',
      RB_OTEL_HEADERS: 'api-key=fake-license-key',
    } as WorkerEnv;
    const ctx = fakeCtx();
    const post = (headers: Record<string, string>, body: unknown) =>
      call(worker, otelEnv, ctx, '/p/prod/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: JSON.stringify(body),
      });
    const init = await post(
      {},
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'legacy', version: '0' },
        },
      },
    );
    await init.text();
    const session = {
      'mcp-session-id': init.headers.get('mcp-session-id') ?? '',
      'mcp-protocol-version': '2025-06-18',
    };
    await (await post(session, { jsonrpc: '2.0', method: 'notifications/initialized' })).text();
    const res = await post(session, { jsonrpc: '2.0', id: 5, method: 'tasks/list', params: {} });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await res.text()).toContain('-32601');
    await ctx.settle();
    // biome-ignore lint/suspicious/noExplicitAny: raw OTLP JSON
    const spans: any[] = sent
      .filter((s) => s.path === '/v1/traces')
      .flatMap((s) => JSON.parse(s.body).resourceSpans[0].scopeSpans[0].spans);
    const span = spans.find((s) => s.name === 'tasks/list');
    expect(span.status.code).toBe(0);
    const attr = (key: string) =>
      span.attributes.find((a: { key: string }) => a.key === key)?.value.stringValue;
    expect(attr('fault')).toBe('caller');
    expect(attr('error.type')).toBe('-32601');
  });

  it('fails the boot closed on RB_OTEL=on without an endpoint', async () => {
    const { storage } = await seed(MASTER_KEY);
    const worker = createWorker({ openStorage: () => storage, logSink: () => {} });
    const res = await call(worker, { ...env, RB_OTEL: 'on' } as WorkerEnv, fakeCtx(), '/health');
    expect(unavailableStatus(res)).toBe(503);
  });
});

// P8-76 (THREAT_MODEL T24): the Host and Origin checks hold in the Worker itself with RB_ALLOWED_HOSTS set, on the MCP
// route and the admin pages, before authentication. The authz matrix's Worker host runs with `*` (no `allowedHosts`).
describe('Worker Host and Origin checks (RB_ALLOWED_HOSTS)', () => {
  const HOST = 'mcp.example.com';
  const hostsEnv = { ...env, RB_ALLOWED_HOSTS: HOST } as WorkerEnv;
  const INIT = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'host-test', version: '0' },
    },
  });

  async function setup() {
    const { storage, token } = await seed(MASTER_KEY);
    const nerdgraph = mockNerdGraph();
    const worker = createWorker({ openStorage: () => storage, fetch: nerdgraph.fetch, logSink: () => {} });
    const send = (url: string, headers: Record<string, string>, method = 'POST') =>
      worker.fetch(
        new Request(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headers,
          },
          ...(method === 'POST' ? { body: INIT } : {}),
        }),
        hostsEnv,
        fakeCtx(),
      );
    return { send, nerdgraph };
  }

  it('refuses a Host outside the list on /p/:slug/mcp and /admin, before any NerdGraph call', async () => {
    const { send, nerdgraph } = await setup();
    for (const path of ['/p/prod/mcp', '/admin']) {
      const method = path === '/admin' ? 'GET' : 'POST';
      for (const url of [`https://evil.example${path}`, `https://${HOST}.evil.example${path}`]) {
        const res = await send(url, {}, method);
        expect(res.status, url).toBe(403);
        expect(await res.text(), url).toBe('{"error":"forbidden_host"}');
      }
      // A Host header naming another host, on a URL that names ours.
      const spoofed = await send(`https://${HOST}${path}`, { host: 'evil.example' }, method);
      expect(spoofed.status, `${path} host header`).toBe(403);
    }
    expect(nerdgraph.keys).toEqual([]);
    // Positive control: our own host gets in.
    const ok = await send(`https://${HOST}/p/prod/mcp`, {});
    expect(ok.status).toBe(200);
  });

  it('refuses a foreign or null Origin on /p/:slug/mcp and /admin; no Origin or our own passes', async () => {
    const { send, nerdgraph } = await setup();
    for (const path of ['/p/prod/mcp', '/admin']) {
      const method = path === '/admin' ? 'GET' : 'POST';
      for (const origin of [
        'https://evil.example',
        'null',
        `https://${HOST}.evil.example`,
        'not an origin',
      ]) {
        const res = await send(`https://${HOST}${path}`, { origin }, method);
        expect(res.status, `${path} ${origin}`).toBe(403);
        expect(await res.text(), `${path} ${origin}`).toBe('{"error":"forbidden_origin"}');
      }
    }
    expect(nerdgraph.keys).toEqual([]);
    for (const headers of [{}, { origin: `https://${HOST}` }]) {
      expect((await send(`https://${HOST}/p/prod/mcp`, headers)).status).toBe(200);
    }
  });
});
