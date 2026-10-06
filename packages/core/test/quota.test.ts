// SPDX-License-Identifier: Apache-2.0
// P7-12: the quota guard seam in core. Quotas count real NerdGraph calls: one per logical call (retries and query-cache
// hits do not count), the inspected-events budget makes NRQL ask for stats and strips them again when unasked.
import { describe, expect, it } from 'vitest';
import {
  createBudget,
  ErrorCode,
  type NrqlComplete,
  nerdGraphFor,
  QueryCache,
  type QuotaGuard,
  RbError,
  runRawNrql,
  type ToolContext,
} from '../src/index.ts';
import { IDENTITY_QUERY } from '../src/nerdgraph/identity.ts';
import { testContext } from './helpers/context.ts';
import { json, scriptedFetch } from './helpers/nerdgraph.ts';

const NRQL = 'SELECT count(*) FROM Transaction SINCE 30 minutes ago';

interface Spy extends QuotaGuard {
  readonly calls: { n: number };
  readonly inspected: number[];
}

function spy(options: { tracksInspected?: boolean; refuse?: boolean } = {}): Spy {
  const calls = { n: 0 };
  const inspected: number[] = [];
  return {
    calls,
    inspected,
    tracksInspected: options.tracksInspected ?? false,
    async beforeCall() {
      if (options.refuse) {
        throw new RbError(ErrorCode.LimitQuota, 'The daily quota for this connection is used up.');
      }
      calls.n++;
    },
    async recordInspected(events) {
      inspected.push(events);
    },
    takeWarning: () => undefined,
  };
}

const container = (inspectedCount?: number) => ({
  results: [{ count: 3 }],
  metadata: { eventTypes: ['Transaction'], facets: null, messages: null, timeWindow: null },
  totalResult: null,
  otherResult: null,
  queryProgress: null,
  ...(inspectedCount === undefined
    ? {}
    : { rawResponse: { performanceStats: { inspectedCount, matchCount: 3, wallClockTime: 5 } } }),
});

const ctxWith = (quota: QuotaGuard, over: Partial<ToolContext> = {}): ToolContext =>
  testContext({ budget: createBudget(50), quota, ...over });

describe('quota guard in the NerdGraph client', () => {
  it('counts one call per logical query, not per retry', async () => {
    const quota = spy();
    const f = scriptedFetch(
      new Response('', { status: 503 }),
      json({ data: { actor: { user: { id: 1 } } } }),
    );
    const ctx = ctxWith(quota);
    const client = nerdGraphFor(ctx, { fetch: f.fetch, sleep: async () => undefined, random: () => 0 });
    await client.query(IDENTITY_QUERY, { scope: 'IN_REGION' });
    expect(f.calls).toHaveLength(2);
    expect(quota.calls.n).toBe(1);
  });

  it('refuses before anything is sent when the guard refuses', async () => {
    const quota = spy({ refuse: true });
    const f = scriptedFetch(json({ data: {} }));
    const ctx = ctxWith(quota);
    const client = nerdGraphFor(ctx, { fetch: f.fetch });
    await expect(client.query(IDENTITY_QUERY, { scope: 'IN_REGION' })).rejects.toMatchObject({
      code: ErrorCode.LimitQuota,
    });
    expect(f.calls).toHaveLength(0);
    expect(ctx.budget.used).toBe(0);
  });
});

describe('quota guard in the NRQL engine', () => {
  const run = async (ctx: ToolContext, f: ReturnType<typeof scriptedFetch>, extra = {}) =>
    (await runRawNrql(
      ctx,
      { nrql: NRQL, mode: 'sync', ...extra },
      { client: nerdGraphFor(ctx, { fetch: f.fetch, sleep: async () => undefined }) },
    )) as NrqlComplete;

  it('asks for stats while an inspected budget applies, records the events, and hides unasked stats', async () => {
    const quota = spy({ tracksInspected: true });
    const f = scriptedFetch(json({ data: { actor: { account: { nrql: container(1234) } } } }));
    const out = await run(ctxWith(quota), f);
    expect(f.calls[0]?.body.variables['stats']).toBe(true);
    expect(quota.inspected).toEqual([1234]);
    expect(out.stats).toBeUndefined();
    const asked = await run(ctxWith(quota), f, { stats: true });
    expect(asked.stats?.inspectedCount).toBe(1234);
    expect(quota.inspected).toEqual([1234, 1234]);
  });

  it('does not ask for stats without an inspected budget', async () => {
    const quota = spy();
    const f = scriptedFetch(json({ data: { actor: { account: { nrql: container() } } } }));
    await run(ctxWith(quota), f);
    expect(f.calls[0]?.body.variables['stats']).toBe(false);
    expect(quota.inspected).toEqual([]);
    expect(quota.calls.n).toBe(1);
  });

  it('a query-cache hit makes no call, so it is not counted and records nothing', async () => {
    const quota = spy({ tracksInspected: true });
    const f = scriptedFetch(json({ data: { actor: { account: { nrql: container(500) } } } }));
    const cache = new QueryCache();
    const ctx = ctxWith(quota, { queryCache: { cache, scope: 'grant:g1' } });
    const first = await run(ctx, f);
    expect(first.cache?.status).toBe('miss');
    const second = await run(ctxWith(quota, { queryCache: { cache, scope: 'grant:g1' } }), f);
    expect(second.cache?.status).toBe('hit');
    expect(f.calls).toHaveLength(1);
    expect(quota.calls.n).toBe(1);
    expect(quota.inspected).toEqual([500]);
  });

  it('a refused query is an RB_LIMIT_QUOTA tool error and nothing is sent', async () => {
    const quota = spy({ refuse: true });
    const f = scriptedFetch(json({ data: {} }));
    await expect(run(ctxWith(quota), f)).rejects.toMatchObject({ code: 'RB_LIMIT_QUOTA' });
    expect(f.calls).toHaveLength(0);
  });
});
