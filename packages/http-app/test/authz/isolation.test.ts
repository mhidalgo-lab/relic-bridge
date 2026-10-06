// SPDX-License-Identifier: Apache-2.0
// Tenant isolation (P2-12, THREAT_MODEL T21/T16): caches inside the tool set never hand one credential's or account
// set's data to another and re-check limits on a hit; concurrent requests of two tenants with different keys never
// mix (each NerdGraph call carries its tenant's key, each answer only its tenant's data); the MCP server is built per
// request, so interleaved callers with different grants each see their own tools.
import type { Client } from '@modelcontextprotocol/client';
import { ERROR_META_KEY } from '@relic-bridge/core';
import type { StoredLimits } from '@relic-bridge/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATALOG, connect, NR_KEY } from '../fixtures.ts';
import { accountsNamed, createHarness, type Harness, LEAK, NR_KEY_B } from './harness.ts';

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

async function tenantClient(
  slug: string,
  opts: { key?: string; allowed?: number[]; limits?: StoredLimits; credentialId?: string } = {},
): Promise<{ client: Client; credentialId: string }> {
  const credentialId =
    opts.credentialId ??
    (await h.addCredential({ key: opts.key ?? NR_KEY, reachable: [...(opts.allowed ?? [1, 2]), 999] }));
  const projectId = await h.addProject(slug, {
    credentialId,
    allowed: opts.allowed ?? [1, 2],
    ...(opts.limits ? { limits: opts.limits } : {}),
  });
  const token = await h.addToken(await h.addGrant(projectId));
  const client = await connect(h.app, slug, token.value, 'modern');
  clients.push(client);
  return { client, credentialId };
}

const textOf = (r: Awaited<ReturnType<Client['callTool']>>): string => JSON.stringify(r);

describe('caches never cross credentials, account sets or limits', () => {
  it('list_event_types, get_attributes and list_entity_types: a second credential gets its own data', async () => {
    const a = await tenantClient('cache-a', { key: NR_KEY });
    const b = await tenantClient('cache-b', { key: NR_KEY_B });
    const cases: [string, Record<string, unknown>, (label: string) => string][] = [
      ['list_event_types', {}, (l) => `${l}Event`],
      ['get_attributes', { event_type: 'Transaction' }, (l) => `${l}_attr`],
      ['list_entity_types', {}, (l) => l.toUpperCase()],
    ];
    for (const [tool, args, marker] of cases) {
      const first = textOf(await a.client.callTool({ name: tool, arguments: args }));
      expect(first, tool).toContain(marker('alpha'));
      // Same tool, same arguments, same account ids, another credential: never the cached answer.
      const before = h.nerdGraph.calls.length;
      const second = textOf(await b.client.callTool({ name: tool, arguments: args }));
      expect(second, tool).toContain(marker('beta'));
      expect(second, tool).not.toContain(marker('alpha'));
      const made = h.nerdGraph.calls.slice(before);
      expect(made.length, `${tool} must ask NerdGraph with the second key`).toBeGreaterThan(0);
      expect(made.every((c) => c.apiKey === NR_KEY_B)).toBe(true);
      // And the first tenant still gets its own (now cached) answer.
      expect(textOf(await a.client.callTool({ name: tool, arguments: args })), tool).toContain(
        marker('alpha'),
      );
    }
  });

  it('list_entity_types: the same credential with another account set asks again for its own accounts', async () => {
    const credentialId = await h.addCredential({ reachable: [1, 2, 3] });
    const one = await tenantClient('acct-one', { allowed: [1], credentialId });
    const both = await tenantClient('acct-both', { allowed: [1, 2], credentialId });
    await one.client.callTool({ name: 'list_entity_types', arguments: {} });
    const before = h.nerdGraph.calls.length;
    await both.client.callTool({ name: 'list_entity_types', arguments: {} });
    const made = h.nerdGraph.calls.slice(before);
    expect(made.map((c) => accountsNamed(c))).toEqual([[1, 2]]);
    // The narrower project never asked about account 2.
    expect(
      h.nerdGraph.calls
        .slice(0, before)
        .flatMap((c) => accountsNamed(c))
        .every((a) => a === 1),
    ).toBe(true);
  });

  it('resolve_entity: another credential or a narrower account set never reuses a cached lookup', async () => {
    const a = await tenantClient('res-a', { key: NR_KEY });
    const b = await tenantClient('res-b', { key: NR_KEY_B });
    await a.client.callTool({ name: 'resolve_entity', arguments: { query: 'checkout' } });
    const before = h.nerdGraph.calls.length;
    await b.client.callTool({ name: 'resolve_entity', arguments: { query: 'checkout' } });
    const made = h.nerdGraph.calls.slice(before);
    expect(made.length).toBeGreaterThan(0);
    expect(made.every((c) => c.apiKey === NR_KEY_B)).toBe(true);

    const credentialId = await h.addCredential({ reachable: [1, 2, 3] });
    const both = await tenantClient('res-both', { allowed: [1, 2], credentialId });
    const one = await tenantClient('res-one', { allowed: [1], credentialId });
    await both.client.callTool({ name: 'resolve_entity', arguments: { query: 'checkout' } });
    const mark = h.nerdGraph.calls.length;
    await one.client.callTool({ name: 'resolve_entity', arguments: { query: 'checkout' } });
    const asked = h.nerdGraph.calls.slice(mark);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.flatMap((c) => accountsNamed(c)).every((acct) => acct === 1)).toBe(true);
  });

  it('event-type limits are re-checked on a cache hit', async () => {
    const open = await tenantClient('limits-open');
    const closed = await tenantClient('limits-closed', {
      credentialId: open.credentialId,
      limits: { eventTypes: { deny: ['Transaction'] } },
    });
    expect(textOf(await open.client.callTool({ name: 'list_event_types', arguments: {} }))).toContain(
      'Transaction',
    );
    expect(
      textOf(
        await open.client.callTool({ name: 'get_attributes', arguments: { event_type: 'Transaction' } }),
      ),
    ).toContain('alpha_attr');
    const before = h.nerdGraph.calls.length;
    const types = await closed.client.callTool({ name: 'list_event_types', arguments: {} });
    expect((types.structuredContent as { eventTypes: string[] }).eventTypes).not.toContain('Transaction');
    const attrs = await closed.client.callTool({
      name: 'get_attributes',
      arguments: { event_type: 'Transaction' },
    });
    expect(attrs.isError).toBe(true);
    expect((attrs._meta?.[ERROR_META_KEY] as { code?: string } | undefined)?.code).toBe('RB_LIMIT_QUERY');
    expect(textOf(attrs)).not.toContain('alpha_attr');
    // Both answers came from the cache or the limits: nothing new was fetched for the closed project.
    expect(h.nerdGraph.calls.length).toBe(before);
  });
});

describe('query cache (P7-02, T16): entries never cross grants, projects or credentials', () => {
  const NRQL = 'SELECT count(*) FROM Transaction SINCE 1 hour ago';
  const nrqlCalls = () => h.nerdGraph.calls.filter((c) => c.op === 'RbNrql').length;
  const run = async (client: Client) => {
    const r = await client.callTool({ name: 'run_nrql', arguments: { nrql: NRQL } });
    return {
      text: textOf(r),
      cache: (r._meta?.['relic-bridge/result'] as { cache?: { status: string } } | undefined)?.cache?.status,
    };
  };

  it('the same grant hits; another grant, project or credential runs its own query', async () => {
    const credentialId = await h.addCredential({ key: NR_KEY, reachable: [1, 2, 999] });
    const projectId = await h.addProject('qc-one', { credentialId, allowed: [1, 2] });
    const grantA = await connect(
      h.app,
      'qc-one',
      (await h.addToken(await h.addGrant(projectId))).value,
      'modern',
    );
    const grantB = await connect(
      h.app,
      'qc-one',
      (await h.addToken(await h.addGrant(projectId))).value,
      'modern',
    );
    clients.push(grantA, grantB);
    const other = await tenantClient('qc-two', { credentialId, allowed: [1, 2] });
    const otherKey = await tenantClient('qc-three', { key: NR_KEY_B, allowed: [1, 2] });

    expect((await run(grantA)).cache).toBe('miss');
    const calls = nrqlCalls();
    expect((await run(grantA)).cache).toBe('hit');
    expect(nrqlCalls()).toBe(calls);

    for (const client of [grantB, other.client, otherKey.client]) {
      const before = nrqlCalls();
      expect((await run(client)).cache).toBe('miss');
      expect(nrqlCalls()).toBe(before + 1);
    }
    const beta = await run(otherKey.client);
    expect(beta.cache).toBe('hit');
    expect(beta.text).toContain('beta');
    expect(beta.text).not.toContain('alpha');
    expect((await run(grantA)).text).not.toContain('beta');
  });

  it('cache "bypass" asks New Relic again', async () => {
    const a = await tenantClient('qc-bypass', { key: NR_KEY });
    await run(a.client);
    const before = nrqlCalls();
    const r = await a.client.callTool({ name: 'run_nrql', arguments: { nrql: NRQL, cache: 'bypass' } });
    expect(
      (r._meta?.['relic-bridge/result'] as { cache?: { status: string } } | undefined)?.cache?.status,
    ).toBe('bypass');
    expect(nrqlCalls()).toBe(before + 1);
  });
});

describe('concurrent tenants (T21)', () => {
  it('interleaved requests of two tenants with different keys never mix', async () => {
    h.nerdGraph.delayMs = 5;
    const a = await tenantClient('tenant-a', { key: NR_KEY, allowed: [1, 2] });
    const b = await tenantClient('tenant-b', { key: NR_KEY_B, allowed: [3] });
    const work: [string, Client, string, string][] = [];
    const calls: [string, Record<string, unknown>][] = [
      ['whoami', {}],
      ['list_accounts', {}],
      ['run_nrql', { nrql: 'SELECT count(*) FROM Transaction SINCE 1 hour ago' }],
      ['search_entities', {}],
      ['list_event_types', {}],
    ];
    for (let i = 0; i < 8; i++) {
      for (const [tool, args] of calls) {
        work.push([tool, a.client, 'alpha', JSON.stringify(args)]);
        work.push([tool, b.client, 'beta', JSON.stringify(args)]);
      }
    }
    const results = await Promise.all(
      work.map(async ([tool, client, label, args]) => ({
        tool,
        label,
        text: textOf(await client.callTool({ name: tool, arguments: JSON.parse(args) })),
      })),
    );
    for (const r of results) {
      const other = r.label === 'alpha' ? 'beta' : 'alpha';
      expect(r.text, `${r.label} ${r.tool}`).toContain(r.label);
      expect(r.text, `${r.label} ${r.tool}`).not.toContain(other);
      expect(r.text).not.toContain(LEAK);
      expect(r.text).not.toContain('"isError":true');
    }
    // Every NerdGraph call that names an account carries the key of the tenant owning that account.
    for (const call of h.nerdGraph.calls) {
      for (const account of accountsNamed(call)) {
        expect(call.apiKey, `${call.op} for account ${account}`).toBe(account === 3 ? NR_KEY_B : NR_KEY);
      }
    }
    expect(h.nerdGraph.calls.filter((c) => c.apiKey === NR_KEY).length).toBeGreaterThan(0);
    expect(h.nerdGraph.calls.filter((c) => c.apiKey === NR_KEY_B).length).toBeGreaterThan(0);
  });

  it('builds the MCP server per request: interleaved grants each see their own tools and project', async () => {
    const full = await connect(h.app, 'prod', h.world.tokens.prod, 'modern');
    const limited = await connect(h.app, 'prod', h.world.tokens.limited, 'modern');
    const eu = await connect(h.app, 'eu', h.world.tokens.eu, 'legacy');
    clients.push(full, limited, eu);
    const jobs = Array.from({ length: 12 }, (_, i) => [full, limited, eu][i % 3] as Client);
    const lists = await Promise.all(
      jobs.map(async (c) => (await c.listTools()).tools.map((t) => t.name).sort()),
    );
    lists.forEach((names, i) => {
      const who = i % 3;
      expect(names).toEqual(who === 1 ? ['list_accounts', 'whoami'] : [...CATALOG].sort());
    });
    const projects = await Promise.all(
      jobs.map(
        async (c) =>
          ((await c.callTool({ name: 'whoami', arguments: {} })).structuredContent as { project: string })
            .project,
      ),
    );
    expect(projects).toEqual(jobs.map((_, i) => (i % 3 === 2 ? 'eu' : 'prod')));
  });
});
