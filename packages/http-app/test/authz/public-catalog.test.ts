// SPDX-License-Identifier: Apache-2.0
// Registry-friendly discovery (P7-14, THREAT_MODEL T19/T20/T33), on every host of the suite (HTTP app and Worker + D1).
// Off by default. On, a caller without credentials may learn the static read-only tool catalog and nothing else: the
// answer is the same for a known, an unknown and a malformed slug (no project existence oracle), no storage or
// NerdGraph is touched, and every other request gets the standard 401 a request without credentials always got.
import { TOOL_CATALOG_PATH, WRITE_TOOL_NAMES } from '@relic-bridge/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NR_KEY } from '../fixtures.ts';
import { type Captured, createHarness, type Harness } from './harness.ts';

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.scan();
});

type App = ReturnType<Harness['makeApp']>;

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'registry', version: '0' } },
};
const TOOLS_LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
/** Known (seeded), unknown, and not even a valid slug. */
const SLUGS = ['prod', 'no-such-project', 'Not_A_Slug'];

function post(slug: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/p/${slug}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** The JSON-RPC payload of a JSON or SSE answer. */
function payload(r: Captured): { result?: Record<string, unknown>; error?: unknown } {
  const sse = /^data: (.+)$/m.exec(r.text);
  return JSON.parse(sse ? (sse[1] as string) : r.text) as { result?: Record<string, unknown> };
}

/** Everything a client can observe except the per-request id, with the slug folded out of the challenge. */
function observable(r: Captured, slug: string): string {
  const headers = [...r.headers.entries()]
    .filter(([name]) => name !== 'x-request-id')
    .map(([name, value]) => [name, value.replaceAll(`/p/${slug}/mcp`, '/p/{slug}/mcp')])
    .sort(([a], [b]) => (a as string).localeCompare(b as string));
  return JSON.stringify({ status: r.status, headers, body: r.text });
}

const toolNames = (r: Captured): string[] =>
  ((payload(r).result?.['tools'] as { name: string }[] | undefined) ?? []).map((t) => t.name).sort();

describe('public tool catalog: off by default', () => {
  it('no credentials still get the 401 for discovery requests, and the catalog document does not exist', async () => {
    const reference = await h.send(new Request('http://localhost/p/prod/mcp', { method: 'GET' }));
    expect(reference.status).toBe(401);
    for (const body of [INITIALIZE, TOOLS_LIST]) {
      const res = await h.send(post('prod', body));
      expect(res.status).toBe(401);
      expect(res.text).toBe('{"error":"unauthorized"}');
    }
    expect((await h.send(new Request(`http://localhost${TOOL_CATALOG_PATH}`))).status).toBe(404);
  });
});

describe('public tool catalog: on (RB_PUBLIC_TOOL_CATALOG=on)', () => {
  let app: App;
  beforeEach(() => {
    // Write tools on too: they must still never appear in a public listing.
    app = h.makeApp({ publicToolCatalog: true, writeTools: true });
  });

  it('initialize and tools/list answer the same bytes for a known, an unknown and a malformed slug', async () => {
    for (const body of [INITIALIZE, TOOLS_LIST]) {
      const answers = new Set<string>();
      for (const slug of SLUGS) {
        const res = await h.send(post(slug, body), app);
        expect(res.status, `${body.method} ${slug}`).toBe(200);
        answers.add(JSON.stringify({ status: res.status, body: res.text }));
      }
      expect(answers.size, body.method).toBe(1);
    }
    // Nothing was looked up or asked: no storage-backed denial, no NerdGraph call, no audit row.
    expect(h.nerdGraph.calls).toEqual([]);
    expect(await h.auditRows()).toEqual([]);
  });

  it('lists only static read-only tool definitions: no write tools, no project, grant or account data', async () => {
    const res = await h.send(post('prod', TOOLS_LIST), app);
    const names = toolNames(res);
    expect(names.length).toBeGreaterThan(10);
    expect(names).toContain('run_nrql');
    for (const w of WRITE_TOOL_NAMES) expect(names).not.toContain(w);
    for (const t of (payload(res).result?.['tools'] as { annotations: { readOnlyHint: boolean } }[]) ?? []) {
      expect(t.annotations.readOnlyHint).toBe(true);
    }
    const world = h.world;
    expect(res.text).not.toContain('acct ');
    for (const secret of ['prod', 'eu', world.tokens.prod, NR_KEY, ...Object.values(world.projectIds)]) {
      expect(res.text.includes(`"${secret}"`), secret).toBe(false);
    }
    // The initialize answer offers tools only (prompts and resources need a credential).
    const init = payload(await h.send(post('prod', INITIALIZE), app)).result as Record<string, unknown>;
    expect(Object.keys(init['capabilities'] as object)).toEqual(['tools']);
  });

  it('the catalog document is the same for every caller and lists the same tools as tools/list', async () => {
    const answers = new Set<string>();
    for (const headers of [
      {},
      { authorization: `Bearer ${h.world.tokens.prod}` },
      { authorization: 'Bearer x' },
    ]) {
      const res = await h.send(new Request(`http://localhost${TOOL_CATALOG_PATH}`, { headers }), app);
      expect(res.status).toBe(200);
      answers.add(res.text);
    }
    expect(answers.size).toBe(1);
    const doc = JSON.parse([...answers][0] as string) as { name: string; tools: { name: string }[] };
    expect(doc.name).toBe('relic-bridge');
    expect(doc.tools.map((t) => t.name).sort()).toEqual(toolNames(await h.send(post('x', TOOLS_LIST), app)));
    expect(await h.auditRows()).toEqual([]);
  });

  it('everything else without credentials is the standard 401, identical for known and unknown slugs', async () => {
    const refusedBodies: unknown[] = [
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'run_nrql', arguments: { nrql: 'SELECT count(*) FROM Transaction' } },
      },
      { jsonrpc: '2.0', id: 4, method: 'resources/list', params: {} },
      { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'relic-bridge://nrql/reference' } },
      { jsonrpc: '2.0', id: 5, method: 'prompts/list', params: {} },
      { jsonrpc: '2.0', id: 5, method: 'prompts/get', params: { name: 'investigate_errors' } },
      { jsonrpc: '2.0', id: 6, method: 'tasks/get', params: { taskId: 'A'.repeat(43) } },
      { jsonrpc: '2.0', id: 7, method: 'subscriptions/listen', params: {} },
      { jsonrpc: '2.0', id: 8, method: 'completion/complete', params: {} },
      [INITIALIZE],
      [TOOLS_LIST, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'whoami' } }],
      { jsonrpc: '2.0', id: 10 },
      'not json',
      `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"pad":"${'x'.repeat(20_000)}"}}`,
    ];
    const off = h.makeApp({});
    for (const slug of SLUGS.slice(0, 2)) {
      const reference = await h.send(post(slug, INITIALIZE), off);
      expect(reference.status).toBe(401);
      const seen = new Set<string>();
      for (const body of refusedBodies) {
        const res = await h.send(post(slug, body), app);
        expect(res.status, `${slug} ${JSON.stringify(body).slice(0, 60)}`).toBe(401);
        seen.add(observable(res, slug));
        // A header naming a public method changes nothing: the body decides (P2-12).
        const lying = await h.send(post(slug, body, { 'mcp-method': 'tools/list' }), app);
        seen.add(observable(lying, slug));
      }
      for (const method of ['GET', 'DELETE']) {
        const res = await h.send(new Request(`http://localhost/p/${slug}/mcp`, { method }), app);
        seen.add(observable(res, slug));
      }
      expect([...seen]).toEqual([observable(reference, slug)]);
    }
    expect(h.nerdGraph.calls).toEqual([]);
    // Each refusal is the usual `missing_token` denial row, naming nobody.
    const rows = await h.auditRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatchObject({
        kind: 'auth',
        status: 'denied',
        errorCode: 'missing_token',
        projectId: null,
      });
    }
  });

  it('with OAuth on, refusals still carry the resource_metadata challenge built from the path alone', async () => {
    const oauthApp = h.makeApp({ publicToolCatalog: true, oauth: {} });
    const call = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } };
    const seen = new Set<string>();
    for (const slug of SLUGS.slice(0, 2)) {
      const res = await h.send(post(slug, call), oauthApp);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain(
        `resource_metadata="http://localhost/.well-known/oauth-protected-resource/p/${slug}/mcp"`,
      );
      seen.add(observable(res, slug));
      const listed = await h.send(post(slug, TOOLS_LIST), oauthApp);
      expect(listed.status).toBe(200);
    }
    expect(seen.size).toBe(1);
  });

  it('a request with an Authorization header always takes the authenticated path', async () => {
    // Positive control: a valid token lists its grant's tools, not the public catalog.
    const own = await h.send(
      post('prod', TOOLS_LIST, { authorization: `Bearer ${h.world.tokens.prod}` }),
      app,
    );
    expect(own.status).toBe(200);
    expect(toolNames(own)).toContain('whoami');
    // A bad or misplaced credential is refused even for a public method: no fallback to the catalog.
    for (const [slug, auth] of [
      ['prod', 'Bearer rb_not_a_real_token'],
      ['eu', `Bearer ${h.world.tokens.prod}`],
      ['prod', 'Basic dTpw'],
      ['prod', ''],
    ] as const) {
      const res = await h.send(post(slug, TOOLS_LIST, { authorization: auth }), app);
      expect(res.status, `${slug} ${auth}`).toBe(401);
      expect(res.text).toBe('{"error":"unauthorized"}');
    }
  });
});
