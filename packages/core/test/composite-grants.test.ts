// SPDX-License-Identifier: Apache-2.0
// Phase 6 review: a composite's grant does not imply the tools it is built from (THREAT_MODEL T3). A connection granted
// only `entity_health` must not read error groups, issues or deployments through it.
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { compositeSiblings, createBudget, createBuiltinTools, siblingWarnings } from '../src/index.ts';
import investigationsSource from '../src/tools/investigations.ts?raw';
import reportsSource from '../src/tools/reports.ts?raw';
import { testContext } from './helpers/context.ts';
import { connectInMemory, resultText } from './helpers/mcp.ts';
import { MOCK_ACCOUNT, MOCK_GUID, mockNerdGraph } from './helpers/mock-nerdgraph.ts';

let clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

async function connect(allowedTools: readonly string[]) {
  const mock = mockNerdGraph();
  const tools = createBuiltinTools({ fetch: mock.fetch, sleep: async () => {} }).filter((t) =>
    allowedTools.includes(t.name),
  );
  const client = await connectInMemory(tools, () =>
    testContext({
      accounts: { allowed: [MOCK_ACCOUNT], default: MOCK_ACCOUNT },
      budget: createBudget(50),
      clock: { now: () => 1790943448000 },
      connection: { allowedTools },
    }),
  );
  clients.push(client);
  return { client, mock };
}

const sent = (calls: { body: { query: string; variables: Record<string, unknown> } }[]) =>
  calls.map((c) => `${c.body.query}\n${String(c.body.variables['nrql'] ?? '')}`).join('\n');

describe('composite tools respect per-tool grants', () => {
  it('entity_health alone runs no section whose tool is not granted', async () => {
    const { client, mock } = await connect(['entity_health']);
    const r = await client.callTool({ name: 'entity_health', arguments: { entity_guid: MOCK_GUID } });
    expect(r.isError, resultText(r)).toBeFalsy();
    const s = r.structuredContent as { sections: { name: string; status: string; note: string | null }[] };
    for (const section of s.sections) {
      expect(section.status, section.name).toBe('skipped');
      expect(section.note, section.name).toContain('not granted');
    }
    expect(mock.calls).toHaveLength(0);
  });

  it('entity_health with list_error_groups granted runs only that section', async () => {
    const { client, mock } = await connect(['entity_health', 'list_error_groups']);
    const r = await client.callTool({ name: 'entity_health', arguments: { entity_guid: MOCK_GUID } });
    const s = r.structuredContent as { sections: { name: string; status: string }[] };
    expect(s.sections.filter((x) => x.status !== 'skipped').map((x) => x.name)).toEqual(['errors']);
    expect(sent(mock.calls)).not.toMatch(/aiIssues|changeTracking|deploymentSearch|goldenMetrics/);
  });

  it('generate_alert_insights_report does not read logs, errors or changes without their grants', async () => {
    const { client, mock } = await connect(['generate_alert_insights_report', 'get_entity']);
    const r = await client.callTool({
      name: 'generate_alert_insights_report',
      arguments: { issue_id: 'issue-1' },
    });
    expect(r.isError, resultText(r)).toBeFalsy();
    const s = r.structuredContent as { sections: { name: string; status: string }[] };
    for (const section of s.sections.filter((x) => x.name !== 'entity')) {
      expect(section.status, section.name).toBe('skipped');
    }
    const text = sent(mock.calls);
    expect(text).not.toMatch(/FROM Log|errorsInbox|changeTracking|relatedEntities/);
  });

  it('dependency_health without get_related_entities refuses before any request', async () => {
    const { client, mock } = await connect(['dependency_health']);
    const r = await client.callTool({ name: 'dependency_health', arguments: { entity_guid: MOCK_GUID } });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('RB_TOOL_DISABLED');
    expect(mock.calls).toHaveLength(0);
  });

  it('without a per-tool grant (library use) every section runs as before', async () => {
    const mock = mockNerdGraph();
    const tools = createBuiltinTools({ fetch: mock.fetch, sleep: async () => {} });
    const client = await connectInMemory(tools, () =>
      testContext({
        accounts: { allowed: [MOCK_ACCOUNT], default: MOCK_ACCOUNT },
        budget: createBudget(50),
        clock: { now: () => 1790943448000 },
      }),
    );
    clients.push(client);
    const r = await client.callTool({ name: 'entity_health', arguments: { entity_guid: MOCK_GUID } });
    const s = r.structuredContent as { sections: { status: string }[] };
    expect(s.sections.some((x) => x.status === 'ok')).toBe(true);
  });
});

// P6-25: the siblings a composite declares (`siblingTools`) are what the admin UI and `POST /grants` warn about, so they
// must match the tools the composite really calls through `grantedSibling`.
describe('composite sibling metadata', () => {
  const all = createBuiltinTools({ fetch: async () => new Response('{}') });
  const names = new Set(all.map((t) => t.name));
  const composites = all.filter((t) => t.siblingTools !== undefined);
  const source = (file: string) => (file === 'reports.ts' ? reportsSource : investigationsSource);

  it('declares siblings for the composites that call sibling tools, all of them real read tools', () => {
    expect(composites.map((t) => t.name).sort()).toEqual([
      'dependency_health',
      'entity_health',
      'generate_alert_insights_report',
      'generate_user_impact_report',
    ]);
    for (const c of composites) {
      for (const sibling of c.siblingTools ?? []) {
        expect(names.has(sibling), `${c.name} -> ${sibling}`).toBe(true);
        expect(all.find((t) => t.name === sibling)?.kind).toBe('read');
        expect(c.siblingTools).not.toContain(c.name);
      }
    }
    expect(Object.keys(compositeSiblings(all)).sort()).toEqual(composites.map((t) => t.name).sort());
  });

  it.each([
    ['reports.ts', ['generate_alert_insights_report', 'generate_user_impact_report']],
    ['investigations.ts', ['trace_error', 'dependency_health', 'entity_health']],
  ])('%s: the declared siblings are the tools the file calls', (file, own) => {
    const text = source(file);
    const used = [...names].filter((n) => !own.includes(n) && new RegExp(`'${n}'`).test(text)).sort();
    const declared = [
      ...new Set(own.flatMap((n) => all.find((t) => t.name === n)?.siblingTools ?? [])),
    ].sort();
    expect(declared).toEqual(used);
  });

  it('a composite run without its siblings refuses only declared ones', async () => {
    for (const name of ['entity_health', 'generate_alert_insights_report']) {
      const { client } = await connect([name]);
      const args = name === 'entity_health' ? { entity_guid: MOCK_GUID } : { issue_id: 'issue-1' };
      const r = await client.callTool({ name, arguments: args });
      const declared = all.find((t) => t.name === name)?.siblingTools ?? [];
      const refused = [...resultText(r).matchAll(/not granted (\w+)/g)].map((m) => m[1] as string);
      for (const tool of refused) expect(declared, `${name} refused ${tool}`).toContain(tool);
    }
  });

  it('warns for a composite named without its siblings, and for none once they are granted', () => {
    const map = compositeSiblings(all);
    const w = siblingWarnings(map, ['dependency_health', 'get_golden_metrics']);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('dependency_health');
    expect(w[0]).toContain('get_related_entities');
    expect(w[0]).not.toContain('get_golden_metrics,');
    expect(siblingWarnings(map, ['dependency_health', 'get_golden_metrics', 'get_related_entities'])).toEqual(
      [],
    );
    expect(siblingWarnings(map, null)).toEqual([]);
    expect(siblingWarnings(map, ['trace_error', 'run_nrql'])).toEqual([]);
  });
});
