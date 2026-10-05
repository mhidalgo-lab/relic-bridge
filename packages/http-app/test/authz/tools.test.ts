// SPDX-License-Identifier: Apache-2.0
// Tool-level authorization (P2-12, THREAT_MODEL T3): one case per built-in tool, run through the HTTP app against a
// hostile NerdGraph whose key also reaches a FOREIGN account and which mixes foreign or forged rows into every answer.
// A call naming a foreign account (or a GUID in one) is refused before any NerdGraph call; no result ever carries
// foreign data; every NerdGraph call names allowed accounts only. A tool outside the grant is neither listed nor
// callable, and the attempt is audited.
//
// Adding a tool: add its entry to TOOL_CASES (the guard below fails until you do), with at least one call that names
// a foreign account when the tool takes an account or a GUID.
import type { Client } from '@modelcontextprotocol/client';
import { ERROR_META_KEY, ErrorCode } from '@relic-bridge/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG, connect, NR_KEY } from '../fixtures.ts';
import { accountsNamed, createHarness, FOREIGN, guidOf, type Harness, LEAK } from './harness.ts';

/** `ok`: answered; `refused`: RB_AUTH_FORBIDDEN. `offline`: must not reach NerdGraph at all. */
interface ToolCall {
  readonly args: Record<string, unknown>;
  readonly expect: 'ok' | 'refused';
  readonly offline?: boolean;
}

const NRQL = 'SELECT count(*) FROM Transaction SINCE 1 hour ago';
const ALLOWED = [1, 2] as const;

export const TOOL_CASES: Readonly<Record<string, readonly ToolCall[]>> = {
  whoami: [{ args: {}, expect: 'ok' }],
  list_accounts: [{ args: {}, expect: 'ok' }],
  time_range: [{ args: { expression: 'last 2 hours' }, expect: 'ok', offline: true }],
  run_nrql: [
    { args: { nrql: NRQL, accounts: [FOREIGN] }, expect: 'refused', offline: true },
    { args: { nrql: NRQL, accounts: [1, FOREIGN] }, expect: 'refused', offline: true },
    { args: { nrql: NRQL, accounts: [3] }, expect: 'refused', offline: true }, // reachable by the key, not allowed
    { args: { nrql: NRQL }, expect: 'ok' },
    { args: { nrql: NRQL, accounts: [1, 2] }, expect: 'ok' },
  ],
  get_query_result: [
    { args: { query_id: 'q-123', account: FOREIGN }, expect: 'refused', offline: true },
    { args: { query_id: 'q-123', account: 1 }, expect: 'ok' },
  ],
  list_event_types: [
    { args: { account: FOREIGN }, expect: 'refused', offline: true },
    { args: {}, expect: 'ok' },
  ],
  get_attributes: [
    { args: { event_type: 'Transaction', account: FOREIGN }, expect: 'refused', offline: true },
    { args: { event_type: 'Transaction' }, expect: 'ok' },
  ],
  search_entities: [
    { args: { account: FOREIGN }, expect: 'refused', offline: true },
    { args: {}, expect: 'ok' },
    { args: { account: 2 }, expect: 'ok' },
  ],
  list_entity_types: [
    { args: { account: FOREIGN }, expect: 'refused', offline: true },
    { args: {}, expect: 'ok' },
  ],
  list_alert_policies: [
    { args: { account: FOREIGN }, expect: 'refused', offline: true },
    { args: { account: 3 }, expect: 'refused', offline: true }, // reachable by the key, not allowed
    { args: {}, expect: 'ok' },
    { args: { account: 2, name: 'x' }, expect: 'ok' },
  ],
  list_alert_conditions: [
    { args: { account: FOREIGN }, expect: 'refused', offline: true },
    { args: { account: 3, policy_id: '1' }, expect: 'refused', offline: true },
    { args: {}, expect: 'ok' },
    { args: { account: 2, policy_id: '8000026' }, expect: 'ok' },
  ],
  list_recent_issues: [
    { args: { account: FOREIGN }, expect: 'refused', offline: true },
    { args: { account: 3 }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    { args: {}, expect: 'ok' },
    { args: { account: 2, states: ['ACTIVATED'] }, expect: 'ok' },
  ],
  search_incidents: [
    { args: { account: FOREIGN }, expect: 'refused', offline: true },
    { args: { account: 3 }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    { args: {}, expect: 'ok' },
    { args: { account: 2, priority: ['CRITICAL'] }, expect: 'ok' },
  ],
  list_error_groups: [
    { args: { account: FOREIGN }, expect: 'refused', offline: true },
    { args: { account: 3 }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    { args: {}, expect: 'ok' },
    { args: { account: 2, states: ['UNRESOLVED'] }, expect: 'ok' },
  ],
  list_change_events: [
    { args: { account: FOREIGN }, expect: 'refused', offline: true },
    { args: { account: 3 }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    // NerdGraph answers with an entity in the foreign account behind an allowed account's GUID.
    { args: { entity_guid: guidOf(1) }, expect: 'refused' },
    { args: {}, expect: 'ok' },
    { args: { account: 2, limit: 5 }, expect: 'ok' },
  ],
  analyze_deployment_impact: [
    { args: { entity_guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(3) }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(1) }, expect: 'refused' },
  ],
  list_top_transactions: [
    { args: { entity_guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(3) }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(1) }, expect: 'ok' },
    { args: { entity_guid: guidOf(2), sort_by: 'errors', limit: 5 }, expect: 'ok' },
  ],
  analyze_transactions: [
    { args: { entity_guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(3) }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(1) }, expect: 'ok' },
  ],
  list_recent_logs: [
    { args: { entity_guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(3) }, expect: 'refused', offline: true },
    { args: { account: FOREIGN }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(1) }, expect: 'ok' },
    { args: { account: 2, level: 'error', contains: "a'b" }, expect: 'ok' },
  ],
  analyze_entity_logs: [
    { args: { entity_guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(3) }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(1) }, expect: 'ok' },
  ],
  analyze_threads: [
    { args: { entity_guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(3) }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(1) }, expect: 'ok' },
  ],
  list_gc_metrics: [
    { args: { entity_guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(3) }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(1) }, expect: 'ok' },
  ],
  analyze_kafka_metrics: [
    { args: { account: FOREIGN }, expect: 'refused', offline: true },
    { args: { account: 3 }, expect: 'refused', offline: true },
    { args: { account: 2, cluster_name: "a'b" }, expect: 'ok' },
  ],
  get_entity: [
    { args: { guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    // NerdGraph answers with an entity in the foreign account behind an allowed account's GUID.
    { args: { guid: guidOf(1) }, expect: 'refused' },
  ],
  get_related_entities: [
    { args: { guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    { args: { guid: guidOf(1) }, expect: 'ok' },
  ],
  get_golden_metrics: [
    { args: { guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    { args: { guid: guidOf(1) }, expect: 'refused' },
  ],
  // Offline decoding of the caller's own input: says the account is not available, fetches nothing.
  decode_entity_guid: [{ args: { guid: guidOf(FOREIGN) }, expect: 'ok', offline: true }],
};

let h: Harness;
let clients: Client[];

beforeEach(async () => {
  h = await createHarness();
  clients = [];
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await h.scan();
});

/** A project allowing accounts 1 and 2 on a key that reaches 1, 2, 3 and FOREIGN (a User key spans accounts). */
async function isoClient(): Promise<Client> {
  const credentialId = await h.addCredential();
  const projectId = await h.addProject('iso', { credentialId, allowed: [...ALLOWED] });
  const grantId = await h.addGrant(projectId);
  const token = await h.addToken(grantId);
  const client = await connect(h.app, 'iso', token.value, 'modern');
  clients.push(client);
  return client;
}

describe('tool isolation against a hostile NerdGraph', () => {
  for (const [tool, calls] of Object.entries(TOOL_CASES)) {
    it(`${tool}: foreign accounts refused, foreign data never returned`, async () => {
      const client = await isoClient();
      for (const call of calls) {
        const before = h.nerdGraph.calls.length;
        const result = await client.callTool({ name: tool, arguments: call.args });
        const what = `${tool}(${JSON.stringify(call.args)})`;
        const dump = JSON.stringify(result);
        h.responses.push(dump);
        expect(dump, what).not.toContain(LEAK);
        const code = (result._meta?.[ERROR_META_KEY] as { code?: string } | undefined)?.code;
        if (call.expect === 'refused') {
          expect(result.isError, what).toBe(true);
          expect(code, what).toBe(ErrorCode.AuthForbidden);
        } else {
          expect(result.isError ?? false, `${what}: ${dump.slice(0, 300)}`).toBe(false);
        }
        const made = h.nerdGraph.calls.slice(before);
        if (call.offline) expect(made, `${what} must not reach NerdGraph`).toEqual([]);
        for (const c of made) {
          expect(c.apiKey, what).toBe(NR_KEY);
          for (const account of accountsNamed(c)) expect(ALLOWED, `${what} → ${c.op}`).toContain(account);
        }
      }
    });
  }

  it('alert tools drop rows of other accounts and say so', async () => {
    const client = await isoClient();
    const policies = await client.callTool({ name: 'list_alert_policies', arguments: {} });
    const p = policies.structuredContent as { policies: { name: string }[]; hiddenOutsideScope: boolean };
    expect(p.policies.map((x) => x.name)).toEqual(['alpha-policy']);
    expect(p.hiddenOutsideScope).toBe(true);
    const conditions = await client.callTool({ name: 'list_alert_conditions', arguments: {} });
    const c = conditions.structuredContent as { conditions: { name: string }[]; hiddenOutsideScope: boolean };
    expect(c.conditions.map((x) => x.name)).toEqual(['alpha-condition']);
    expect(c.hiddenOutsideScope).toBe(true);
    expect(JSON.stringify([policies, conditions])).not.toContain(LEAK);
  });

  it('issue tools drop rows that touch other accounts and say so', async () => {
    const client = await isoClient();
    const issues = await client.callTool({ name: 'list_recent_issues', arguments: {} });
    const i = issues.structuredContent as { issues: { title: string }[]; hiddenOutsideScope: boolean };
    expect(i.issues.map((x) => x.title)).toEqual(['alpha-issue']);
    expect(i.hiddenOutsideScope).toBe(true);
    const incidents = await client.callTool({ name: 'search_incidents', arguments: {} });
    const n = incidents.structuredContent as { incidents: { title: string }[]; hiddenOutsideScope: boolean };
    expect(n.incidents.map((x) => x.title)).toEqual(['alpha-incident']);
    expect(n.hiddenOutsideScope).toBe(true);
    expect(JSON.stringify([issues, incidents])).not.toContain(LEAK);
  });

  it('error groups of other accounts or without a verifiable entity are dropped and flagged', async () => {
    const client = await isoClient();
    const r = await client.callTool({ name: 'list_error_groups', arguments: {} });
    const s = r.structuredContent as { errorGroups: { name: string }[]; hiddenOutsideScope: boolean };
    expect(s.errorGroups.map((x) => x.name)).toEqual(['alpha-error']);
    expect(s.hiddenOutsideScope).toBe(true);
    expect(JSON.stringify(r)).not.toContain(LEAK);
  });

  it('change events of other accounts or without a verifiable entity are dropped and flagged', async () => {
    const client = await isoClient();
    const r = await client.callTool({ name: 'list_change_events', arguments: {} });
    const s = r.structuredContent as { events: { id: string }[]; hiddenOutsideScope: boolean };
    expect(s.events.map((x) => x.id)).toEqual(['alpha-change']);
    expect(s.hiddenOutsideScope).toBe(true);
    expect(JSON.stringify(r)).not.toContain(LEAK);
  });

  it('list tools return only allowed accounts and entities, and say what was left out', async () => {
    const client = await isoClient();
    const accounts = await client.callTool({ name: 'list_accounts', arguments: {} });
    expect((accounts.structuredContent as { accounts: { id: number }[] }).accounts.map((a) => a.id)).toEqual([
      1, 2,
    ]);
    const search = await client.callTool({ name: 'search_entities', arguments: {} });
    const rows = (search.structuredContent as { entities: { accountId: number; name: string }[] }).entities;
    expect(rows.map((r) => r.name)).toEqual(['alpha-entity-1', 'alpha-entity-2']);
    expect(JSON.stringify(search.content)).toContain('left out');
    const related = await client.callTool({ name: 'get_related_entities', arguments: { guid: guidOf(1) } });
    const rel = related.structuredContent as { related: { name: string }[]; hiddenOutsideScope: boolean };
    expect(rel.related.map((r) => r.name)).toEqual(['alpha-rel']);
    expect(rel.hiddenOutsideScope).toBe(true);
  });
});

describe('ungranted tools', () => {
  it('a tool outside the grant is not listed, not callable, reaches nothing and is audited', async () => {
    for (const tool of CATALOG) {
      const grantId = await h.addGrant(h.world.projectIds.prod, { tools: CATALOG.filter((t) => t !== tool) });
      const token = await h.addToken(grantId);
      const client = await connect(h.app, 'prod', token.value, 'modern');
      clients.push(client);
      const listed = (await client.listTools()).tools.map((t) => t.name);
      expect(listed, tool).not.toContain(tool);
      const before = h.nerdGraph.calls.length;
      // A legacy-shaped call without the Mcp-Name header: the body decides (P2-12 fix).
      const res = await h.send(
        new Request('http://localhost/p/prod/mcp', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token.value}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2025-11-25',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: tool, arguments: (TOOL_CASES[tool]?.[0]?.args ?? {}) as Record<string, unknown> },
          }),
        }),
      );
      expect(res.text, tool).toContain(`Tool ${tool} not found`);
      expect(h.nerdGraph.calls.length, tool).toBe(before);
    }
    await vi.waitFor(async () => {
      const rows = await h.world.storage.auditLog.list({ action: 'tool.not_granted', limit: 1000 });
      expect(rows.map((r) => (r.details as { tool: string }).tool).sort()).toEqual([...CATALOG].sort());
    });
  });
});

describe('guard: every tool has an isolation case', () => {
  it('fails when a tool is added to the catalog without a case here, or a case names a gone tool', () => {
    expect(Object.keys(TOOL_CASES).sort()).toEqual([...CATALOG].sort());
  });
});
