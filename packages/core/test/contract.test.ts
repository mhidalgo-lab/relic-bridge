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
import { RESOLVE_COST } from '../src/tools/entity-ref.ts';
import { FAKE_KEY, testContext } from './helpers/context.ts';
import { connectInMemory, resultText } from './helpers/mcp.ts';
import { MOCK_ACCOUNT, MOCK_GUID, mockNerdGraph } from './helpers/mock-nerdgraph.ts';
import { SAMPLE_CALLS } from './helpers/sample-calls.ts';

/**
 * MCP contract tests: every tool in the registry is listed and called through a real in-memory MCP client.
 * Tools are discovered from the registry, so a new tool is covered automatically; one without a sample call below
 * fails `every registered tool has a sample call`, which forces whoever adds it to extend this table.
 */
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
      clock: { now: () => 1790943448000 },
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
    // Read-only by construction (ADR-0014, T22): every document sent is a named query, never a mutation.
    for (const call of mock.calls) expect(call.body.query, name).toMatch(/^\s*query\s+Rb[A-Za-z0-9_]*\b/);
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

  describe('name instead of guid (P6-17)', () => {
    // Tool -> its guid input. Every other required argument is the sample call's.
    const NAME_INPUT: Record<string, string> = {
      get_entity: 'entity_guid',
      get_related_entities: 'entity_guid',
      get_golden_metrics: 'entity_guid',
      get_dashboard: 'entity_guid',
      dependency_health: 'entity_guid',
      entity_health: 'entity_guid',
      generate_user_impact_report: 'entity_guid',
      list_top_transactions: 'entity_guid',
      analyze_transactions: 'entity_guid',
      analyze_threads: 'entity_guid',
      list_gc_metrics: 'entity_guid',
      analyze_deployment_impact: 'entity_guid',
      analyze_entity_logs: 'entity_guid',
      list_recent_logs: 'entity_guid',
      list_error_groups: 'entity_guid',
      list_change_events: 'entity_guid',
      list_recent_issues: 'entity_guid',
      search_incidents: 'entity_guid',
      trace_error: 'entity_guid',
    };
    const NAME_TOOLS = Object.keys(NAME_INPUT);
    /** The sample call with the guid input replaced by a name. */
    const byNameArgs = (name: string, nameValue: string) => {
      const {
        [NAME_INPUT[name] as string]: _drop,
        issue_id: _issue,
        trace_id: _trace,
        ...rest
      } = SAMPLE_CALLS[name] ?? {};
      return { ...rest, ...(name === 'trace_error' ? { error_group_id: 'eg-1' } : {}), name: nameValue };
    };
    const guidArgs = (name: string) => ({
      ...(SAMPLE_CALLS[name] ?? {}),
      [NAME_INPUT[name] as string]: MOCK_GUID,
    });

    it.each(NAME_TOOLS)('%s: a name resolves and answers like the guid', async (name) => {
      const { client, mock } = await connectAll();
      const byName = await client.callTool({ name, arguments: byNameArgs(name, 'checkout') });
      expect(byName.isError, resultText(byName)).toBeFalsy();
      expect(resultText(byName)).toContain('Resolved name "checkout"');
      const def = registry.get(name);
      expect(def?.outputSchema?.safeParse(byName.structuredContent).success).toBe(true);
      expect(mock.calls.map((c) => c.body.query).some((q) => /entitySearch/.test(q))).toBe(true);
      // A guid never searches.
      const before = mock.calls.length;
      await client.callTool({ name, arguments: guidArgs(name) });
      const sent = mock.calls.slice(before).map((c) => c.body.query);
      expect(sent.some((q) => /entitySearch/.test(q))).toBe(false);
    });

    it.each(NAME_TOOLS)('%s: guid XOR name, account only with a name', async (name) => {
      const { client, mock } = await connectAll();
      const field = NAME_INPUT[name] as string;
      for (const args of [
        { ...byNameArgs(name, 'checkout'), [field]: MOCK_GUID },
        ...(['get_entity', 'get_related_entities', 'get_golden_metrics'].includes(name)
          ? [{}, { entity_guid: MOCK_GUID, account: MOCK_ACCOUNT }]
          : []),
      ]) {
        const r = await client.callTool({ name, arguments: args }).catch((e: unknown) => e);
        if (!(r instanceof Error)) expect((r as { isError?: boolean }).isError).toBe(true);
      }
      expect(mock.calls).toHaveLength(0);
    });

    it.each(NAME_TOOLS)(
      '%s: the name field is advertised, and the cost includes the resolution',
      async (name) => {
        const { client } = await connectAll();
        const listed = (await client.listTools()).tools.find((t) => t.name === name);
        expect(Object.keys(listed?.inputSchema.properties ?? {})).toContain('name');
        expect(registry.get(name)?.cost).toBeGreaterThanOrEqual(RESOLVE_COST + 1);
      },
    );

    it('a name is refused before any request when its companion input excludes or needs it', async () => {
      const { client, mock } = await connectAll();
      for (const [tool, args] of [
        ['generate_user_impact_report', { name: 'checkout', issue_id: 'issue-1' }],
        ['trace_error', { name: 'checkout', trace_id: 'abcdef0123456789' }],
        ['dependency_health', { account: MOCK_ACCOUNT, guid: MOCK_GUID }],
        ['entity_health', {}],
      ] as const) {
        const r = await client.callTool({ name: tool, arguments: args }).catch((e: unknown) => e);
        if (!(r instanceof Error)) expect((r as { isError?: boolean }).isError, tool).toBe(true);
      }
      expect(mock.calls).toHaveLength(0);
    });

    it('a composite resolves once and plans its sections from the budget left after the resolution', async () => {
      const mock = mockNerdGraph();
      const tools = createBuiltinTools({ fetch: mock.fetch, sleep: async () => {} });
      const budget = createBudget(8);
      const client = await connectInMemory(tools, () =>
        testContext({
          accounts: { allowed: [MOCK_ACCOUNT], default: MOCK_ACCOUNT },
          budget,
          clock: { now: () => 1790943448000 },
        }),
      );
      clients.push(client);
      const r = await client.callTool({ name: 'entity_health', arguments: { name: 'checkout' } });
      expect(r.isError, resultText(r)).toBeFalsy();
      const searches = mock.calls.filter((c) => /entitySearch/.test(c.body.query)).length;
      expect(searches).toBeGreaterThan(0);
      expect(searches).toBeLessThanOrEqual(RESOLVE_COST);
      // Everything, resolution included, stayed within the budget; some sections did not fit and say so.
      expect(mock.calls.length).toBeLessThanOrEqual(8);
      expect(resultText(r)).toContain('skipped (budget)');
    });

    it.each(NAME_TOOLS)('%s: an unknown name is an input error, nothing else runs', async (name) => {
      const { client, mock } = await connectAll();
      const r = await client.callTool({ name, arguments: byNameArgs(name, 'no-such-service-anywhere') });
      expect(r.isError).toBe(true);
      expect((r._meta?.[ERROR_META_KEY] as { code?: string } | undefined)?.code).toBe('RB_INPUT_INVALID');
      expect(mock.calls.every((c) => /entitySearch/.test(c.body.query))).toBe(true);
    });
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
