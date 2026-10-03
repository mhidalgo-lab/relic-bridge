// SPDX-License-Identifier: Apache-2.0
// CPU benchmark of the Worker's hot paths (P3-10), inside workerd with the local D1 simulator and a mocked NerdGraph.
//
// Method: each scenario runs warmup + N iterations; every iteration is timed with `performance.now()` and the
// summary (p50/p95/mean, ms) goes to `task.meta.cpu`, which `scripts/bench-cpu.ts` reads from the JSON reporter.
// In production workerd freezes timers during CPU work (Spectre mitigation), but the local workerd that the Vitest
// plugin starts does not: an uninterrupted busy loop measures its real duration (checked when this was written; the
// `calibration` scenario would read 0 otherwise). Wall time includes local D1/SQLite I/O, so D1 scenarios overstate CPU
// a little, and the absolute numbers belong to this machine: the comparison with the baseline works on ratios to the
// calibration scenario. Background work (`waitUntil` audit rows) is settled outside the timed region.
import { env } from 'cloudflare:workers';
import type { D1Database } from '@cloudflare/workers-types';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/client';
import { authenticateAccess, Keyring, verifyAccessToken } from '@relic-bridge/auth';
import { createBuiltinTools, type FetchLike } from '@relic-bridge/core';
import type { Storage } from '@relic-bridge/storage';
import { createD1Storage } from '@relic-bridge/storage/d1';
import { beforeAll, describe, it } from 'vitest';
import type { WorkerEnv } from '../src/env.ts';
import { createWorker, type WorkerHandler } from '../src/worker.ts';
import { call, fakeCtx, seed, wipeD1 } from '../test/helpers.ts';

const MASTER_KEY = env.RB_MASTER_KEY as string;
const baseEnv = env as unknown as WorkerEnv;
const CATALOG = createBuiltinTools().map((t) => t.name);

interface CpuSummary {
  /**
   * The figure that is compared: mean of the fastest 90% of iterations. workerd's clock ticks in whole milliseconds,
   * so a median of fast iterations is quantised; the trimmed mean averages the ticks out and drops GC/scheduler spikes.
   */
  readonly typical: number;
  readonly p50: number;
  readonly p95: number;
  readonly mean: number;
  readonly n: number;
}

function summarize(samples: readonly number[]): CpuSummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const avg = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const typical = avg(sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.9))));
  return { typical, p50: at(0.5), p95: at(0.95), mean: avg(samples), n: samples.length };
}

interface Options {
  readonly iterations: number;
  readonly warmup?: number;
  /** Calls per timed sample (the sample is the average), for work well below the clock's 1 ms tick. */
  readonly batch?: number;
  /** Untimed work after each iteration (settling background tasks). */
  readonly after?: () => Promise<void>;
}

async function measure(fn: () => Promise<unknown>, opts: Options): Promise<CpuSummary> {
  for (let i = 0; i < (opts.warmup ?? 5); i++) {
    await fn();
    await opts.after?.();
  }
  const samples: number[] = [];
  for (let i = 0; i < opts.iterations; i++) {
    const batch = opts.batch ?? 1;
    const start = performance.now();
    for (let j = 0; j < batch; j++) await fn();
    samples.push((performance.now() - start) / batch);
    await opts.after?.();
  }
  return summarize(samples);
}

/** Rows shaped like a typical NRQL result, as many as fit in `bytes` of NerdGraph response. */
function nrqlPayload(bytes: number): string {
  const row = (i: number) => ({
    timestamp: 1_790_000_000_000 + i * 1000,
    appName: `checkout-service-${i % 7}`,
    host: `ip-10-0-${i % 250}-${i % 200}.ec2.internal`,
    'http.statusCode': i % 13 === 0 ? 500 : 200,
    duration: 0.012 + (i % 97) / 1000,
    name: `WebTransaction/SpringController/orders/${i}`,
    error: i % 13 === 0,
  });
  const head = '{"data":{"actor":{"account":{"nrql":{"results":[';
  const tail =
    '],"metadata":{"eventTypes":["Transaction"],"facets":null,"messages":null,"timeWindow":null},"totalResult":null,"otherResult":null,"queryProgress":{"queryId":null,"completed":true,"retryAfter":null,"resultExpiration":null}}}}}}';
  const parts: string[] = [];
  let size = head.length + tail.length;
  for (let i = 0; size < bytes; i++) {
    const text = JSON.stringify(row(i));
    parts.push(text);
    size += text.length + 1;
  }
  return head + parts.join(',') + tail;
}

function nerdgraph(nrqlBody: string): FetchLike {
  return async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { variables?: Record<string, unknown> };
    const text =
      body.variables?.['nrql'] === undefined
        ? JSON.stringify({
            data: {
              actor: {
                user: { id: 7, name: 'A', email: 'a@example.com' },
                accounts: [{ id: 1, name: 'one' }],
              },
            },
          })
        : nrqlBody;
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const record = (task: { meta: Record<string, unknown> }, summary: CpuSummary): void => {
  task.meta['cpu'] = summary;
};

describe('cpu', () => {
  let token = '';
  let storage: Storage;
  const rpc = (
    worker: WorkerHandler,
    ctx: ReturnType<typeof fakeCtx>,
    body: unknown,
    e: WorkerEnv = baseEnv,
  ): Promise<Response> =>
    call(worker, e, ctx, '/p/prod/mcp', {
      method: 'POST',
      ip: '198.51.100.20',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    });
  /** A warm worker (boot done) with `fetch` as NerdGraph. */
  async function warmWorker(
    fetchFn: FetchLike,
    e: WorkerEnv = baseEnv,
  ): Promise<{ worker: WorkerHandler; ctx: ReturnType<typeof fakeCtx> }> {
    const worker = createWorker({ openStorage: () => storage, fetch: fetchFn, logSink: () => {} });
    const ctx = fakeCtx();
    const res = await rpc(worker, ctx, { jsonrpc: '2.0', id: 0, method: 'tools/list' }, e);
    if (res.status !== 200) throw new Error(`warm-up request answered ${res.status}`);
    await res.arrayBuffer();
    await ctx.settle();
    return { worker, ctx };
  }
  const drain = async (res: Response, status = 200): Promise<void> => {
    await res.arrayBuffer();
    if (res.status !== status)
      throw new Error(`benchmark request answered ${res.status}, expected ${status}`);
  };

  beforeAll(async () => {
    await wipeD1(env.DB as D1Database);
    storage = await createD1Storage(env.DB as D1Database);
    token = (await seed(MASTER_KEY, storage)).token;
  });

  it('calibration', async ({ task }) => {
    // Fixed pure-CPU work (ten JSON round trips of a 100 KB document); the other scenarios are compared as ratios to it.
    const doc = JSON.parse(nrqlPayload(100_000)) as unknown;
    const work = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) JSON.parse(JSON.stringify(doc));
    };
    record(task, await measure(work, { iterations: 100, warmup: 20 }));
  });

  it('crypto.decrypt', async ({ task }) => {
    const keyring = await Keyring.create({ current: MASTER_KEY });
    const sealed = await keyring.encryptCredentialKey('crd_bench', 'NRAK-BENCHBENCHBENCHBENCHBENCHBENCH');
    record(
      task,
      await measure(() => keyring.decryptCredentialKey('crd_bench', sealed), { iterations: 30, batch: 100 }),
    );
  });

  it('token.verify.d1', async ({ task }) => {
    record(
      task,
      await measure(
        async () => {
          const r = await verifyAccessToken(storage, token, { now: Date.now() });
          if (!r.ok) throw new Error('token refused');
        },
        { iterations: 150 },
      ),
    );
  });

  it('access.resolve.miss.d1', async ({ task }) => {
    // Token check and access resolution in one storage call (P3-09), what a cache miss costs.
    record(
      task,
      await measure(
        async () => {
          const r = await authenticateAccess({
            storage,
            token,
            projectSlug: 'prod',
            catalog: CATALOG,
            now: Date.now(),
          });
          if (!r.ok) throw new Error('access refused');
        },
        { iterations: 150 },
      ),
    );
  });

  it('cold.first-request', async ({ task }) => {
    // A new Worker instance: boot (settings, keyring import, migration check, key-check read) plus the first request.
    // The module graph is already compiled in this isolate, so the true cold start (compilation) is not covered.
    const samples: number[] = [];
    for (let i = 0; i < 8; i++) {
      const worker = createWorker({ openStorage: () => storage, fetch: nerdgraph(''), logSink: () => {} });
      const ctx = fakeCtx();
      const start = performance.now();
      await drain(await rpc(worker, ctx, { jsonrpc: '2.0', id: 1, method: 'tools/list' }));
      samples.push(performance.now() - start);
      await ctx.settle();
    }
    record(task, summarize(samples));
  });

  it('mcp.initialize', async ({ task }) => {
    const { worker, ctx } = await warmWorker(nerdgraph(''));
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'bench', version: '0' },
      },
    };
    record(
      task,
      await measure(async () => drain(await rpc(worker, ctx, body)), {
        iterations: 150,
        after: () => ctx.settle(),
      }),
    );
  });

  it('mcp.tools-list.hit', async ({ task }) => {
    const { worker, ctx } = await warmWorker(nerdgraph(''));
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    record(
      task,
      await measure(async () => drain(await rpc(worker, ctx, body)), {
        iterations: 150,
        after: () => ctx.settle(),
      }),
    );
  });

  it('mcp.tools-list.miss', async ({ task }) => {
    // TTL 0 disables the access cache: every request resolves access from D1.
    const e = { ...baseEnv, RB_ACCESS_CACHE_TTL: '0' } as WorkerEnv;
    const { worker, ctx } = await warmWorker(nerdgraph(''), e);
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    record(
      task,
      await measure(async () => drain(await rpc(worker, ctx, body, e)), {
        iterations: 150,
        after: () => ctx.settle(),
      }),
    );
  });

  it('tool.whoami', async ({ task }) => {
    const { worker, ctx } = await warmWorker(nerdgraph(''));
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } };
    record(
      task,
      await measure(async () => drain(await rpc(worker, ctx, body)), {
        iterations: 150,
        after: () => ctx.settle(),
      }),
    );
  });

  for (const [label, bytes] of [
    ['10kb', 10 * 1024],
    ['100kb', 100 * 1024],
    // Just under the Free preset's 512 KiB ceiling (the ceiling itself would refuse the response).
    ['500kb', 500 * 1024],
  ] as const) {
    it(`tool.run_nrql.${label}`, async ({ task }) => {
      const { worker, ctx } = await warmWorker(nerdgraph(nrqlPayload(bytes)));
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'run_nrql',
          arguments: { nrql: 'SELECT * FROM Transaction SINCE 1 hour ago LIMIT MAX' },
        },
      };
      record(
        task,
        await measure(async () => drain(await rpc(worker, ctx, body)), {
          iterations: bytes > 100_000 ? 60 : 100,
          after: () => ctx.settle(),
        }),
      );
    });
  }
});
