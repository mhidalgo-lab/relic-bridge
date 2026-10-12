// SPDX-License-Identifier: Apache-2.0
// P8-20 (BUG-04): a name that matches a same-named APM and BROWSER entity can be narrowed with `domain` / `type`.
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMcpServer,
  createBudget,
  createBuiltinTools,
  type FetchLike,
  type ToolContext,
} from '../src/index.ts';
import { testContext } from './helpers/context.ts';
import { json } from './helpers/nerdgraph.ts';

const A = 1000001;
const guidOf = (domain: string, id: string) => btoa(`${A}|${domain}|APPLICATION|${id}`).replace(/=+$/, '');
const APM = guidOf('APM', '1');
const BROWSER = guidOf('BROWSER', '2');

/** A fake NerdGraph: one APM and one BROWSER entity named "shop-app"; honours `domain = 'X'` and `type = 'X'`. */
function fakeNerdGraph() {
  const queries: string[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const { variables } = JSON.parse(String(init.body)) as { variables: { query?: string } };
    const q = String(variables.query ?? '');
    queries.push(q);
    const domain = /domain = '([A-Z_]+)'/.exec(q)?.[1];
    const type = /type = '([A-Z_]+)'/.exec(q)?.[1];
    const rows = [
      { guid: APM, domain: 'APM' },
      { guid: BROWSER, domain: 'BROWSER' },
    ].filter(
      (e) => (domain === undefined || e.domain === domain) && (type === undefined || type === 'APPLICATION'),
    );
    return json({
      data: {
        actor: {
          entitySearch: {
            count: rows.length,
            results: {
              nextCursor: null,
              entities: rows.map((e) => ({
                ...e,
                name: 'shop-app',
                accountId: A,
                type: 'APPLICATION',
                entityType: 'X',
                alertSeverity: 'NOT_ALERTING',
                reporting: true,
              })),
            },
          },
        },
      },
    });
  };
  return { fetch, queries };
}

describe('name lookups narrowed by domain and type (P8-20, BUG-04)', () => {
  let clients: Client[] = [];
  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close()));
    clients = [];
  });

  async function connect() {
    const f = fakeNerdGraph();
    const ctx: ToolContext = testContext({
      accounts: { allowed: [A], default: A },
      budget: createBudget(50),
    });
    const server = buildMcpServer({
      tools: createBuiltinTools({ fetch: f.fetch, sleep: async () => {} }),
      ctx,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(ct);
    clients.push(client);
    return { client, ...f };
  }
  const textOf = (r: { content?: unknown }) =>
    (r.content as { text: string }[]).map((c) => c.text).join('\n');

  // Tools that take a name through the adapter or directly (get_entity, get_golden_metrics, get_related_entities).
  const OPEN = [
    'get_entity',
    'entity_health',
    'get_golden_metrics',
    'get_related_entities',
    'list_recent_logs',
  ];

  it.each(OPEN)('%s: a bare name is ambiguous, the error says to use domain', async (tool) => {
    const { client } = await connect();
    const r = await client.callTool({ name: tool, arguments: { name: 'shop-app' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('matches 2 entities');
    expect(textOf(r)).toContain('domain');
  });

  it.each(OPEN)('%s: domain picks one entity and the search is filtered server-side', async (tool) => {
    const { client, queries } = await connect();
    const r = await client.callTool({ name: tool, arguments: { name: 'shop-app', domain: 'apm' } });
    expect(textOf(r)).not.toContain('matches 2 entities');
    expect(textOf(r)).not.toContain('Invalid');
    expect(queries[0]).toContain("domain = 'APM'");
  });

  it('type narrows too', async () => {
    const { client, queries } = await connect();
    await client.callTool({
      name: 'get_entity',
      arguments: { name: 'shop-app', domain: 'BROWSER', type: 'APPLICATION' },
    });
    expect(queries[0]).toContain("domain = 'BROWSER'");
    expect(queries[0]).toContain("type = 'APPLICATION'");
  });

  it.each(OPEN)('%s: domain or type without name is refused before any request', async (tool) => {
    const { client, queries } = await connect();
    for (const extra of [{ domain: 'APM' }, { type: 'APPLICATION' }]) {
      const r = await client.callTool({ name: tool, arguments: { entity_guid: APM, ...extra } });
      expect(r.isError, tool).toBe(true);
      expect(textOf(r)).toMatch(/only applies together with "name"/);
    }
    expect(queries).toEqual([]);
  });

  it('rejects a domain that is not a plain identifier (no injection into the entity query)', async () => {
    const { client, queries } = await connect();
    const r = await client.callTool({
      name: 'get_entity',
      arguments: { name: 'x', domain: "APM' OR name LIKE '%" },
    });
    expect(r.isError).toBe(true);
    expect(queries).toEqual([]);
  });

  const APM_ONLY = [
    'list_top_transactions',
    'analyze_transactions',
    'analyze_deployment_impact',
    'analyze_threads',
    'list_gc_metrics',
  ];
  it.each(APM_ONLY)('%s: a name resolves to the APM entity without asking for a domain', async (tool) => {
    const { client, queries } = await connect();
    const r = await client.callTool({ name: tool, arguments: { name: 'shop-app' } });
    expect(textOf(r)).not.toContain('matches 2 entities');
    expect(queries[0]).toContain("domain = 'APM'");
  });

  it.each(APM_ONLY)('%s: takes no domain input (pinned to APM)', async (tool) => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const props = Object.keys((tools.find((t) => t.name === tool)?.inputSchema.properties ?? {}) as object);
    expect(props).toContain('name');
    expect(props).not.toContain('domain');
  });
});
