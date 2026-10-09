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
import { bindingOf, ERROR_META_KEY, ErrorCode, encodePageCursor } from '@relic-bridge/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG, connect, NR_KEY } from '../fixtures.ts';
import { accountsNamed, createHarness, FOREIGN, guidOf, type Harness, HONEST_ID, LEAK } from './harness.ts';

/** `ok`: answered; `refused`: RB_AUTH_FORBIDDEN; `invalid`: RB_INPUT_INVALID (ambiguous, unknown or out-of-scope name). `offline`: must not reach NerdGraph at all. */
interface ToolCall {
  readonly args: Record<string, unknown>;
  readonly expect: 'ok' | 'refused' | 'invalid';
  readonly offline?: boolean;
}

const NRQL = 'SELECT count(*) FROM Transaction SINCE 1 hour ago';
const ALLOWED = [1, 2] as const;
/** An entity this NerdGraph answers honestly: the only way to reach the success path of the composite tools. */
const honest = (account: number, domain = 'APM', type = 'APPLICATION') =>
  guidOf(account, HONEST_ID, domain, type);

const GUID_CASES: Readonly<Record<string, readonly ToolCall[]>> = {
  whoami: [{ args: {}, expect: 'ok' }],
  list_accounts: [{ args: {}, expect: 'ok' }],
  time_range: [{ args: { expression: 'last 2 hours' }, expect: 'ok', offline: true }],
  get_ui_link: [
    { args: { entity_guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(3) }, expect: 'refused', offline: true },
    { args: { nrql: NRQL, account: FOREIGN }, expect: 'refused', offline: true },
    { args: { nrql: NRQL, account: 3 }, expect: 'refused', offline: true },
    {
      args: { issue_id: '3f1c2a52-0000-4000-8000-000000000001', account: FOREIGN },
      expect: 'refused',
      offline: true,
    },
    { args: { entity_guid: guidOf(1) }, expect: 'ok', offline: true },
    { args: { nrql: NRQL }, expect: 'ok', offline: true },
  ],
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
  resolve_entity: [
    { args: { query: 'x', account: FOREIGN }, expect: 'refused', offline: true },
    { args: { query: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    { args: { query: 'x' }, expect: 'ok' },
    { args: { query: 'x', account: 2 }, expect: 'ok' },
  ],
  list_entity_types: [
    { args: { account: FOREIGN }, expect: 'refused', offline: true },
    { args: {}, expect: 'ok' },
  ],
  list_alert_policies: [
    { args: { account: FOREIGN }, expect: 'refused', offline: true },
    { args: { account: 3 }, expect: 'refused', offline: true }, // reachable by the key, not allowed
    { args: {}, expect: 'ok' },
    { args: { account: 2, name_contains: 'x' }, expect: 'ok' },
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
    { args: { entity_guid: honest(1) }, expect: 'ok' },
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
  list_synthetic_monitors: [
    { args: { account: FOREIGN }, expect: 'refused', offline: true },
    { args: { account: 3 }, expect: 'refused', offline: true },
    { args: { account: 1, name_contains: "a'b" }, expect: 'ok' },
  ],
  list_dashboards: [
    { args: { account: FOREIGN }, expect: 'refused', offline: true },
    { args: { account: 3 }, expect: 'refused', offline: true },
    { args: { account: 1, name_contains: "a'b" }, expect: 'ok' },
  ],
  get_dashboard: [
    { args: { entity_guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(FOREIGN, 'x', 'VIZ', 'DASHBOARD') }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(3, 'x', 'VIZ', 'DASHBOARD') }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(1) }, expect: 'refused' },
    { args: { entity_guid: honest(1, 'VIZ', 'DASHBOARD') }, expect: 'ok' },
  ],
  generate_alert_insights_report: [
    { args: { issue_id: 'issue-alpha-issue', account: FOREIGN }, expect: 'refused', offline: true },
    { args: { issue_id: 'issue-alpha-issue', account: 3 }, expect: 'refused', offline: true },
    // Issues that name a foreign account, or an entity GUID in one, are refused, never trimmed.
    { args: { issue_id: `issue-${LEAK}-issue-shared`, account: 1 }, expect: 'refused' },
    { args: { issue_id: `issue-${LEAK}-issue-forged`, account: 1 }, expect: 'refused' },
    // NerdGraph answers the entity lookup with an entity in the foreign account: the whole report fails closed.
    { args: { issue_id: 'issue-alpha-issue', account: 1 }, expect: 'refused' },
    { args: { issue_id: 'issue-alpha-issue', account: 2, sections: ['errors', 'related'] }, expect: 'ok' },
  ],
  generate_user_impact_report: [
    { args: { entity_guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(3) }, expect: 'refused', offline: true },
    { args: { issue_id: 'issue-alpha-issue', account: FOREIGN }, expect: 'refused', offline: true },
    { args: { issue_id: `issue-${LEAK}-issue-shared`, account: 1 }, expect: 'refused' },
    { args: { entity_guid: guidOf(1, '42', 'BROWSER', 'APPLICATION') }, expect: 'ok' },
    { args: { entity_guid: guidOf(1) }, expect: 'ok' },
    { args: { issue_id: 'issue-alpha-issue', account: 2 }, expect: 'ok' },
  ],
  trace_error: [
    { args: { trace_id: 'abcdef0123456789', account: FOREIGN }, expect: 'refused', offline: true },
    { args: { trace_id: 'abcdef0123456789', account: 3 }, expect: 'refused', offline: true },
    { args: { error_group_id: 'eg-1', entity_guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    { args: { error_group_id: 'eg-1', entity_guid: guidOf(3) }, expect: 'refused', offline: true },
    { args: { trace_id: 'abcdef0123456789', account: 1 }, expect: 'ok' },
  ],
  dependency_health: [
    { args: { entity_guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(3) }, expect: 'refused', offline: true },
    // NerdGraph answers the entity's own golden metrics with an entity in the foreign account: fails closed.
    { args: { entity_guid: guidOf(1) }, expect: 'refused' },
    { args: { entity_guid: honest(1) }, expect: 'ok' },
  ],
  entity_health: [
    { args: { entity_guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(3) }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(1) }, expect: 'refused' },
    { args: { entity_guid: honest(1) }, expect: 'ok' },
  ],
  get_entity: [
    { args: { entity_guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    // NerdGraph answers with an entity in the foreign account behind an allowed account's GUID.
    { args: { entity_guid: guidOf(1) }, expect: 'refused' },
    // Name path (P6-17): an unavailable account is refused offline; the resolver never picks among several matches,
    // never resolves into an account outside the grant, and what it resolves is still checked against NerdGraph.
    { args: { name: 'entity', account: FOREIGN }, expect: 'refused', offline: true },
    { args: { name: 'entity', account: 3 }, expect: 'refused', offline: true },
    { args: { name: 'entity' }, expect: 'invalid' }, // matches accounts 1 and 2: ambiguous
    { args: { name: 'entity-3' }, expect: 'invalid' }, // only in account 3 (not allowed): not found
    { args: { name: 'entity-1' }, expect: 'refused' },
    { args: { name: 'entity-1', entity_guid: guidOf(1) }, expect: 'invalid' },
    { args: {}, expect: 'invalid' },
  ],
  get_related_entities: [
    { args: { entity_guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(1) }, expect: 'ok' },
    // Name path (P6-17): an unavailable account is refused offline; the resolver never picks among several matches,
    // never resolves into an account outside the grant, and what it resolves is still checked against NerdGraph.
    { args: { name: 'entity', account: FOREIGN }, expect: 'refused', offline: true },
    { args: { name: 'entity', account: 3 }, expect: 'refused', offline: true },
    { args: { name: 'entity' }, expect: 'invalid' }, // matches accounts 1 and 2: ambiguous
    { args: { name: 'entity-3' }, expect: 'invalid' }, // only in account 3 (not allowed): not found
    { args: { name: 'entity-1' }, expect: 'ok' },
    { args: { name: 'entity-1', entity_guid: guidOf(1) }, expect: 'invalid' },
    { args: {}, expect: 'invalid' },
  ],
  get_golden_metrics: [
    { args: { entity_guid: guidOf(FOREIGN) }, expect: 'refused', offline: true },
    { args: { entity_guid: guidOf(1) }, expect: 'refused' },
    // Name path (P6-17): an unavailable account is refused offline; the resolver never picks among several matches,
    // never resolves into an account outside the grant, and what it resolves is still checked against NerdGraph.
    { args: { name: 'entity', account: FOREIGN }, expect: 'refused', offline: true },
    { args: { name: 'entity', account: 3 }, expect: 'refused', offline: true },
    { args: { name: 'entity' }, expect: 'invalid' }, // matches accounts 1 and 2: ambiguous
    { args: { name: 'entity-3' }, expect: 'invalid' }, // only in account 3 (not allowed): not found
    { args: { name: 'entity-1' }, expect: 'refused' },
    { args: { name: 'entity-1', entity_guid: guidOf(1) }, expect: 'invalid' },
    { args: {}, expect: 'invalid' },
  ],
  // Offline decoding of the caller's own input: says the account is not available, fetches nothing.
  decode_entity_guid: [{ args: { entity_guid: guidOf(FOREIGN) }, expect: 'ok', offline: true }],
};

/**
 * Name path (P6-17, P6-18), the same for every tool that takes an entity: an unavailable account is refused offline;
 * the resolver never picks among several matches, never resolves into an account outside the grant, and what it
 * resolves is still checked like the guid. `resolved` is what `entity-1` (account 1) ends in for that tool.
 */
const NAME_TOOLS: Readonly<
  Record<string, { field: string; resolved: ToolCall['expect']; optional?: boolean }>
> = {
  list_top_transactions: { field: 'entity_guid', resolved: 'ok' },
  analyze_transactions: { field: 'entity_guid', resolved: 'ok' },
  analyze_threads: { field: 'entity_guid', resolved: 'ok' },
  list_gc_metrics: { field: 'entity_guid', resolved: 'ok' },
  analyze_deployment_impact: { field: 'entity_guid', resolved: 'refused' },
  analyze_entity_logs: { field: 'entity_guid', resolved: 'ok' },
  list_recent_logs: { field: 'entity_guid', resolved: 'ok', optional: true },
  list_error_groups: { field: 'entity_guid', resolved: 'ok', optional: true },
  list_change_events: { field: 'entity_guid', resolved: 'refused', optional: true },
  list_recent_issues: { field: 'entity_guid', resolved: 'ok', optional: true },
  search_incidents: { field: 'entity_guid', resolved: 'ok', optional: true },
  get_dashboard: { field: 'entity_guid', resolved: 'refused' },
  dependency_health: { field: 'entity_guid', resolved: 'refused' },
  entity_health: { field: 'entity_guid', resolved: 'refused' },
  generate_user_impact_report: { field: 'entity_guid', resolved: 'ok', optional: true },
};

function nameCases(tool: string, o: { field: string; resolved: ToolCall['expect']; optional?: boolean }) {
  const cases: ToolCall[] = [
    { args: { name: 'entity', account: FOREIGN }, expect: 'refused', offline: true },
    { args: { name: 'entity', account: 3 }, expect: 'refused', offline: true },
    { args: { name: 'entity' }, expect: 'invalid' }, // matches accounts 1 and 2: ambiguous
    { args: { name: 'entity-3' }, expect: 'invalid' }, // only in account 3 (not allowed): not found
    { args: { name: 'entity-1' }, expect: o.resolved },
    { args: { name: 'entity-1', [o.field]: guidOf(1) }, expect: 'invalid' },
  ];
  if (!o.optional) cases.push({ args: {}, expect: 'invalid' });
  return [...(GUID_CASES[tool] ?? []), ...cases];
}

export const TOOL_CASES: Readonly<Record<string, readonly ToolCall[]>> = {
  ...GUID_CASES,
  ...Object.fromEntries(Object.entries(NAME_TOOLS).map(([t, o]) => [t, nameCases(t, o)])),
  trace_error: [
    ...(GUID_CASES['trace_error'] ?? []),
    // A name needs an error group to scope: refused before any lookup.
    { args: { name: 'entity-1' }, expect: 'invalid' },
    { args: { name: 'entity', error_group_id: 'eg-1' }, expect: 'invalid' },
    { args: { name: 'entity-3', error_group_id: 'eg-1' }, expect: 'invalid' },
    { args: { name: 'entity-1', entity_guid: guidOf(1), error_group_id: 'eg-1' }, expect: 'invalid' },
  ],
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
        } else if (call.expect === 'invalid') {
          expect(result.isError, what).toBe(true);
          // Schema-level rejections (guid and name, neither) carry no tool error code.
          if (code !== undefined) expect(code, what).toBe(ErrorCode.InputInvalid);
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

  // P6-24: a cursor is client input. It is bound to the tool, the account and the filters of the call that is
  // resumed, so it cannot be replayed on another account, another tool or a different filter set, and a bare upstream
  // (NerdGraph) cursor is refused instead of being handed to NerdGraph.
  describe('cursors cannot be forged into another account, tool or filter set', () => {
    const PAGED_TOOLS = [
      'search_entities',
      'list_entity_types',
      'list_event_types',
      'list_accounts',
      'list_alert_policies',
      'list_alert_conditions',
      'list_recent_issues',
      'search_incidents',
      'list_error_groups',
      'list_change_events',
      'list_recent_logs',
      'list_synthetic_monitors',
      'list_dashboards',
    ] as const;

    it('refuses a bare upstream cursor and a cursor minted for another binding, on every paged tool', async () => {
      const client = await isoClient();
      for (const tool of PAGED_TOOLS) {
        const foreign = encodePageCursor(await bindingOf('other_tool', 2, 'x'), { u: 'abc', o: 0 });
        for (const cursor of ['NEXT_PAGE_FROM_ANOTHER_ACCOUNT', foreign, 'not base64 at all!']) {
          const args = tool === 'list_accounts' ? { cursor } : { account: 1, cursor };
          const r = await client.callTool({ name: tool, arguments: args });
          const code = (r._meta?.[ERROR_META_KEY] as { code?: string } | undefined)?.code;
          expect(r.isError, `${tool} with ${cursor.slice(0, 20)}`).toBe(true);
          // Our own refusal, not a schema error about some other argument.
          expect(code, `${tool} with ${cursor.slice(0, 20)}`).toBe(ErrorCode.InputInvalid);
        }
      }
    });

    it('a cursor minted for account 1 works there and is refused on account 2 and with other filters', async () => {
      const client = await isoClient();
      const mint = async (account: number, filter?: string) =>
        encodePageCursor(await bindingOf('list_alert_policies', account, filter), { u: 'abc', o: 0 });
      const call = (args: Record<string, unknown>) =>
        client.callTool({ name: 'list_alert_policies', arguments: args });
      const before = h.nerdGraph.calls.length;
      expect((await call({ account: 1, cursor: await mint(1) })).isError ?? false).toBe(false);
      expect(h.nerdGraph.calls.length).toBeGreaterThan(before);
      const mid = h.nerdGraph.calls.length;
      const onOtherAccount = await call({ account: 2, cursor: await mint(1) });
      const withOtherFilter = await call({ account: 1, name_contains: 'x', cursor: await mint(1) });
      for (const r of [onOtherAccount, withOtherFilter]) {
        expect(r.isError).toBe(true);
        expect((r._meta?.[ERROR_META_KEY] as { code?: string } | undefined)?.code).toBe(
          ErrorCode.InputInvalid,
        );
      }
      expect(h.nerdGraph.calls.length, 'refused before any NerdGraph call').toBe(mid);
    });

    it('a time cursor cannot widen the window past the connection limit', async () => {
      const client = await isoClient();
      const now = Date.now();
      const cursor = encodePageCursor(
        await bindingOf('list_recent_logs', 1, undefined, undefined, undefined),
        {
          t: now,
          k: 0,
          s: now - 400 * 86_400_000,
        },
      );
      const before = h.nerdGraph.calls.length;
      const r = await client.callTool({ name: 'list_recent_logs', arguments: { account: 1, cursor } });
      expect(r.isError).toBe(true);
      expect(h.nerdGraph.calls.length).toBe(before);
    });
  });

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

  it('monitors and dashboards of other accounts or with a forged GUID are dropped and flagged', async () => {
    const client = await isoClient();
    const monitors = await client.callTool({
      name: 'list_synthetic_monitors',
      arguments: { account: 1 },
    });
    const m = monitors.structuredContent as { monitors: { name: string }[]; hiddenOutsideScope: boolean };
    expect(m.monitors.map((x) => x.name)).toEqual(['alpha-monitor-1']);
    expect(m.hiddenOutsideScope).toBe(true);
    const dashboards = await client.callTool({ name: 'list_dashboards', arguments: { account: 1 } });
    const d = dashboards.structuredContent as { dashboards: { name: string }[]; hiddenOutsideScope: boolean };
    expect(d.dashboards.map((x) => x.name)).toEqual(['alpha-dash-1']);
    expect(d.hiddenOutsideScope).toBe(true);
    expect(JSON.stringify([monitors, dashboards])).not.toContain(LEAK);
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
    const related = await client.callTool({
      name: 'get_related_entities',
      arguments: { entity_guid: guidOf(1) },
    });
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

describe('prompts follow the grant (P6-11)', () => {
  const promptText = (r: { messages: { content: { type: string; text?: string } }[] }) =>
    r.messages[0]?.content.text ?? '';

  it('lists only prompts whose tools the grant allows, and leaves out steps naming other tools', async () => {
    const grantId = await h.addGrant(h.world.projectIds.prod, { tools: ['whoami', 'list_recent_issues'] });
    const token = await h.addToken(grantId);
    const client = await connect(h.app, 'prod', token.value, 'modern');
    clients.push(client);
    const before = h.nerdGraph.calls.length;
    const listed = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(listed).toEqual(['investigate_incident', 'triage_alerts']);
    const got = await client.getPrompt({ name: 'investigate_incident', arguments: { issue_id: 'i-1' } });
    expect(promptText(got as never)).toContain('`list_recent_issues`');
    expect(promptText(got as never)).not.toMatch(
      /run_nrql|generate_alert_insights_report|get_related_entities/,
    );
    // not listed means not callable
    await expect(client.getPrompt({ name: 'investigate_kubernetes_pods', arguments: {} })).rejects.toThrow();
    // prompts are text: they never reach New Relic
    expect(h.nerdGraph.calls.length).toBe(before);
  });

  it('a grant without any investigation tool lists no prompts', async () => {
    const grantId = await h.addGrant(h.world.projectIds.prod, { tools: ['whoami', 'time_range'] });
    const token = await h.addToken(grantId);
    const client = await connect(h.app, 'prod', token.value, 'modern');
    clients.push(client);
    expect((await client.listPrompts()).prompts).toEqual([]);
  });
});

describe('resources follow the grant (P6-12)', () => {
  const bodyOf = (r: { contents: { text?: string }[] }) => r.contents.map((c) => c.text ?? '').join('\n');

  it('lists only the effective accounts and reads nothing from others, without a New Relic call', async () => {
    const grantId = await h.addGrant(h.world.projectIds.prod, {
      tools: ['whoami', 'run_nrql', 'list_event_types', 'get_attributes'],
    });
    const token = await h.addToken(grantId);
    const client = await connect(h.app, 'prod', token.value, 'modern');
    clients.push(client);
    const before = h.nerdGraph.calls.length;
    const uris = (await client.listResources()).resources.map((r) => r.uri).sort();
    expect(uris).toEqual([
      'relic://accounts/1/event-types',
      'relic://accounts/2/event-types',
      'relic://nrql/reference',
    ]);
    for (const account of [3, FOREIGN]) {
      await expect(client.readResource({ uri: `relic://accounts/${account}/event-types` })).rejects.toThrow(
        /RB_AUTH_FORBIDDEN/,
      );
      await expect(
        client.readResource({ uri: `relic://accounts/${account}/event-types/Transaction/attributes` }),
      ).rejects.toThrow(/RB_AUTH_FORBIDDEN/);
    }
    expect(bodyOf((await client.readResource({ uri: 'relic://nrql/reference' })) as never)).toContain('NRQL');
    expect(h.nerdGraph.calls.length).toBe(before);
    // an allowed account goes through the tool path and only names allowed accounts
    await client.readResource({ uri: 'relic://accounts/1/event-types' });
    for (const c of h.nerdGraph.calls.slice(before)) {
      for (const account of accountsNamed(c)) expect(ALLOWED).toContain(account);
    }
  });

  it('a grant without the tools sees no resources', async () => {
    const grantId = await h.addGrant(h.world.projectIds.prod, { tools: ['whoami', 'time_range'] });
    const token = await h.addToken(grantId);
    const client = await connect(h.app, 'prod', token.value, 'modern');
    clients.push(client);
    expect((await client.listResources()).resources).toEqual([]);
    await expect(client.readResource({ uri: 'relic://accounts/1/event-types' })).rejects.toThrow();
    await expect(client.readResource({ uri: 'relic://nrql/reference' })).rejects.toThrow();
  });

  it('a grant with only get_attributes sees the attributes template but lists no account', async () => {
    const grantId = await h.addGrant(h.world.projectIds.prod, { tools: ['get_attributes'] });
    const token = await h.addToken(grantId);
    const client = await connect(h.app, 'prod', token.value, 'modern');
    clients.push(client);
    expect((await client.listResources()).resources).toEqual([]);
    await expect(client.readResource({ uri: 'relic://accounts/1/event-types' })).rejects.toThrow();
  });
});
