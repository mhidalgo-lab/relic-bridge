// SPDX-License-Identifier: Apache-2.0
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createBudget,
  createBuiltinTools,
  ERROR_META_KEY,
  inputJsonSchema,
  ToolRegistry,
} from '../src/index.ts';
import { FAKE_KEY, testContext } from './helpers/context.ts';
import { connectInMemory, resultText } from './helpers/mcp.ts';
import { MOCK_ACCOUNT, MOCK_GUID, mockNerdGraph } from './helpers/mock-nerdgraph.ts';

/**
 * MCP contract tests: every tool in the registry is listed and called through a real in-memory MCP client.
 * Tools are discovered from the registry, so a new tool is covered automatically; one without a sample call below
 * fails `every registered tool has a sample call`, which forces whoever adds it to extend this table.
 */
const SAMPLE_CALLS: Record<string, Record<string, unknown>> = {
  whoami: {},
  list_accounts: {},
  time_range: { expression: 'last 1 hour' },
  run_nrql: { nrql: 'SELECT count(*) FROM Transaction SINCE 1 hour ago' },
  get_query_result: { query_id: 'q-123e4567-e89b', account: MOCK_ACCOUNT },
  search_entities: { name: 'checkout' },
  get_entity: { guid: MOCK_GUID },
  get_related_entities: { guid: MOCK_GUID },
  list_entity_types: {},
  decode_entity_guid: { guid: MOCK_GUID },
  get_golden_metrics: { guid: MOCK_GUID },
  list_event_types: {},
  get_attributes: { event_type: 'Transaction' },
  list_alert_policies: {},
  list_alert_conditions: { policy_id: '8000026' },
  list_recent_issues: {},
  search_incidents: { states: ['CREATED'] },
  list_error_groups: { states: ['UNRESOLVED'], sort_by: 'occurrences' },
  list_change_events: {},
  analyze_deployment_impact: { entity_guid: MOCK_GUID },
};

const registry = new ToolRegistry();
for (const tool of createBuiltinTools({ fetch: async () => new Response('{}') })) registry.register(tool);
const names = registry.list().map((t) => t.name);

let clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

async function connectAll() {
  const mock = mockNerdGraph();
  const tools = createBuiltinTools({ fetch: mock.fetch, sleep: async () => {} });
  const ctx = () =>
    testContext({
      accounts: { allowed: [MOCK_ACCOUNT], default: MOCK_ACCOUNT },
      budget: createBudget(50),
    });
  const client = await connectInMemory(tools, ctx);
  clients.push(client);
  return { client, mock };
}

describe('MCP contract: every registered tool', () => {
  it('every registered tool has a sample call (and no stale samples)', () => {
    expect([...names].sort()).toEqual(Object.keys(SAMPLE_CALLS).sort());
  });

  it('lists exactly the registry, read-only, with schemas and derived annotations', async () => {
    const { client } = await connectAll();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...names].sort());
    for (const listed of tools) {
      const def = registry.get(listed.name);
      expect(def, listed.name).toBeDefined();
      expect(listed.description?.length, listed.name).toBeGreaterThanOrEqual(20);
      expect(listed.inputSchema, listed.name).toMatchObject({ type: 'object' });
      expect(listed.inputSchema, listed.name).toEqual(
        expect.objectContaining({ properties: expect.any(Object) }),
      );
      expect(listed.outputSchema, `${listed.name} declares an output schema`).toMatchObject({
        type: 'object',
      });
      expect(listed.annotations, listed.name).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: def?.openWorld,
      });
      // The schema agents see is the schema the registry validated for secret-like fields (T23).
      expect(JSON.stringify(inputJsonSchema(def as never)), listed.name).not.toMatch(
        /api[-_]?key|token|password|secret/i,
      );
    }
  });

  it.each(names)('%s: sample call succeeds and returns schema-valid structured content', async (name) => {
    const { client, mock } = await connectAll();
    const r = await client.callTool({ name, arguments: SAMPLE_CALLS[name] ?? {} });
    expect(r.isError, resultText(r)).toBeFalsy();
    expect(r.structuredContent).toBeDefined();
    const def = registry.get(name);
    expect(def?.outputSchema?.safeParse(r.structuredContent).success).toBe(true);
    expect(resultText(r).length).toBeGreaterThan(0);
    // Closed-world tools never reach the network; open-world ones may.
    if (!def?.openWorld) expect(mock.calls).toHaveLength(0);
    // No secret may leak into a result.
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
  });

  it.each(names)('%s: unknown arguments are rejected as an error result, not a crash', async (name) => {
    const { client } = await connectAll();
    const r = await client
      .callTool({ name, arguments: { definitely_not_an_argument: 1 } })
      .catch((error: unknown) => error);
    // SDK v2 reports invalid arguments either as isError result or a protocol error; both are acceptable, success is not.
    if (r instanceof Error) {
      expect(r.message).not.toContain(FAKE_KEY);
    } else {
      expect((r as { isError?: boolean }).isError).toBe(true);
    }
  });

  it('unknown tool names are rejected', async () => {
    const { client } = await connectAll();
    const r = await client.callTool({ name: 'delete_everything', arguments: {} }).catch((e: unknown) => e);
    if (!(r instanceof Error)) expect((r as { isError?: boolean }).isError).toBe(true);
  });

  it('error results carry a machine-readable code in _meta', async () => {
    const { client } = await connectAll();
    const r = await client.callTool({
      name: 'run_nrql',
      arguments: { nrql: 'SELECT 1 FROM Log', accounts: [999] },
    });
    expect(r.isError).toBe(true);
    expect(r._meta?.[ERROR_META_KEY]).toBeDefined();
  });
});
