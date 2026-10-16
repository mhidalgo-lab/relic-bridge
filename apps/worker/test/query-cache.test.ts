// SPDX-License-Identifier: Apache-2.0
// P7-02 in workerd: the query cache over the real Workers Cache API (per colo, shared by every request of the
// deployment), keyed and encrypted with master-key-derived keys.
import { Keyring } from '@relic-bridge/auth';
import {
  createBudget,
  createLogger,
  DEFAULT_LIMITS,
  type FetchLike,
  type NrqlComplete,
  nerdGraphFor,
  QueryCache,
  runRawNrql,
  Secret,
  type ToolContext,
  unboundedLimiter,
} from '@relic-bridge/core';
import { describe, expect, it } from 'vitest';
import { parseWorkerSettings, WorkerConfigError } from '../src/settings.ts';
import { createWorkerQueryCache, QUERY_CACHE_NAME } from '../src/worker.ts';

const NRQL = 'SELECT count(*) FROM Transaction SINCE 30 minutes ago';
const masterKey = (seed: number) =>
  `v1:${btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (seed * 31 + i * 7) % 256)))}`;

/** A query no other test (or run) used: the Cache API persists across tests in one workerd. */
const unique = (): string =>
  `SELECT count(*) FROM Transaction WHERE appName = '${crypto.randomUUID()}' SINCE 30 minutes ago`;

function nerdGraph() {
  let n = 0;
  const keys: string[] = [];
  const fetch: FetchLike = async (_url, init) => {
    keys.push(String((init.headers as Record<string, string>)['API-Key'] ?? ''));
    n++;
    return new Response(
      JSON.stringify({
        data: {
          actor: {
            account: {
              nrql: {
                results: [{ count: n }],
                metadata: { eventTypes: ['Transaction'], facets: null, messages: null, timeWindow: null },
                totalResult: null,
                otherResult: null,
                queryProgress: null,
              },
            },
          },
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetch, keys };
}

function ctx(
  cache: QueryCache,
  over: { key?: string; credentialId?: string; scope?: string } = {},
): ToolContext {
  return {
    requestId: crypto.randomUUID(),
    credential: {
      id: over.credentialId ?? 'cred-1',
      region: 'US',
      apiKey: new Secret(over.key ?? 'NRAK-WORKERCACHEKEYAAAAAAAAAAAAAA'),
    },
    accounts: { allowed: [1], default: 1 },
    budget: createBudget(45),
    limiter: unboundedLimiter,
    limits: DEFAULT_LIMITS,
    logger: createLogger({ level: 'error', sink: () => undefined }),
    clock: { now: () => Date.now() },
    queryCache: { cache, scope: over.scope ?? 'grant:g1' },
  };
}

async function run(
  c: ToolContext,
  fetch: FetchLike,
  extra: Record<string, unknown> = {},
): Promise<NrqlComplete> {
  return (await runRawNrql(
    c,
    { nrql: NRQL, mode: 'sync', ...extra },
    { client: nerdGraphFor(c, { fetch }) },
  )) as NrqlComplete;
}

/** A Cache API-only query cache (no memory tier), so every hit is served by the colo cache. */
async function coloOnly(fill: number): Promise<QueryCache> {
  const keyring = await Keyring.create({ current: masterKey(fill) });
  const full = createWorkerQueryCache({ mode: 'on', relativeTtlMs: 30_000 }, keyring.queryCacheKeys());
  if (full === null) throw new Error('cache off');
  const colo = full.stores.find((s) => s.name === 'colo');
  if (colo === undefined) throw new Error('no Cache API store');
  return new QueryCache({ stores: [colo], macKey: keyring.queryCacheKeys().id });
}

describe('query cache on the Workers Cache API', () => {
  it('a second isolate (another QueryCache, same master key) hits the colo entry', async () => {
    const ng = nerdGraph();
    const first = await coloOnly(7);
    const second = await coloOnly(7);
    const nrqlUnique = unique();
    const a = await run(ctx(first), ng.fetch, { nrql: nrqlUnique });
    expect(a.cache).toMatchObject({ status: 'miss', stored: true });
    const c = ctx(second);
    const b = await run(c, ng.fetch, { nrql: nrqlUnique });
    expect(b.cache).toMatchObject({ status: 'hit', store: 'colo' });
    expect(b.results).toEqual(a.results);
    expect(c.budget.used).toBe(1); // the Cache API lookup is a subrequest
    expect(ng.keys).toHaveLength(1);
  });

  it('never crosses credentials, keys or grants, and another master key never reads an entry', async () => {
    const ng = nerdGraph();
    const cache = await coloOnly(9);
    const q = unique();
    await run(ctx(cache), ng.fetch, { nrql: q });
    for (const other of [
      ctx(cache, { credentialId: 'cred-2' }),
      ctx(cache, { key: 'NRAK-WORKERCACHEKEYBBBBBBBBBBBBBB' }),
      ctx(cache, { scope: 'grant:g2' }),
      ctx(cache, { scope: 'passthrough' }),
      ctx(await coloOnly(10)),
    ]) {
      expect((await run(other, ng.fetch, { nrql: q })).cache?.status).toBe('miss');
    }
    expect(ng.keys).toHaveLength(6);
  });

  it('stores ciphertext with max-age only under an opaque .invalid URL', async () => {
    const ng = nerdGraph();
    const cache = await coloOnly(11);
    const q = unique();
    const c = ctx(cache);
    await run(c, ng.fetch, { nrql: q });
    const id = await cache.idFor(c, {
      scope: 'grant:g1',
      nrql: q,
      accounts: [1],
      stats: false,
      bucket: cache.lifetime(undefined, Date.now())?.bucket ?? 0,
    });
    const stored = await (await caches.open(QUERY_CACHE_NAME)).match(
      new Request(`https://query-cache.relic-bridge.invalid/v1/${id}`),
    );
    expect(stored).toBeDefined();
    expect(stored?.headers.get('cache-control')).toBe('max-age=30');
    const body = await stored?.text();
    expect(body).not.toContain('Transaction');
    expect(body).not.toContain('count');
  });

  it('a Cache API that stores nothing (workers.dev) is reported, and the memory tier still serves the isolate (NEW-28)', async () => {
    const noop = {
      match: async () => undefined,
      put: async () => undefined,
    };
    const keyring = await Keyring.create({ current: masterKey(13) });
    const cache = createWorkerQueryCache(
      { mode: 'on', relativeTtlMs: 30_000 },
      keyring.queryCacheKeys(),
      noop,
    );
    if (cache === null) throw new Error('cache off');
    const ng = nerdGraph();
    const q = unique();
    const a = await run(ctx(cache), ng.fetch, { nrql: q });
    expect(a.cache).toMatchObject({ status: 'miss', stored: true });
    expect(a.cache?.note).toContain('workers.dev');
    const b = await run(ctx(cache), ng.fetch, { nrql: q });
    expect(b.cache).toMatchObject({ status: 'hit', store: 'memory' });
    expect(ng.keys).toHaveLength(1);
    // Colo only: nothing can serve a later request, and the result says so.
    const colo = cache.stores.find((st) => st.name === 'colo');
    if (colo === undefined) throw new Error('no Cache API store');
    const coloOnlyCache = new QueryCache({ stores: [colo], macKey: keyring.queryCacheKeys().id });
    const c = await run(ctx(coloOnlyCache), ng.fetch, { nrql: q });
    expect(c.cache).toMatchObject({ status: 'miss' });
    expect(c.cache?.note).toContain('workers.dev');
  });

  it('memory mode and off mode', async () => {
    const keyring = await Keyring.create({ current: masterKey(12) });
    expect(
      createWorkerQueryCache({ mode: 'off', relativeTtlMs: 30_000 }, keyring.queryCacheKeys()),
    ).toBeNull();
    const memory = createWorkerQueryCache(
      { mode: 'memory', relativeTtlMs: 30_000 },
      keyring.queryCacheKeys(),
    );
    expect(memory?.stores.map((s) => s.name)).toEqual(['memory']);
    const on = createWorkerQueryCache({ mode: 'on', relativeTtlMs: 5_000 }, keyring.queryCacheKeys());
    expect(on?.stores.map((s) => s.name)).toEqual(['memory', 'colo']);
    expect(on?.policy.relativeTtlMs).toBe(5_000);
  });

  it('settings: RB_QUERY_CACHE and RB_QUERY_CACHE_TTL', () => {
    expect(parseWorkerSettings({}).queryCache).toEqual({ mode: 'memory', relativeTtlMs: 30_000 });
    expect(parseWorkerSettings({ RB_PLAN: 'paid' }).queryCache.mode).toBe('on');
    expect(parseWorkerSettings({ RB_QUERY_CACHE: 'on' }).queryCache.mode).toBe('on');
    expect(parseWorkerSettings({ RB_QUERY_CACHE: 'Memory', RB_QUERY_CACHE_TTL: '0' }).queryCache).toEqual({
      mode: 'memory',
      relativeTtlMs: 0,
    });
    expect(() => parseWorkerSettings({ RB_QUERY_CACHE: 'maybe' })).toThrow(WorkerConfigError);
    expect(() => parseWorkerSettings({ RB_QUERY_CACHE_TTL: '301' })).toThrow(WorkerConfigError);
  });
});
