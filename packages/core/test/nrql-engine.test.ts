// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_NRQL,
  CROSS_ACCOUNT_NRQL,
  createBudget,
  ErrorCode,
  getQueryResult,
  NRQL_PROGRESS,
  type NrqlComplete,
  type NrqlPending,
  nerdGraphFor,
  RbError,
  runRawNrql,
} from '../src/index.ts';
import { testContext } from './helpers/context.ts';
import { fixtureResponse, json, loadFixture, scriptedFetch } from './helpers/nerdgraph.ts';

const A = 1000001;
const B = 1000004;
const NRQL = 'SELECT count(*) FROM Transaction SINCE 1 hour ago';

function setup(steps: Parameters<typeof scriptedFetch>, budget = 50) {
  const ctx = testContext({ accounts: { allowed: [A, B], default: A }, budget: createBudget(budget) });
  const { fetch, calls } = scriptedFetch(...steps);
  const sleeps: number[] = [];
  const deps = {
    client: nerdGraphFor(ctx, { fetch, sleep: async () => undefined }),
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  return { ctx, calls, sleeps, deps };
}

async function failure(p: Promise<unknown>): Promise<RbError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof RbError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

/*
 * P0-09 never received a queryId (fast queries complete immediately), so pending/progress bodies are built from the
 * documented shape: queryProgress { queryId completed retryAfter retryDeadline resultExpiration }.
 */
const EXPIRES = Date.UTC(2026, 9, 3, 12, 0, 0);
const progress = (completed: boolean, results: unknown[] | null = null, retryAfter = 2) => ({
  results,
  metadata: completed
    ? { eventTypes: ['Transaction'], facets: null, messages: null, timeWindow: null }
    : null,
  totalResult: null,
  otherResult: null,
  queryProgress: {
    queryId: completed ? null : 'q-123e4567-e89b',
    completed,
    retryAfter: completed ? null : retryAfter,
    retryDeadline: null,
    resultExpiration: completed ? null : EXPIRES,
  },
});
const submitted = (completed: boolean, results: unknown[] | null = null) =>
  json({ data: { actor: { account: { nrql: progress(completed, results) } } } });
const polled = (completed: boolean, results: unknown[] | null = null, retryAfter = 2) =>
  json({ data: { actor: { account: { nrqlQueryProgress: progress(completed, results, retryAfter) } } } });

describe('runNrql: sync and fields', () => {
  it('runs a sync query and keeps metadata, messages and field warnings (fixture)', async () => {
    const { ctx, calls, deps } = setup([fixtureResponse('nrql_sync_1')]);
    const out = (await runRawNrql(ctx, { nrql: NRQL, mode: 'sync' }, deps)) as NrqlComplete;
    expect(out).toMatchObject({
      status: 'complete',
      accounts: [A],
      results: [{ count: 0 }],
      metadata: {
        eventTypes: ['Transaction'],
        facets: [],
        timeseries: false,
        timeWindow: { since: expect.any(String) },
      },
      messages: ['No events found -- do you have the correct event type and time range?'],
      polls: 0,
    });
    expect(out.warnings).toHaveLength(2); // suggestedQueries / embeddedChartUrl failed in the full-selection capture
    expect(out.stats).toBeUndefined();
    expect(calls[0]?.body.variables).toEqual({
      accountId: A,
      nrql: NRQL,
      timeout: 10,
      async: false,
      stats: false,
    });
  });

  it('reports the NRQL actually sent and the duration (P1-05 meta)', async () => {
    const { ctx: base, deps } = setup([fixtureResponse('nrql_sync_1')]);
    let t = 1000;
    const ctx = { ...base, clock: { now: () => (t += 250) } };
    const out = (await runRawNrql(ctx, { nrql: 'SELECT * FROM Log', mode: 'sync' }, deps)) as NrqlComplete;
    expect(out.nrql).toBe('SELECT * FROM Log LIMIT 10');
    expect(out.durationMs).toBe(250);
  });

  it('selects only lean fields and never chart URLs (T26)', () => {
    for (const doc of [ACCOUNT_NRQL, CROSS_ACCOUNT_NRQL, NRQL_PROGRESS]) {
      for (const field of ['staticChartUrl', 'embeddedChartUrl', 'eventDefinitions', 'suggestedQueries']) {
        expect(doc.query).not.toContain(field);
      }
      expect(doc.query).toContain('rawResponse @include(if: $stats)');
    }
  });

  it('extracts cost stats only when asked', async () => {
    const { ctx, calls, deps } = setup([fixtureResponse('nrql_sync_1')]);
    const out = (await runRawNrql(ctx, { nrql: NRQL, mode: 'sync', stats: true }, deps)) as NrqlComplete;
    expect(calls[0]?.body.variables['stats']).toBe(true);
    expect(out.stats).toEqual({
      inspectedCount: expect.any(Number),
      matchCount: expect.any(Number),
      wallClockMs: expect.any(Number),
      scannedEvents: expect.any(Number),
    });
  });

  it('flags TIMESERIES results', async () => {
    const rows = [{ beginTimeSeconds: 1, endTimeSeconds: 2, count: 3 }];
    const { ctx, deps } = setup([submitted(true, rows)]);
    const out = (await runRawNrql(ctx, { nrql: NRQL }, deps)) as NrqlComplete;
    expect(out.metadata.timeseries).toBe(true);
  });

  it('validates input before any request', async () => {
    const { ctx, calls, deps } = setup([submitted(true, [])]);
    for (const input of [
      { nrql: ' ' },
      { nrql: NRQL, timeoutS: 0 },
      { nrql: NRQL, timeoutS: 121 },
      { nrql: NRQL, timeoutS: 1.5 },
      { nrql: NRQL, maxPolls: 11 },
      { nrql: NRQL, accounts: [-1] },
    ]) {
      expect((await failure(runRawNrql(ctx, input, deps))).code).toBe(ErrorCode.InputInvalid);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses accounts outside the connection scope without calling New Relic', async () => {
    const { ctx, calls, deps } = setup([submitted(true, [])]);
    const error = await failure(runRawNrql(ctx, { nrql: NRQL, accounts: [999] }, deps));
    expect(error.code).toBe(ErrorCode.AuthForbidden);
    expect(calls).toHaveLength(0);
  });
});

describe('runNrql: errors (fixtures)', () => {
  it('passes NRQL syntax errors back with a hint', async () => {
    const { ctx, deps } = setup([fixtureResponse('error_bad_nrql')]);
    const error = await failure(runRawNrql(ctx, { nrql: 'SELEC count(* FROM Nowhere' }, deps));
    expect(error.code).toBe(ErrorCode.InputInvalid);
    expect(error.message).toContain("NRQL Syntax Error: Error at line 1 position 1, unexpected 'SELEC'");
    expect(error.hint).toContain('docs.newrelic.com');
    expect(error.details).toEqual({ errorCode: 'NRDB:1102004' });
  });

  it('maps an account New Relic denies to RB_AUTH_FORBIDDEN', async () => {
    const { ctx, deps } = setup([fixtureResponse('error_unknown_account')]);
    expect((await failure(runRawNrql(ctx, { nrql: NRQL, accounts: [B] }, deps))).code).toBe(
      ErrorCode.AuthForbidden,
    );
  });

  it('maps an NRQL timeout to RB_NERDGRAPH_TIMEOUT with a narrowing hint', async () => {
    const body = {
      data: { actor: { account: { nrql: null } } },
      errors: [
        {
          message: 'NRDB query timed out',
          path: ['actor', 'account', 'nrql'],
          extensions: { errorClass: 'TIMEOUT' },
        },
      ],
    };
    const { ctx, deps } = setup([json(body)]);
    const error = await failure(runRawNrql(ctx, { nrql: NRQL, mode: 'sync', timeoutS: 5 }, deps));
    expect(error.code).toBe(ErrorCode.NerdGraphTimeout);
    expect(error.hint).toContain('SINCE');
  });
});

describe('runNrql: async', () => {
  it('returns at once when the async submit completes (fixture)', async () => {
    const { ctx, calls, deps } = setup([fixtureResponse('nrql_async_start')]);
    const out = await runRawNrql(ctx, { nrql: NRQL, timeoutS: 1 }, deps);
    expect(out).toMatchObject({ status: 'complete', results: [], polls: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.variables).toMatchObject({ async: true, timeout: 1 });
  });

  it('polls with retryAfter until complete, in the same account', async () => {
    const { ctx, calls, sleeps, deps } = setup([
      submitted(false),
      polled(false, null, 3),
      polled(true, [{ count: 7 }]),
    ]);
    const out = (await runRawNrql(ctx, { nrql: NRQL, accounts: [B] }, deps)) as NrqlComplete;
    expect(out).toMatchObject({ status: 'complete', results: [{ count: 7 }], polls: 2, accounts: [B] });
    expect(sleeps).toEqual([2000, 3000]);
    expect(calls[1]?.body.operationName).toBe('RbNrqlProgress');
    expect(calls[1]?.body.variables).toEqual({ accountId: B, queryId: 'q-123e4567-e89b', stats: false });
  });

  it('returns a pending handle after maxPolls', async () => {
    const { ctx, calls, deps } = setup([submitted(false), polled(false, null, 60)]);
    const out = (await runRawNrql(ctx, { nrql: NRQL, maxPolls: 2 }, deps)) as NrqlPending;
    expect(out).toEqual({
      status: 'pending',
      queryId: 'q-123e4567-e89b',
      account: A,
      retryAfterS: 60,
      expiresAt: new Date(EXPIRES).toISOString(),
      polls: 2,
      notes: [],
      nrql: NRQL,
      durationMs: 0,
    });
    expect(calls).toHaveLength(3);
  });

  it('ignores an unreadable resultExpiration instead of failing (review P1-R)', async () => {
    const bad = json({
      data: {
        actor: {
          account: {
            nrql: {
              ...progress(false),
              queryProgress: { ...progress(false).queryProgress, resultExpiration: 1e300 },
            },
          },
        },
      },
    });
    const { ctx, deps } = setup([bad]);
    const out = (await runRawNrql(ctx, { nrql: NRQL, mode: 'async' }, deps)) as NrqlPending;
    expect(out.status).toBe('pending');
    expect(out.expiresAt).toBeUndefined();
  });

  it('caps the wait between polls', async () => {
    // The first wait comes from the submit's retryAfter (2 s); the next one is capped at 10 s.
    const poll = setup([submitted(false), polled(false, null, 600), polled(false, null, 600)]);
    await runRawNrql(poll.ctx, { nrql: NRQL, maxPolls: 2 }, poll.deps);
    expect(poll.sleeps).toEqual([2000, 10_000]);
  });

  it('never polls beyond the budget', async () => {
    const { ctx, calls, deps } = setup([submitted(false), polled(false)], 3);
    const out = await runRawNrql(ctx, { nrql: NRQL, maxPolls: 10 }, deps);
    expect(out.status).toBe('pending');
    expect(calls).toHaveLength(3);
    expect(ctx.budget.used).toBe(3);
  });

  it('async mode returns the handle without polling', async () => {
    const { ctx, calls, deps } = setup([submitted(false)]);
    const out = await runRawNrql(ctx, { nrql: NRQL, mode: 'async', maxPolls: 5 }, deps);
    expect(out.status).toBe('pending');
    expect(calls).toHaveLength(1);
  });

  it('falls back to a long sync query when async is unavailable', async () => {
    const unavailable = json({
      data: { actor: { account: { nrql: null } } },
      errors: [{ message: 'Async queries require Data Plus', path: ['actor', 'account', 'nrql'] }],
    });
    const { ctx, calls, deps } = setup([unavailable, fixtureResponse('nrql_sync_1')]);
    const out = await runRawNrql(ctx, { nrql: NRQL }, deps);
    expect(out.status).toBe('complete');
    expect(calls[1]?.body.variables).toMatchObject({ async: false, timeout: 120 });
  });
});

describe('runNrql: malformed progress', () => {
  it('fails instead of returning an empty result when an unfinished query has no id', async () => {
    const body = progress(false);
    const { ctx, deps } = setup([
      json({
        data: {
          actor: { account: { nrql: { ...body, queryProgress: { ...body.queryProgress, queryId: null } } } },
        },
      }),
    ]);
    expect((await failure(runRawNrql(ctx, { nrql: NRQL }, deps))).code).toBe(ErrorCode.NerdGraphError);
  });
});

describe('runNrql: cross-account', () => {
  it('uses actor.nrql for several accounts (fixture)', async () => {
    const { ctx, calls, deps } = setup([fixtureResponse('cross_account')]);
    const out = (await runRawNrql(ctx, { nrql: NRQL, accounts: [A, B, A] }, deps)) as NrqlComplete;
    expect(calls[0]?.body.operationName).toBe('RbNrqlCrossAccount');
    expect(calls[0]?.body.variables).toEqual({ accounts: [A, B], nrql: NRQL, timeout: 10, stats: false });
    expect(out).toMatchObject({
      status: 'complete',
      accounts: [A, B],
      totalResult: { count: 0 },
      otherResult: { count: 0 },
      metadata: { facets: ['accountId()'] },
    });
    expect(loadFixture('cross_account').response.status).toBe(200);
  });

  it('rejects async mode for several accounts', async () => {
    const { ctx, deps } = setup([fixtureResponse('cross_account')]);
    expect((await failure(runRawNrql(ctx, { nrql: NRQL, accounts: [A, B], mode: 'async' }, deps))).code).toBe(
      ErrorCode.InputInvalid,
    );
  });
});

describe('getQueryResult', () => {
  it('returns the result when complete', async () => {
    const { ctx, deps } = setup([polled(true, [{ count: 1 }])]);
    expect(await getQueryResult(ctx, { queryId: 'q-1', account: A }, deps)).toMatchObject({
      status: 'complete',
      results: [{ count: 1 }],
    });
  });

  it('validates the handle and the account', async () => {
    const { ctx, calls, deps } = setup([polled(true, [])]);
    expect((await failure(getQueryResult(ctx, { queryId: 'bad id {', account: A }, deps))).code).toBe(
      ErrorCode.InputInvalid,
    );
    expect((await failure(getQueryResult(ctx, { queryId: 'q-1', account: 42 }, deps))).code).toBe(
      ErrorCode.AuthForbidden,
    );
    expect(calls).toHaveLength(0);
  });
});
