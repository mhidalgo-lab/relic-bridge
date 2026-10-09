// SPDX-License-Identifier: Apache-2.0
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMcpServer,
  createBuiltinTools,
  createSchemaTools,
  type FetchLike,
  RESOURCES,
  selectResources,
  type ToolCallEvent,
  type ToolContext,
  type ToolDefinition,
} from '../src/index.ts';
import { NRQL_REFERENCE } from '../src/nrql-reference.ts';
import { testContext } from './helpers/context.ts';
import { json } from './helpers/nerdgraph.ts';

const A = 1000001;
const B = 1000002;
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

const nrqlBody = (results: unknown[]) =>
  json({
    data: {
      actor: {
        account: {
          nrql: {
            results,
            metadata: { eventTypes: [], facets: null, messages: null, timeWindow: null },
            totalResult: null,
            otherResult: null,
            queryProgress: { queryId: null, completed: true, retryAfter: null, resultExpiration: null },
          },
        },
      },
    },
  });

function recorder() {
  const queries: string[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { variables: Record<string, unknown> };
    const q = String(body.variables['nrql']);
    queries.push(q);
    return q.startsWith('SHOW EVENT TYPES')
      ? nrqlBody([{ eventType: 'Transaction' }, { eventType: 'Secret' }, { eventType: 'Log' }])
      : nrqlBody([
          { key: 'duration', type: 'numeric' },
          { key: 'appName', type: 'string' },
        ]);
  };
  return { fetch, queries };
}

async function connect(
  tools: readonly ToolDefinition[],
  ctx: ToolContext | (() => ToolContext),
  onToolCall?: (e: ToolCallEvent) => void,
) {
  const server = buildMcpServer({ tools, ctx, ...(onToolCall ? { onToolCall } : {}) });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientT);
  clients.push(client);
  return client;
}

const body = (r: { contents: { text?: string }[] }) => r.contents.map((c) => c.text ?? '').join('\n');
const schemaTools = (fetch: FetchLike) => [
  ...createSchemaTools({ fetch, sleep: async () => {} }),
  ...createBuiltinTools().filter((t) => t.name === 'run_nrql'),
];

describe('resources catalogue', () => {
  it('names only tools that exist', () => {
    const known = new Set(createBuiltinTools().map((t) => t.name));
    for (const r of RESOURCES) expect(known.has(r.needsTool), r.name).toBe(true);
    // every tool view names an offered resource of kind app, offered under that tool
    for (const t of createBuiltinTools()) {
      if (t.ui === undefined) continue;
      const r = RESOURCES.find((x) => x.uri === t.ui?.resourceUri);
      expect(r?.kind, t.name).toBe('app');
    }
  });

  it('keeps the static reference short and free of secrets-like text', () => {
    expect(NRQL_REFERENCE.length).toBeLessThan(8000);
    expect(NRQL_REFERENCE).not.toMatch(/NRAK-|rb_/);
  });

  it('selects by allowed tool', () => {
    expect(selectResources(new Set()).length).toBe(0);
    expect(selectResources(new Set(['get_attributes'])).map((r) => r.name)).toEqual([
      'event_type_attributes',
    ]);
  });
});

describe('resources over MCP', () => {
  it('lists the reference and one event-types URI per effective account, never attributes', async () => {
    const { fetch, queries } = recorder();
    const client = await connect(
      schemaTools(fetch),
      testContext({ accounts: { allowed: [A, B], default: A } }),
    );
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([
      `relic://accounts/${A}/event-types`,
      `relic://accounts/${B}/event-types`,
      'relic://nrql/reference',
      'ui://relic-bridge/nrql-chart',
    ]);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual([
      'relic://accounts/{account}/event-types',
      'relic://accounts/{account}/event-types/{eventType}/attributes',
    ]);
    expect(queries).toEqual([]);
  });

  it('serves the static reference without calling New Relic', async () => {
    const { fetch, queries } = recorder();
    const client = await connect(schemaTools(fetch), testContext());
    const r = await client.readResource({ uri: 'relic://nrql/reference' });
    expect(body(r as never)).toBe(NRQL_REFERENCE);
    expect(queries).toEqual([]);
  });

  it('reads event types and attributes, wrapped as untrusted data, and caches', async () => {
    const { fetch, queries } = recorder();
    const events: ToolCallEvent[] = [];
    const client = await connect(schemaTools(fetch), testContext(), (e) => events.push(e));
    const r1 = body((await client.readResource({ uri: `relic://accounts/${A}/event-types` })) as never);
    expect(r1).toContain('untrusted');
    expect(r1).toContain('Transaction');
    await client.readResource({ uri: `relic://accounts/${A}/event-types` });
    expect(queries.filter((q) => q.startsWith('SHOW EVENT TYPES')).length).toBe(1);
    const a = body(
      (await client.readResource({
        uri: `relic://accounts/${A}/event-types/Transaction/attributes`,
      })) as never,
    );
    expect(a).toContain('duration');
    expect(queries.at(-1)).toContain('keyset()');
    // audited as the underlying tools
    expect(events.map((e) => e.tool)).toEqual(['list_event_types', 'list_event_types', 'get_attributes']);
  });

  it('refuses an account outside the effective set before any New Relic call, same for unknown ones', async () => {
    const { fetch, queries } = recorder();
    const client = await connect(schemaTools(fetch), testContext());
    for (const uri of [
      `relic://accounts/${B}/event-types`,
      `relic://accounts/${B}/event-types/Transaction/attributes`,
      'relic://accounts/9999999999/event-types',
    ]) {
      await expect(client.readResource({ uri }), uri).rejects.toThrow(/RB_AUTH_FORBIDDEN/);
    }
    expect(queries).toEqual([]);
  });

  it('refuses malformed accounts and event types', async () => {
    const { fetch, queries } = recorder();
    const client = await connect(schemaTools(fetch), testContext());
    for (const uri of [
      'relic://accounts/abc/event-types',
      'relic://accounts/0/event-types',
      'relic://accounts/01/event-types',
      `relic://accounts/${A}/event-types/${encodeURIComponent('Log; DROP')}/attributes`,
    ]) {
      await expect(client.readResource({ uri }), uri).rejects.toThrow();
    }
    expect(queries).toEqual([]);
  });

  it('applies event-type allow/deny lists, also on a cache hit', async () => {
    const { fetch, queries } = recorder();
    let deny: string[] = [];
    const client = await connect(schemaTools(fetch), () =>
      testContext({ limits: { ...testContext().limits, eventTypes: { deny } } }),
    );
    await client.readResource({ uri: `relic://accounts/${A}/event-types/Secret/attributes` });
    deny = ['Secret'];
    const before = queries.length;
    await expect(
      client.readResource({ uri: `relic://accounts/${A}/event-types/Secret/attributes` }),
    ).rejects.toThrow();
    expect(queries.length).toBe(before);
    const list = body((await client.readResource({ uri: `relic://accounts/${A}/event-types` })) as never);
    expect(list).not.toContain('Secret');
  });

  it('does not share the cache between credentials', async () => {
    const { fetch, queries } = recorder();
    let id = 'cred-1';
    const tools = schemaTools(fetch);
    const client = await connect(tools, () =>
      testContext({ credential: { ...testContext().credential, id } }),
    );
    await client.readResource({ uri: `relic://accounts/${A}/event-types` });
    id = 'cred-2';
    await client.readResource({ uri: `relic://accounts/${A}/event-types` });
    expect(queries.filter((q) => q.startsWith('SHOW EVENT TYPES')).length).toBe(2);
  });

  it('offers nothing when the tools are not allowed (no resources capability, unknown URIs)', async () => {
    const client = await connect(
      createBuiltinTools().filter((t) => t.name === 'whoami'),
      testContext(),
    );
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
    await expect(client.readResource({ uri: 'relic://nrql/reference' })).rejects.toThrow();
    await expect(client.readResource({ uri: `relic://accounts/${A}/event-types` })).rejects.toThrow();
  });
});
