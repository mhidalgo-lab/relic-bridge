// SPDX-License-Identifier: Apache-2.0
// P7-02: NRQL query cache. Isolation (T16) first, then TTLs, size caps, stores and output.
import { describe, expect, it } from 'vitest';
import {
  CACHE_API_RECHECK_MS,
  type CacheApiLike,
  CacheApiQueryCacheStore,
  createBudget,
  DEFAULT_LIMITS,
  ErrorCode,
  enforceQueryLimits,
  MemoryQueryCacheStore,
  type NrqlComplete,
  type NrqlOutcome,
  nerdGraphFor,
  normalizeNrqlForCache,
  QueryCache,
  type QueryCacheBinding,
  type QueryLimits,
  RbError,
  RESULT_META_KEY,
  runRawNrql,
  Secret,
  shapeNrqlOutcome,
  type ToolContext,
} from '../src/index.ts';
import { FAKE_KEY, testContext } from './helpers/context.ts';
import { json, scriptedFetch } from './helpers/nerdgraph.ts';

const A = 1000001;
const B = 1000004;
const NRQL = 'SELECT count(*) FROM Transaction SINCE 30 minutes ago';
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);

const container = (count: number) => ({
  results: [{ count }],
  metadata: { eventTypes: ['Transaction'], facets: null, messages: null, timeWindow: null },
  totalResult: null,
  otherResult: null,
  queryProgress: null,
});
const answer = (count: number) => json({ data: { actor: { account: { nrql: container(count) } } } });

/** A NerdGraph that answers count = 1, 2, 3… and records every call. */
function counter() {
  let n = 0;
  return scriptedFetch(async () => answer(++n));
}

function clock(start = T0) {
  const c = { t: start, now: () => c.t };
  return c;
}

interface Setup {
  readonly cache: QueryCache;
  readonly clock: ReturnType<typeof clock>;
  readonly fetch: ReturnType<typeof counter>;
}

function world(cache = new QueryCache()): Setup {
  return { cache, clock: clock(), fetch: counter() };
}

function ctxFor(w: Setup, overrides: Partial<ToolContext> = {}, scope = 'grant:g1'): ToolContext {
  const binding: QueryCacheBinding = { cache: w.cache, scope };
  return testContext({
    accounts: { allowed: [A, B], default: A },
    budget: createBudget(50),
    clock: w.clock,
    queryCache: binding,
    ...overrides,
  });
}

async function run(w: Setup, ctx: ToolContext, nrql = NRQL, extra: Record<string, unknown> = {}) {
  const out = await runRawNrql(
    ctx,
    { nrql, mode: 'sync', ...extra },
    { client: nerdGraphFor(ctx, { fetch: w.fetch.fetch, sleep: async () => undefined }) },
  );
  return out as NrqlComplete;
}

const count = (o: NrqlOutcome) => ((o as NrqlComplete).results[0] as { count: number }).count;

describe('query cache: hits', () => {
  it('serves a repeated query from the cache without a New Relic call or budget', async () => {
    const w = world();
    const first = await run(w, ctxFor(w));
    expect(first.cache).toEqual({ status: 'miss', stored: true, ttlSeconds: 30 });
    const ctx = ctxFor(w);
    w.clock.t += 5_000;
    const second = await run(w, ctx);
    expect(w.fetch.calls).toHaveLength(1);
    expect(count(second)).toBe(1);
    expect(second.cache).toEqual({ status: 'hit', store: 'memory', ageSeconds: 5, ttlSeconds: 30 });
    expect(second.polls).toBe(0);
    expect(second.nrql).toBe(NRQL);
    expect(ctx.budget.used).toBe(0);
  });

  it('shares an entry across whitespace differences only', async () => {
    const w = world();
    await run(w, ctxFor(w), NRQL);
    await run(w, ctxFor(w), `  SELECT count(*)\n  FROM Transaction   SINCE 30 minutes ago `);
    expect(w.fetch.calls).toHaveLength(1);
    await run(w, ctxFor(w), 'select count(*) FROM Transaction SINCE 30 minutes ago');
    await run(w, ctxFor(w), "SELECT count(*) FROM Transaction WHERE name = 'a  b' SINCE 30 minutes ago");
    await run(w, ctxFor(w), "SELECT count(*) FROM Transaction WHERE name = 'a b' SINCE 30 minutes ago");
    expect(w.fetch.calls).toHaveLength(4);
  });

  it('hands out independent copies (a caller mutating its result changes nothing for the next)', async () => {
    const w = world();
    await run(w, ctxFor(w));
    const a = await run(w, ctxFor(w));
    (a.results[0] as { count: number }).count = 999;
    const b = await run(w, ctxFor(w));
    expect(count(b)).toBe(1);
  });
});

describe('query cache: isolation (T16)', () => {
  const variants: [string, (w: Setup) => ToolContext][] = [
    [
      'another credential id',
      (w) => ctxFor(w, { credential: { id: 'cred-2', region: 'US', apiKey: new Secret(FAKE_KEY) } }),
    ],
    [
      'another key under the same credential id (rotation)',
      (w) =>
        ctxFor(w, {
          credential: { id: 'cred-1', region: 'US', apiKey: new Secret(`NRAK-${'Z'.repeat(27)}`) },
        }),
    ],
    [
      'another region',
      (w) => ctxFor(w, { credential: { id: 'cred-1', region: 'EU', apiKey: new Secret(FAKE_KEY) } }),
    ],
    ['another grant scope', (w) => ctxFor(w, {}, 'grant:g2')],
    ['the pass-through scope', (w) => ctxFor(w, {}, 'passthrough')],
    ['narrower limits (LIMIT cap)', (w) => ctxFor(w, { limits: { ...DEFAULT_LIMITS, maxLimit: 100 } })],
    [
      'an event-type deny list',
      (w) => ctxFor(w, { limits: { ...DEFAULT_LIMITS, eventTypes: { deny: ['Log'] } } }),
    ],
    ['another max window', (w) => ctxFor(w, { limits: { ...DEFAULT_LIMITS, maxWindowDays: 3 } })],
    ['another response cap', (w) => ctxFor(w, { limits: { ...DEFAULT_LIMITS, maxResponseBytes: 1024 } })],
  ];
  for (const [name, other] of variants) {
    it(`never serves an entry to ${name}`, async () => {
      const w = world();
      await run(w, ctxFor(w));
      const out = await run(w, other(w));
      expect(out.cache?.status).toBe('miss');
      expect(count(out)).toBe(2);
      expect(w.fetch.calls).toHaveLength(2);
    });
  }

  it('keys on the accounts queried (and their order) and on the stats flag', async () => {
    const w = world();
    await run(w, ctxFor(w), NRQL, { accounts: [A] });
    expect((await run(w, ctxFor(w), NRQL, { accounts: [B] })).cache?.status).toBe('miss');
    expect((await run(w, ctxFor(w), NRQL, { accounts: [A], stats: true })).cache?.status).toBe('miss');
    expect((await run(w, ctxFor(w), NRQL, { accounts: [A] })).cache?.status).toBe('hit');
  });

  it('refuses an account the connection may not use even when another connection cached it', async () => {
    const w = world();
    await run(w, ctxFor(w), NRQL, { accounts: [B] });
    const narrow = ctxFor(w, { accounts: { allowed: [A], default: A } });
    await expect(run(w, narrow, NRQL, { accounts: [B] })).rejects.toMatchObject({
      code: ErrorCode.AuthForbidden,
    });
  });

  it('refuses a query the limits forbid before looking at the cache', async () => {
    const w = world();
    const q = 'SELECT count(*) FROM Log SINCE 30 minutes ago';
    await run(w, ctxFor(w), q);
    const denied = ctxFor(w, { limits: { ...DEFAULT_LIMITS, eventTypes: { deny: ['Log'] } } });
    const error = await run(w, denied, q).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RbError);
    expect((error as RbError).code).toBe(ErrorCode.LimitQuery);
    const noRaw = ctxFor(w, { limits: { ...DEFAULT_LIMITS, rawNrql: false } });
    await expect(run(w, noRaw, q)).rejects.toMatchObject({ code: ErrorCode.ToolDisabled });
  });

  it('entry ids are opaque HMACs: no key, credential, account or NRQL text, and differ per cache key', async () => {
    const w = world();
    const ctx = ctxFor(w);
    const input = { scope: 'grant:g1', nrql: NRQL, accounts: [A], stats: false, bucket: 1 };
    const id = await w.cache.idFor(ctx, input);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toContain(String(A));
    expect(await w.cache.idFor(ctx, input)).toBe(id);
    // Another cache (another MAC key) never computes the same id.
    expect(await new QueryCache().idFor(ctx, input)).not.toBe(id);
    // Length-prefixed parts: moving text between fields gives another id.
    expect(await w.cache.idFor(ctx, { ...input, scope: 'grant:g', nrql: `1${NRQL}` })).not.toBe(id);
  });

  it('two tenants interleaved on one cache only ever see their own counts', async () => {
    const w = world();
    const t1 = () => ctxFor(w, {}, 'grant:t1');
    const t2 = () =>
      ctxFor(
        w,
        { credential: { id: 'cred-2', region: 'US', apiKey: new Secret('NRAK-TENANTTWOTENANTTWOTENANTTW') } },
        'grant:t2',
      );
    const [a1, b1] = await Promise.all([run(w, t1()), run(w, t2())]);
    const [a2, b2] = await Promise.all([run(w, t1()), run(w, t2())]);
    expect(count(a2)).toBe(count(a1));
    expect(count(b2)).toBe(count(b1));
    expect(count(a1)).not.toBe(count(b1));
  });
});

describe('query cache: TTL and time windows', () => {
  it('relative windows expire after the short TTL', async () => {
    const w = world();
    await run(w, ctxFor(w));
    w.clock.t += 29_000;
    expect((await run(w, ctxFor(w))).cache?.status).toBe('hit');
    w.clock.t += 2_000;
    const after = await run(w, ctxFor(w));
    expect(after.cache?.status).toBe('miss');
    expect(count(after)).toBe(2);
  });

  it('relative windows never outlive their time bucket', async () => {
    const w = world();
    w.clock.t = T0 + 25_000; // 5 s before the 30 s bucket ends
    await run(w, ctxFor(w));
    w.clock.t += 6_000;
    expect((await run(w, ctxFor(w))).cache?.status).toBe('miss');
  });

  it('a settled absolute window gets the long TTL; a recent one the short TTL', async () => {
    const w = world();
    const since = T0 - 3 * 3_600_000;
    const until = T0 - 2 * 3_600_000;
    const settled = `SELECT count(*) FROM Transaction SINCE ${since} UNTIL ${until}`;
    expect((await run(w, ctxFor(w), settled)).cache).toMatchObject({ status: 'miss', ttlSeconds: 600 });
    w.clock.t += 5 * 60_000;
    expect((await run(w, ctxFor(w), settled)).cache).toMatchObject({ status: 'hit', ageSeconds: 300 });
    w.clock.t += 6 * 60_000;
    expect((await run(w, ctxFor(w), settled)).cache?.status).toBe('miss');

    const recent = `SELECT count(*) FROM Transaction SINCE ${T0 - 600_000} UNTIL ${T0 - 60_000}`;
    expect((await run(w, ctxFor(w), recent)).cache).toMatchObject({ ttlSeconds: 30 });
  });

  it('a clock that goes back is a miss', async () => {
    const w = world();
    await run(w, ctxFor(w));
    w.clock.t -= 1_000;
    expect((await run(w, ctxFor(w))).cache?.status).toBe('miss');
  });

  it('detects fixed windows conservatively (enforceQueryLimits.fixedEndMs)', () => {
    const fixed = (q: string) => enforceQueryLimits(q, DEFAULT_LIMITS, T0).fixedEndMs;
    const s = T0 - 7_200_000;
    const u = T0 - 3_600_000;
    expect(fixed(`SELECT count(*) FROM T SINCE ${s} UNTIL ${u}`)).toBe(u);
    expect(fixed(`SELECT count(*) FROM T SINCE ${s / 1000} UNTIL ${u / 1000}`)).toBe(u);
    expect(fixed("SELECT count(*) FROM T SINCE '2026-10-05 10:00' UNTIL '2026-10-05 11:00'")).toBe(
      Date.UTC(2026, 9, 5, 11),
    );
    // WITH TIMEZONE can move a quoted date later: the end is pushed out by the widest offset.
    expect(
      fixed(
        "SELECT count(*) FROM T SINCE '2026-10-05 10:00' UNTIL '2026-10-05 11:00' WITH TIMEZONE 'Asia/Tokyo'",
      ),
    ).toBe(Date.UTC(2026, 9, 5, 11) + 14 * 3_600_000);
    expect(fixed('SELECT count(*) FROM T SINCE 1 hour ago')).toBeUndefined();
    expect(fixed(`SELECT count(*) FROM T SINCE ${s}`)).toBeUndefined();
    expect(fixed(`SELECT count(*) FROM T SINCE ${s} UNTIL now`)).toBeUndefined();
    expect(fixed(`SELECT count(*) FROM T SINCE 2 hours ago UNTIL ${u}`)).toBeUndefined();
    expect(fixed('SELECT count(*) FROM T SINCE yesterday UNTIL today')).toBeUndefined();
    expect(
      fixed(
        `SELECT count(*) FROM T WHERE x IN (SELECT uniques(x) FROM T SINCE 1 hour ago) SINCE ${s} UNTIL ${u}`,
      ),
    ).toBeUndefined();
  });

  it('a relative TTL of 0 turns caching off for moving windows only', async () => {
    const w = world(new QueryCache({ policy: { relativeTtlMs: 0 } }));
    expect((await run(w, ctxFor(w))).cache).toEqual({ status: 'off' });
    expect((await run(w, ctxFor(w))).cache?.status).toBe('off');
    expect(w.fetch.calls).toHaveLength(2);
  });

  it('clamps configured TTLs to the documented maxima', () => {
    const c = new QueryCache({ policy: { relativeTtlMs: 10_000_000, absoluteTtlMs: 10_000_000 } });
    expect(c.policy.relativeTtlMs).toBe(300_000);
    expect(c.policy.absoluteTtlMs).toBe(3_600_000);
  });
});

describe('query cache: controls', () => {
  it('bypass runs the query and refreshes the entry', async () => {
    const w = world();
    await run(w, ctxFor(w));
    const fresh = await run(w, ctxFor(w), NRQL, { cache: 'bypass' });
    expect(fresh.cache).toMatchObject({ status: 'bypass', stored: true });
    expect(count(fresh)).toBe(2);
    expect(count(await run(w, ctxFor(w)))).toBe(2);
  });

  it('no cache on the context: status off, every call goes to New Relic', async () => {
    const w = world();
    const ctx = () => testContext({ clock: w.clock });
    for (let i = 0; i < 2; i++) {
      const out = (await runRawNrql(
        ctx(),
        { nrql: NRQL, mode: 'sync' },
        { client: nerdGraphFor(ctx(), { fetch: w.fetch.fetch }) },
      )) as NrqlComplete;
      expect(out.cache).toEqual({ status: 'off' });
    }
    expect(w.fetch.calls).toHaveLength(2);
  });

  it('never caches pending handles or errors', async () => {
    const w = world();
    const pending = scriptedFetch(
      json({
        data: {
          actor: {
            account: {
              nrql: {
                ...container(0),
                results: null,
                queryProgress: { queryId: 'q-1', completed: false, retryAfter: 1, resultExpiration: null },
              },
            },
          },
        },
      }),
    );
    const ctx = ctxFor(w);
    const out = await runRawNrql(
      ctx,
      { nrql: NRQL, mode: 'async' },
      { client: nerdGraphFor(ctx, { fetch: pending.fetch }) },
    );
    expect(out.status).toBe('pending');
    expect('cache' in out).toBe(false);
    const failing = scriptedFetch(json({ errors: [{ message: 'NRQL Syntax Error: boom' }], data: null }));
    const ctx2 = ctxFor(w);
    await expect(
      runRawNrql(
        ctx2,
        { nrql: NRQL, mode: 'sync' },
        { client: nerdGraphFor(ctx2, { fetch: failing.fetch }) },
      ),
    ).rejects.toBeInstanceOf(RbError);
    // Nothing was stored by either: the next call goes to New Relic.
    expect((await run(w, ctxFor(w))).cache?.status).toBe('miss');
  });
});

describe('query cache: size caps', () => {
  it('does not store a result above maxEntryBytes', async () => {
    const w = world(new QueryCache({ policy: { maxEntryBytes: 100 } }));
    const big = scriptedFetch(async () =>
      json({
        data: { actor: { account: { nrql: { ...container(1), results: [{ text: 'x'.repeat(500) }] } } } },
      }),
    );
    const ctx = ctxFor(w);
    const out = (await runRawNrql(
      ctx,
      { nrql: NRQL, mode: 'sync' },
      { client: nerdGraphFor(ctx, { fetch: big.fetch }) },
    )) as NrqlComplete;
    expect(out.cache).toEqual({ status: 'miss', stored: false });
  });

  it('the memory LRU stays within its entry and byte bounds and evicts the least recently used', async () => {
    const store = new MemoryQueryCacheStore({ maxEntries: 2, maxBytes: 1_000 });
    const entry = (body: string) => ({ body, storedAt: 0, expiresAt: 1_000 });
    await store.put('a', entry('1'));
    await store.put('b', entry('2'));
    await store.get('a', 1); // a is now most recent
    await store.put('c', entry('3'));
    expect(await store.get('b', 1)).toBeUndefined();
    expect(await store.get('a', 1)).toBeDefined();
    expect(store.size.entries).toBe(2);
    await store.put('d', entry('x'.repeat(400))); // 800 bytes: evicts until the bytes fit
    expect(store.size.bytes).toBeLessThanOrEqual(1_000);
    await store.put('e', entry('x'.repeat(600))); // larger than the whole store: not kept
    expect(await store.get('e', 1)).toBeUndefined();
    expect(store.size.bytes).toBeLessThanOrEqual(1_000);
    expect(await store.get('d', 1_000)).toBeUndefined(); // expired
  });
});

/** An in-memory stand-in for the Workers Cache API (the workers pool test uses the real one). */
function fakeCacheApi() {
  const entries = new Map<string, { body: ArrayBuffer; headers: Headers }>();
  const api: CacheApiLike = {
    async match(request) {
      const e = entries.get(request.url);
      return e === undefined ? undefined : new Response(e.body.slice(0), { headers: e.headers });
    },
    async put(request, response) {
      entries.set(request.url, { body: await response.arrayBuffer(), headers: response.headers });
    },
  };
  return { api, entries };
}

const aesKey = () =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as Promise<
    Awaited<ReturnType<typeof crypto.subtle.importKey>>
  >;

describe('query cache: Cache API store', () => {
  it('stores encrypted bodies under opaque URLs with max-age only, and spends budget', async () => {
    const { api, entries } = fakeCacheApi();
    const colo = new CacheApiQueryCacheStore({ cache: api, aesKey: await aesKey() });
    const w = world(new QueryCache({ stores: [colo] }));
    const ctx = ctxFor(w);
    await run(w, ctx);
    expect(ctx.budget.used).toBe(3); // lookup + NerdGraph + write
    const [url, stored] = [...entries.entries()][0] as [string, { body: ArrayBuffer; headers: Headers }];
    expect(url).toMatch(/^https:\/\/query-cache\.relic-bridge\.invalid\/v1\/[0-9a-f]{64}$/);
    expect(stored.headers.get('cache-control')).toBe('max-age=30');
    const raw = new TextDecoder().decode(stored.body);
    expect(raw).not.toContain('Transaction');
    expect(raw).not.toContain('count');
    const hitCtx = ctxFor(w);
    const hit = await run(w, hitCtx);
    expect(hit.cache).toMatchObject({ status: 'hit', store: 'colo' });
    expect(hitCtx.budget.used).toBe(1);
  });

  it('a Cache API that stores nothing (workers.dev) is reported once and then skipped', async () => {
    let calls = 0;
    const noop: CacheApiLike = {
      async match() {
        calls++;
        return undefined;
      },
      async put() {
        calls++;
      },
    };
    const c = clock();
    const colo = new CacheApiQueryCacheStore({ cache: noop, aesKey: await aesKey(), now: c.now });
    const w = world(new QueryCache({ stores: [colo] }));
    const first = await run(w, ctxFor(w));
    expect(first.cache).toMatchObject({ status: 'miss', stored: true });
    expect(first.cache?.note).toContain('workers.dev');
    expect(colo.unavailable).toContain('no-op');
    calls = 0;
    const second = await run(w, ctxFor(w));
    expect(second.cache).toMatchObject({ status: 'miss' });
    expect(second.cache?.note).toContain('workers.dev');
    expect(calls).toBe(0); // no more Cache API calls, no budget spent on them
    // After the recheck interval the next write probes again; a working cache clears the note.
    const { api } = fakeCacheApi();
    const healed = new CacheApiQueryCacheStore({ cache: api, aesKey: await aesKey(), now: c.now });
    expect(healed.unavailable).toBeUndefined();
    c.t += CACHE_API_RECHECK_MS;
    expect(colo.unavailable).toBeUndefined();
  });

  it('rejects entries copied to another id, altered, or written under another key', async () => {
    const { api, entries } = fakeCacheApi();
    const key = await aesKey();
    const colo = new CacheApiQueryCacheStore({ cache: api, aesKey: key });
    await colo.put('aa', { body: '{"x":1}', storedAt: 0, expiresAt: 10_000 });
    expect(await colo.get('aa', 1)).toMatchObject({ body: '{"x":1}' });
    const original = entries.get(`https://query-cache.relic-bridge.invalid/v1/aa`);
    if (original === undefined) throw new Error('missing');
    entries.set('https://query-cache.relic-bridge.invalid/v1/bb', original);
    expect(await colo.get('bb', 1)).toBeUndefined();
    const flipped = new Uint8Array(original.body.slice(0));
    flipped[20] = (flipped[20] ?? 0) ^ 1;
    entries.set('https://query-cache.relic-bridge.invalid/v1/aa', {
      body: flipped.buffer,
      headers: original.headers,
    });
    expect(await colo.get('aa', 1)).toBeUndefined();
    await colo.put('cc', { body: '{}', storedAt: 0, expiresAt: 10_000 });
    const other = new CacheApiQueryCacheStore({ cache: api, aesKey: await aesKey() });
    expect(await other.get('cc', 1)).toBeUndefined();
    // Expiry is inside the ciphertext: a stale entry the platform still holds is a miss.
    expect(await colo.get('cc', 10_000)).toBeUndefined();
  });

  it('copies a colo hit into memory and skips the colo once half the budget is spent', async () => {
    const { api } = fakeCacheApi();
    const memory = new MemoryQueryCacheStore();
    const colo = new CacheApiQueryCacheStore({ cache: api, aesKey: await aesKey() });
    const w = world(new QueryCache({ stores: [memory, colo] }));
    await run(w, ctxFor(w));
    expect(memory.size.entries).toBe(1);
    const low = ctxFor(w, { budget: createBudget(4) });
    low.budget.spend(2);
    const out = await run(w, low, 'SELECT count(*) FROM Transaction SINCE 20 minutes ago');
    expect(out.cache?.status).toBe('miss');
    expect(low.budget.used).toBe(3); // the NerdGraph call only: no colo lookup or write
  });

  it('a failing store is a miss, never an error', async () => {
    const broken: CacheApiLike = {
      match: () => Promise.reject(new Error('boom')),
      put: () => Promise.reject(new Error('boom')),
    };
    const colo = new CacheApiQueryCacheStore({ cache: broken, aesKey: await aesKey() });
    const w = world(new QueryCache({ stores: [colo] }));
    const out = await run(w, ctxFor(w));
    expect(out.cache).toEqual({ status: 'miss', stored: false });
    expect(count(out)).toBe(1);
  });
});

describe('query cache: output', () => {
  it('reports the cache in _meta and says so (outside the envelope) on a hit', async () => {
    const w = world();
    await run(w, ctxFor(w));
    w.clock.t += 7_000;
    const shaped = shapeNrqlOutcome(await run(w, ctxFor(w)));
    expect(shaped.meta?.[RESULT_META_KEY]).toMatchObject({
      cache: { status: 'hit', store: 'memory', ageSeconds: 7 },
    });
    const text = shaped.text;
    expect(text).toContain('Served from the query cache, 7 s old.');
    expect(text.indexOf('Served from the query cache')).toBeLessThan(text.indexOf('<untrusted-data'));
    expect(text).toContain('<untrusted-data');
  });

  it('normalises only whitespace between tokens', () => {
    expect(normalizeNrqlForCache("SELECT  x\n FROM  T WHERE a = 'p  q'  ")).toBe(
      "SELECT x FROM T WHERE a = 'p  q'",
    );
    expect(normalizeNrqlForCache('SELECT count(*) FROM T')).toBe('SELECT count(*) FROM T');
    expect(normalizeNrqlForCache('SELECT `a  b` FROM T')).toBe('SELECT `a  b` FROM T');
  });

  it('limits fingerprint covers every QueryLimits field', () => {
    // Guard: a new limit must be added to the cache key (limitsFingerprint) as well.
    const keys: (keyof QueryLimits)[] = [
      'maxLimit',
      'maxWindowDays',
      'eventTypes',
      'rawNrql',
      'maxResponseBytes',
    ];
    expect(Object.keys(DEFAULT_LIMITS).sort()).toEqual([...keys].sort());
  });
});
