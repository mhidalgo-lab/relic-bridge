// SPDX-License-Identifier: Apache-2.0
// P7-04: MCP Apps chart view. Listing, reading, the tool link, and the fallback (tool results unchanged).
// The view's own behaviour (rendering, escaping, protocol) is tested in jsdom: scripts/test/chart-app.test.ts.
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMcpServer,
  CHART_APP_HTML,
  createBuiltinTools,
  type FetchLike,
  MCP_APP_MIME_TYPE,
  NRQL_CHART_URI,
  RESOURCES,
  type ResourceDefinition,
  type ToolDefinition,
} from '../src/index.ts';
import { testContext } from './helpers/context.ts';
import { json } from './helpers/nerdgraph.ts';

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

const T0 = 1_790_000_000;
const fetch: FetchLike = async () =>
  json({
    data: {
      actor: {
        account: {
          nrql: {
            results: Array.from({ length: 4 }, (_, i) => ({
              beginTimeSeconds: T0 + i * 60,
              endTimeSeconds: T0 + (i + 1) * 60,
              count: i,
            })),
            metadata: {
              eventTypes: ['Transaction'],
              facets: null,
              messages: null,
              timeWindow: null,
              timeSeries: {},
            },
            totalResult: null,
            otherResult: null,
            queryProgress: { queryId: null, completed: true, retryAfter: null, resultExpiration: null },
          },
        },
      },
    },
  });

const nrqlTools = () =>
  createBuiltinTools({ fetch, sleep: async () => {} }).filter((t) =>
    ['run_nrql', 'get_query_result', 'whoami'].includes(t.name),
  );

async function connect(tools: readonly ToolDefinition[], resources?: readonly ResourceDefinition[]) {
  const server = buildMcpServer({ tools, ctx: testContext(), ...(resources ? { resources } : {}) });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientT);
  clients.push(client);
  return client;
}

describe('MCP Apps chart view', () => {
  it('is listed with the MCP App MIME type when run_nrql is allowed', async () => {
    const client = await connect(nrqlTools());
    const view = (await client.listResources()).resources.find((r) => r.uri === NRQL_CHART_URI);
    expect(view?.mimeType).toBe('text/html;profile=mcp-app');
    expect(view?._meta?.['ui']).toMatchObject({ prefersBorder: true });
  });

  it('reads as the self-contained page with an empty CSP declaration', async () => {
    const client = await connect(nrqlTools());
    const r = await client.readResource({ uri: NRQL_CHART_URI });
    expect(r.contents).toHaveLength(1);
    const c = r.contents[0] as { mimeType?: string; text?: string; _meta?: Record<string, unknown> };
    expect(c.mimeType).toBe(MCP_APP_MIME_TYPE);
    expect(c.text).toBe(CHART_APP_HTML);
    expect(c._meta?.['ui']).toEqual({
      csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
      prefersBorder: true,
    });
  });

  it('links run_nrql and get_query_result to the view, and no other tool', async () => {
    const client = await connect(nrqlTools());
    const tools = (await client.listTools()).tools;
    const linked = tools.filter((t) => t._meta?.['ui'] !== undefined).map((t) => t.name);
    expect(linked.sort()).toEqual(['get_query_result', 'run_nrql']);
    const run = tools.find((t) => t.name === 'run_nrql');
    expect(run?._meta).toEqual({
      ui: { resourceUri: NRQL_CHART_URI, visibility: ['model'] },
      'ui/resourceUri': NRQL_CHART_URI,
    });
  });

  it('has no link and no view when run_nrql is not allowed or the view is not offered', async () => {
    const onlyHandle = await connect(nrqlTools().filter((t) => t.name !== 'run_nrql'));
    for (const t of (await onlyHandle.listTools()).tools) expect(t._meta?.['ui'], t.name).toBeUndefined();
    await expect(onlyHandle.readResource({ uri: NRQL_CHART_URI })).rejects.toThrow();

    const noView = await connect(
      nrqlTools(),
      RESOURCES.filter((r) => r.kind !== 'app'),
    );
    for (const t of (await noView.listTools()).tools) expect(t._meta?.['ui'], t.name).toBeUndefined();
    expect((await noView.listResources()).resources.map((r) => r.uri)).not.toContain(NRQL_CHART_URI);
  });

  it('fallback: the tool result is the same with and without the view (text, structuredContent, _meta)', async () => {
    const strip = (r: unknown) =>
      JSON.parse(
        JSON.stringify(r)
          .replace(/id=\\"[0-9a-f]+\\"/g, 'id=\\"x\\"')
          .replace(/"durationMs":\d+/g, '"durationMs":0'),
      ) as {
        _meta?: Record<string, unknown>;
      };
    const call = {
      name: 'run_nrql',
      arguments: { nrql: 'SELECT count(*) FROM Transaction TIMESERIES SINCE 1 hour ago' },
    };
    const withView = strip(await (await connect(nrqlTools())).callTool(call));
    const without = strip(
      await (
        await connect(
          nrqlTools(),
          RESOURCES.filter((r) => r.kind !== 'app'),
        )
      ).callTool(call),
    );
    expect(withView).toEqual(without);
    expect(Object.keys(withView._meta ?? {})).toEqual(['relic-bridge/result']);
    expect(JSON.stringify(withView)).not.toContain('ui://');
  });
});
