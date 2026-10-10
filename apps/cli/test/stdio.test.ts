// SPDX-License-Identifier: Apache-2.0
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import {
  createBuiltinTools,
  createLogger,
  DEFAULT_LIMITS,
  type FetchLike,
  type QueryLimits,
  Secret,
} from '@relic-bridge/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, type ResolvedProject } from '../src/config.ts';
import { prepareServer, selectTools } from '../src/stdio.ts';
import { FAKE_KEY, identityBody } from './helpers.ts';

function project(overrides: Partial<ResolvedProject> = {}): ResolvedProject {
  return {
    slug: 'acme',
    source: 'yaml',
    credentialId: 'project:acme',
    region: 'US',
    apiKey: new Secret(FAKE_KEY),
    accounts: { allowed: [1000001], default: 1000001 },
    limits: DEFAULT_LIMITS,
    ...overrides,
  };
}

const ALL = createBuiltinTools();
const names = (p: ResolvedProject) => selectTools(p, ALL).map((t) => t.name);

describe('selectTools', () => {
  it('exposes every built-in tool by default', () => {
    expect(names(project())).toEqual(ALL.map((t) => t.name));
  });

  it('applies the allowlist', () => {
    expect(names(project({ tools: ['whoami', 'time_range'] }))).toEqual(['whoami', 'time_range']);
  });

  it('does not register raw-NRQL tools when rawNrql is off', () => {
    const limits: QueryLimits = { ...DEFAULT_LIMITS, rawNrql: false };
    const got = names(project({ limits }));
    expect(got).not.toContain('run_nrql');
    expect(got).not.toContain('get_query_result');
    expect(got).toContain('get_golden_metrics');
    expect(names(project({ limits, tools: ['run_nrql', 'whoami'] }))).toEqual(['whoami']);
  });

  it('refuses unknown tool names and an empty selection', () => {
    expect(() => selectTools(project({ tools: ['whoami', 'delete_everything'] }), ALL)).toThrow(
      /Unknown tool name\(s\).*delete_everything/,
    );
    expect(() =>
      selectTools(project({ tools: ['run_nrql'], limits: { ...DEFAULT_LIMITS, rawNrql: false } }), ALL),
    ).toThrow(ConfigError);
  });
});

describe('prepareServer', () => {
  let clients: Client[] = [];
  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close()));
    clients = [];
  });

  async function connect(p: ResolvedProject, fetch: FetchLike) {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
    const { factory, tools } = prepareServer({ project: p, logger, fetch });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await factory().connect(serverT);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientT);
    clients.push(client);
    return { client, tools, lines };
  }

  it('fills connection info for whoami and sends the key only to NerdGraph', async () => {
    const seen: { url: string; key: string | null }[] = [];
    const fetch: FetchLike = async (url, init) => {
      seen.push({ url, key: new Headers(init.headers).get('API-Key') });
      return Response.json(identityBody([{ id: 1000001, name: 'Prod' }]));
    };
    const { client, lines } = await connect(project({ tools: ['whoami', 'list_accounts'] }), fetch);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['whoami', 'list_accounts']);

    const r = await client.callTool({ name: 'whoami', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      project: 'acme',
      region: 'US',
      defaultAccount: 1000001,
      allowedTools: ['whoami', 'list_accounts'],
    });
    expect(seen).toEqual([{ url: 'https://api.newrelic.com/graphql', key: FAKE_KEY }]);
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
    expect(lines.join('\n')).not.toContain(FAKE_KEY);
  });

  it('uses a fresh request id per call', async () => {
    const fetch: FetchLike = async () => Response.json({ errors: [{ message: 'boom' }] });
    const { client } = await connect(project({ tools: ['whoami'] }), fetch);
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const r = await client.callTool({ name: 'whoami', arguments: {} });
      expect(r.isError).toBe(true);
      const meta = r._meta?.['relic-bridge/error'] as { requestId?: string } | undefined;
      ids.add(String(meta?.requestId));
    }
    expect(ids.size).toBe(3);
  });

  it('refuses calls to tools that are not registered (negative authorization)', async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      return Response.json({ data: {} });
    };
    const { client } = await connect(
      project({ tools: ['whoami'], limits: { ...DEFAULT_LIMITS, rawNrql: false } }),
      fetch,
    );
    const r = await client
      .callTool({ name: 'run_nrql', arguments: { nrql: 'SELECT 1 FROM Log' } })
      .catch((e: unknown) => ({ isError: true, error: String(e) }));
    expect(r.isError).toBe(true);
    expect(calls).toBe(0);
  });
});
