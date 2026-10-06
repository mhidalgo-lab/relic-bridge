// SPDX-License-Identifier: Apache-2.0
// P6-20 (Phase 6 review M2): a tool's declared `cost` is what `affordable` (tool hiding) and the composites' budget
// planning use, so it must bound the NerdGraph requests a call really sends. Rule: every NRQL counts as two requests
// (async submit + one poll, or the async attempt + the sync fallback); retries are not counted (they only happen after a
// failure, and the per-request budget caps them). The mock below forces the worst case on every NRQL.
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createBudget, createBuiltinTools, type FetchLike, ToolRegistry } from '../src/index.ts';
import { testContext } from './helpers/context.ts';
import { connectInMemory, resultText } from './helpers/mcp.ts';
import { MOCK_ACCOUNT, MOCK_GUID, mockNerdGraph } from './helpers/mock-nerdgraph.ts';
import { SAMPLE_CALLS } from './helpers/sample-calls.ts';

/** Every async NRQL submit answers "still running"; the poll then returns the normal result (submit + poll = 2). */
function asyncEverywhere(base: FetchLike): FetchLike {
  return async (url, init) => {
    const sent = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    const res = await base(url, init);
    if (!/query RbNrql\b/.test(sent.query) || sent.variables['async'] !== true) return res;
    const body = JSON.parse(await res.text()) as {
      data: { actor: { account: { nrql: { queryProgress: object } } } };
    };
    body.data.actor.account.nrql.queryProgress = {
      queryId: 'q-123e4567-e89b',
      completed: false,
      retryAfter: 1,
      resultExpiration: null,
    };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
}

/** Async is "unavailable" for the account: every NRQL costs the failed async attempt plus the sync fallback. */
function asyncUnavailable(base: FetchLike): FetchLike {
  return async (url, init) => {
    const sent = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    if (/query RbNrql\b/.test(sent.query) && sent.variables['async'] === true) {
      return new Response(
        JSON.stringify({
          data: { actor: { account: null } },
          errors: [{ message: 'Async queries are not enabled for this account (Data Plus required).' }],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    return base(url, init);
  };
}

const guidOf = (id: number) => btoa(`${MOCK_ACCOUNT}|APM|APPLICATION|${id}`).replace(/=+$/, '');

/** The widest answers the tools accept: 20 golden metrics, 8 neighbours (the composites' caps are lower). */
function wide(base: FetchLike): FetchLike {
  return async (url, init) => {
    const sent = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    const reply = (data: object) =>
      new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
    const guid = sent.variables['guid'] ?? MOCK_GUID;
    if (/query RbGoldenMetrics\b/.test(sent.query)) {
      const metrics = Array.from({ length: 20 }, (_, i) => ({
        title: `Metric ${i}`,
        query: `FROM Metric SELECT average(m${i}) WHERE entity.guid = 'X'`,
      }));
      const entity = { guid, name: 'checkout', accountId: MOCK_ACCOUNT, domain: 'APM', type: 'APPLICATION' };
      return reply({ actor: { entity: { ...entity, goldenMetrics: { metrics } } } });
    }
    if (/query RbRelatedEntities\b/.test(sent.query)) {
      const vertex = (g: string, n: string) => ({
        guid: g,
        accountId: MOCK_ACCOUNT,
        entity: {
          name: n,
          domain: 'APM',
          type: 'APPLICATION',
          alertSeverity: 'NOT_ALERTING',
          reporting: true,
        },
      });
      const results = Array.from({ length: 8 }, (_, i) => ({
        type: 'CALLS',
        source: vertex(String(guid), 'checkout'),
        target: vertex(guidOf(100 + i), `dependency-${i}`),
      }));
      return reply({
        actor: {
          entity: {
            guid,
            accountId: MOCK_ACCOUNT,
            name: 'checkout',
            relatedEntities: { nextCursor: null, results },
          },
        },
      });
    }
    return base(url, init);
  };
}

const registry = new ToolRegistry();
for (const tool of createBuiltinTools({ fetch: async () => new Response('{}') })) registry.register(tool);
const tools = registry.list();
const costOf = (name: string) => tools.find((t) => t.name === name)?.cost ?? 0;

/** Largest depth arguments a composite accepts, to prove it degrades instead of overrunning. */
const MAX_ARGS: Record<string, Record<string, unknown>> = {
  get_golden_metrics: { guid: MOCK_GUID, max_metrics: 20 },
  dependency_health: { guid: MOCK_GUID, max_dependencies: 5, max_metrics: 5 },
  entity_health: { guid: MOCK_GUID },
  generate_alert_insights_report: { issue_id: 'issue-1' },
  generate_user_impact_report: { issue_id: 'issue-1' },
};

type Mode = 'async + poll' | 'async unavailable';
const MODES: Record<Mode, (f: FetchLike) => FetchLike> = {
  'async + poll': asyncEverywhere,
  'async unavailable': asyncUnavailable,
};

let clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

async function connect(mode: Mode, budget: number) {
  const mock = mockNerdGraph();
  const built = createBuiltinTools({ fetch: MODES[mode](wide(mock.fetch)), sleep: async () => {} });
  const client = await connectInMemory(built, () =>
    testContext({
      accounts: { allowed: [MOCK_ACCOUNT], default: MOCK_ACCOUNT },
      budget: createBudget(budget),
      clock: { now: () => 1790943448000 },
    }),
  );
  clients.push(client);
  return { client, mock };
}

const openWorld = tools.filter((t) => t.openWorld).map((t) => t.name);
/** Name-path arguments for tools whose name input excludes, or needs, another one. */
const NAME_ARGS: Record<string, Record<string, unknown>> = {
  generate_user_impact_report: { name: 'checkout' },
  trace_error: { name: 'checkout', error_group_id: 'eg-1' },
};
const byName = tools.filter((t) => t.openWorld && 'name' in t.inputSchema.shape).map((t) => t.name);

describe('declared cost bounds the worst-case requests of a call (P6-20)', () => {
  for (const mode of Object.keys(MODES) as Mode[]) {
    describe(mode, () => {
      it.each(openWorld)('%s', async (name) => {
        const { client, mock } = await connect(mode, 500);
        const r = await client.callTool({ name, arguments: SAMPLE_CALLS[name] ?? {} });
        expect(
          mock.calls.length,
          `${name}: ${mock.calls.length} requests, declared ${costOf(name)}`,
        ).toBeLessThanOrEqual(costOf(name));
      });

      it.each(byName)('%s by name', async (name) => {
        const { client, mock } = await connect(mode, 500);
        const { guid: _g, entity_guid: _e, ...rest } = SAMPLE_CALLS[name] ?? {};
        const args = NAME_ARGS[name] ?? { ...rest, name: 'checkout' };
        const r = await client.callTool({ name, arguments: args });
        expect(r.isError, resultText(r)).toBeFalsy();
        expect(
          mock.calls.length,
          `${name} by name: ${mock.calls.length} requests, declared ${costOf(name)}`,
        ).toBeLessThanOrEqual(costOf(name));
      });
    });
  }
});

describe('name resolution at its worst case (P6-20)', () => {
  it('a name matching nothing scans three catalogue pages and stays within resolve_entity cost', async () => {
    const mock = mockNerdGraph();
    let searches = 0;
    const fetch: FetchLike = async (url, init) => {
      const sent = JSON.parse(String(init.body)) as { query: string };
      if (!/query RbEntitySearch\b/.test(sent.query)) return mock.fetch(url, init);
      searches++;
      const entities = Array.from({ length: 200 }, (_, i) => ({
        guid: guidOf(1000 + searches * 1000 + i),
        name: `other-${searches}-${i}`,
        accountId: MOCK_ACCOUNT,
        domain: 'APM',
        type: 'APPLICATION',
      }));
      return new Response(
        JSON.stringify({
          data: {
            actor: { entitySearch: { count: 9999, results: { nextCursor: `c${searches}`, entities } } },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    };
    const client = await connectInMemory(createBuiltinTools({ fetch, sleep: async () => {} }), () =>
      testContext({
        accounts: { allowed: [MOCK_ACCOUNT], default: MOCK_ACCOUNT },
        budget: createBudget(500),
        clock: { now: () => 1790943448000 },
      }),
    );
    clients.push(client);
    await client.callTool({ name: 'resolve_entity', arguments: { query: 'zzz-nothing-like-this' } });
    expect(searches).toBeGreaterThan(1);
    expect(searches).toBeLessThanOrEqual(costOf('resolve_entity'));
  });
});

describe('composites at their maximum arguments end within the Workers Free budget (P6-20)', () => {
  it.each(Object.keys(MAX_ARGS))('%s', async (name) => {
    const { client, mock } = await connect('async + poll', 45);
    const r = await client.callTool({ name, arguments: MAX_ARGS[name] ?? {} });
    expect(r.isError, resultText(r)).toBeFalsy();
    expect(resultText(r)).not.toContain('RB_BUDGET_EXHAUSTED');
    expect(mock.calls.length).toBeLessThanOrEqual(45);
  });
});
