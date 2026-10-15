// SPDX-License-Identifier: Apache-2.0
import { createLogger, redact } from '@relic-bridge/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHttpApp, type HttpAppOptions, type McpRequestInfo, mergeHooks } from '../src/index.ts';
import { CATALOG, connect, type Era, mockNerdGraph, NR_KEY, seedWorld, type World } from './fixtures.ts';

let world: World;
let nerdGraph: ReturnType<typeof mockNerdGraph>;
let logLines: string[];

beforeEach(async () => {
  world = await seedWorld();
  nerdGraph = mockNerdGraph();
  logLines = [];
});

afterEach(() => {
  // No secret ever reaches the logs (T8): neither the New Relic key nor any token.
  const all = logLines.join('\n');
  expect(all).not.toContain(NR_KEY);
  for (const token of Object.values(world.tokens)) expect(all).not.toContain(token);
});

function makeApp(over: Partial<HttpAppOptions> = {}) {
  return createHttpApp({
    storage: world.storage,
    keyring: world.keyring,
    clock: world.clock,
    fetch: nerdGraph.fetch,
    logger: createLogger({ level: 'debug', sink: (l) => logLines.push(l), now: () => world.clock.now() }),
    ...over,
  });
}

const URL_BASE = 'http://localhost';

function mcpPost(
  path: string,
  init: { token?: string; headers?: Record<string, string>; body?: string } = {},
) {
  return new Request(`${URL_BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      ...init.headers,
    },
    body:
      init.body ??
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      }),
  });
}

async function toolNames(slug: string, token: string, era: Era): Promise<string[]> {
  const client = await connect(makeApp(), slug, token, era);
  try {
    return (await client.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

describe('public routes', () => {
  it('/health answers ok and nothing else', async () => {
    const res = await makeApp().fetch(new Request(`${URL_BASE}/health`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('/version names the version', async () => {
    const res = await makeApp().fetch(new Request(`${URL_BASE}/version`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'relic-bridge', version: expect.any(String) });
  });

  it('unknown routes are 404 JSON', async () => {
    const res = await makeApp().fetch(new Request(`${URL_BASE}/admin`));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('sets security headers on every response; HSTS only over TLS (or when forced)', async () => {
    const app = makeApp({ allowedHosts: ['localhost', 'mcp.example.com'] });
    for (const res of [
      await app.fetch(new Request(`${URL_BASE}/health`)),
      await app.fetch(new Request(`${URL_BASE}/nope`)),
      await app.fetch(mcpPost('/p/prod/mcp')),
    ]) {
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('strict-transport-security')).toBeNull();
      expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    }
    const tls = await app.fetch(new Request('https://mcp.example.com/health'));
    expect(tls.headers.get('strict-transport-security')).toMatch(/^max-age=31536000/);
    const forced = await makeApp({ hsts: true }).fetch(new Request(`${URL_BASE}/health`));
    expect(forced.headers.get('strict-transport-security')).not.toBeNull();
    const off = await makeApp({ hsts: false, allowedHosts: ['mcp.example.com'] }).fetch(
      new Request('https://mcp.example.com/health'),
    );
    expect(off.headers.get('strict-transport-security')).toBeNull();
  });

  it('hstsAlways sends HSTS over plain http, unless hsts is false (P8-66)', async () => {
    const always = makeApp({ hstsAlways: true });
    for (const res of [
      await always.fetch(new Request(`${URL_BASE}/health`)),
      await always.fetch(new Request(`${URL_BASE}/nope`)),
      await always.fetch(mcpPost('/p/prod/mcp')),
    ]) {
      expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    }
    const off = await makeApp({ hsts: false, hstsAlways: true }).fetch(new Request(`${URL_BASE}/health`));
    expect(off.headers.get('strict-transport-security')).toBeNull();
  });
});

describe('MCP over HTTP with an SDK client', () => {
  for (const era of ['legacy', 'modern'] as const) {
    describe(`${era} era`, () => {
      it('lists every granted tool and runs one with the stored key', async () => {
        expect(await toolNames('prod', world.tokens.prod, era)).toEqual([...CATALOG].sort());
        const client = await connect(makeApp(), 'prod', world.tokens.prod, era);
        const out = await client.callTool({ name: 'whoami', arguments: {} });
        await client.close();
        expect(out.isError).toBeFalsy();
        expect(JSON.stringify(out.content)).toContain('prod');
        expect(nerdGraph.calls.length).toBeGreaterThan(0);
        expect(nerdGraph.calls.every((c) => c.apiKey === NR_KEY)).toBe(true);
      });

      it('lists only the tools a limited grant allows and rejects the others', async () => {
        expect(await toolNames('prod', world.tokens.limited, era)).toEqual(['list_accounts', 'whoami']);
        const client = await connect(makeApp(), 'prod', world.tokens.limited, era);
        let rejected = false;
        try {
          const r = await client.callTool({ name: 'run_nrql', arguments: { nrql: 'SELECT 1 FROM Log' } });
          rejected = r.isError === true;
        } catch {
          rejected = true;
        }
        await client.close();
        expect(rejected).toBe(true);
        expect(nerdGraph.calls).toEqual([]);
      });

      it('hides the raw NRQL tools when rawNrql is off', async () => {
        const names = await toolNames('noraw', world.tokens.noraw, era);
        expect(names).not.toContain('run_nrql');
        expect(names).not.toContain('get_query_result');
        expect(names).toContain('whoami');
      });

      it('refuses a token of another project with 401', async () => {
        await expect(connect(makeApp(), 'prod', world.tokens.eu, era)).rejects.toThrow();
      });
    });
  }

  it('subscriptions/listen is acknowledged with nothing to deliver and closed at once', async () => {
    const infos: McpRequestInfo[] = [];
    const app = makeApp({ hooks: { beforeMcp: (_c, info) => void infos.push(info) } });
    const client = await connect(app, 'prod', world.tokens.prod, 'modern');
    const sub = await client.listen({ toolsListChanged: true });
    expect(sub.honoredFilter).toEqual({});
    expect(await sub.closed).toBe('graceful');
    await client.close();
    // Flagged for the rate limiter (P2-07), which must not count it as a tool call.
    expect(infos.filter((i) => i.listen).map((i) => i.mcpMethod)).toEqual(['subscriptions/listen']);
  });

  it('builds a fresh context per request: a request id and budget each, the project in connection info', async () => {
    const infos: McpRequestInfo[] = [];
    const app = makeApp({ hooks: { beforeMcp: (_c, info) => void infos.push(info) } });
    const client = await connect(app, 'prod', world.tokens.prod, 'modern');
    await client.callTool({ name: 'whoami', arguments: {} });
    await client.close();
    expect(new Set(infos.map((i) => i.requestId)).size).toBe(infos.length);
    const call = infos.find((i) => i.mcpMethod === 'tools/call');
    expect(call).toMatchObject({ projectSlug: 'prod', mcpName: 'whoami', listen: false });
  });
});

describe('authentication and authorization (negative)', () => {
  async function expect401(res: Response): Promise<void> {
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="relic-bridge"');
    expect(await res.text()).toBe('{"error":"unauthorized"}');
  }

  const mutate = (t: string): string => t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');

  it('answers every denial with the same 401', async () => {
    await world.storage.projects.update(world.projectIds.eu, { disabledAt: 1 });
    const unknown = `rb_live_${'A'.repeat(43)}_000000`; // right shape, wrong checksum
    const cases: [string, Request][] = [
      ['missing token', mcpPost('/p/prod/mcp')],
      ['basic scheme', mcpPost('/p/prod/mcp', { headers: { authorization: 'Basic dXNlcjpwYXNz' } })],
      ['empty bearer', mcpPost('/p/prod/mcp', { headers: { authorization: 'Bearer ' } })],
      ['garbage token', mcpPost('/p/prod/mcp', { token: 'not-a-token' })],
      ['bad checksum', mcpPost('/p/prod/mcp', { token: mutate(world.tokens.prod) })],
      ['wrong-shape rb token', mcpPost('/p/prod/mcp', { token: unknown })],
      ['NR key as token', mcpPost('/p/prod/mcp', { token: NR_KEY })],
      ['token of another project', mcpPost('/p/prod/mcp', { token: world.tokens.eu })],
      ['unknown slug', mcpPost('/p/nope/mcp', { token: world.tokens.prod })],
      ['malformed slug', mcpPost('/p/..%2Fadmin/mcp', { token: world.tokens.prod })],
      ['disabled project', mcpPost('/p/eu/mcp', { token: world.tokens.eu })],
      ['GET without token', new Request(`${URL_BASE}/p/prod/mcp`, { method: 'GET' })],
      ['DELETE without token', new Request(`${URL_BASE}/p/prod/mcp`, { method: 'DELETE' })],
    ];
    const app = makeApp();
    for (const [name, req] of cases) {
      const res = await app.fetch(req);
      try {
        await expect401(res);
      } catch (error) {
        throw new Error(`${name}: ${(error as Error).message}`);
      }
    }
    expect(nerdGraph.calls).toEqual([]);
  });

  it('a well-formed but unknown token is 401', async () => {
    const { generateTokenString } = await import('@relic-bridge/auth');
    await expect401(await makeApp().fetch(mcpPost('/p/prod/mcp', { token: generateTokenString() })));
  });

  it('revoked and expired tokens, revoked grants and disabled users are 401', async () => {
    const app = makeApp({ accessCacheTtlMs: 0 });
    expect((await app.fetch(mcpPost('/p/prod/mcp', { token: world.tokens.prod }))).status).toBe(200);
    await world.storage.accessTokens.revoke(world.tokenIds.prod, world.clock.now());
    await expect401(await app.fetch(mcpPost('/p/prod/mcp', { token: world.tokens.prod })));

    world.clock.advance(10_000);
    await expect401(await app.fetch(mcpPost('/p/prod/mcp', { token: world.tokens.shortLived })));

    // Another owner first: the last enabled owner cannot be disabled (P4-16).
    await world.storage.users.create({ id: 'usr_o2', email: 'o2@example.com', role: 'owner' });
    await world.storage.users.update('usr_a', { disabledAt: world.clock.now() });
    await expect401(await app.fetch(mcpPost('/p/noraw/mcp', { token: world.tokens.noraw })));
  });

  it('a revocation takes effect within the cache TTL, and at once with TTL 0', async () => {
    const cached = makeApp({ accessCacheTtlMs: 30_000 });
    const uncached = makeApp({ accessCacheTtlMs: 0 });
    const req = () => mcpPost('/p/prod/mcp', { token: world.tokens.prod });
    expect((await cached.fetch(req())).status).toBe(200);
    await world.storage.accessTokens.revoke(world.tokenIds.prod, world.clock.now());
    await expect401(await uncached.fetch(req()));
    expect((await cached.fetch(req())).status).toBe(200); // still cached
    world.clock.advance(29_999);
    expect((await cached.fetch(req())).status).toBe(200);
    world.clock.advance(1);
    await expect401(await cached.fetch(req()));
  });

  it('the cache never outlives the token', async () => {
    const app = makeApp({ accessCacheTtlMs: 60_000 });
    const req = () => mcpPost('/p/prod/mcp', { token: world.tokens.shortLived });
    expect((await app.fetch(req())).status).toBe(200);
    world.clock.advance(9_999);
    expect((await app.fetch(req())).status).toBe(200);
    world.clock.advance(1);
    await expect401(await app.fetch(req()));
  });

  it('a cached token is still bound to its project', async () => {
    const app = makeApp({ accessCacheTtlMs: 60_000 });
    expect((await app.fetch(mcpPost('/p/eu/mcp', { token: world.tokens.eu }))).status).toBe(200);
    await expect401(await app.fetch(mcpPost('/p/prod/mcp', { token: world.tokens.eu })));
  });

  it('refuses access cache TTLs above 60 s', () => {
    expect(() => makeApp({ accessCacheTtlMs: 60_001 })).toThrow(RangeError);
    expect(() => makeApp({ accessCacheTtlMs: -1 })).toThrow(RangeError);
  });

  it('fails closed with 503 when storage fails', async () => {
    const broken = {
      ...world.storage,
      accessTokens: {
        ...world.storage.accessTokens,
        getByHash: async () => {
          throw new Error(`disk on fire ${NR_KEY}`);
        },
      },
    };
    const res = await makeApp({ storage: broken }).fetch(
      mcpPost('/p/prod/mcp', { token: world.tokens.prod }),
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"error":"unavailable"}');
  });

  it('reports the deny reason to the auth-failure hook and the log only', async () => {
    const reasons: string[] = [];
    const app = makeApp({ hooks: { onAuthFailure: (_c, i) => void reasons.push(i.reason) } });
    await app.fetch(mcpPost('/p/prod/mcp', { token: world.tokens.eu }));
    await app.fetch(mcpPost('/p/prod/mcp'));
    expect(reasons).toEqual(['grant_wrong_project', 'missing_token']);
    expect(logLines.some((l) => l.includes('"deny":"grant_wrong_project"'))).toBe(true);
  });
});

describe('request hardening', () => {
  it('rejects a foreign Host (DNS rebinding) before authentication', async () => {
    const res = await makeApp().fetch(
      new Request('http://evil.example/p/prod/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${world.tokens.prod}`, 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden_host' });
  });

  it('rejects a foreign or null Origin, accepts a local one', async () => {
    const app = makeApp();
    for (const origin of ['https://evil.example', 'null']) {
      const res = await app.fetch(mcpPost('/p/prod/mcp', { token: world.tokens.prod, headers: { origin } }));
      expect(res.status).toBe(403);
    }
    const ok = await app.fetch(
      mcpPost('/p/prod/mcp', { token: world.tokens.prod, headers: { origin: 'http://localhost:6274' } }),
    );
    expect(ok.status).toBe(200);
  });

  it('CORS is off by default and follows the allowlist when configured', async () => {
    const preflight = (origin: string) =>
      new Request(`${URL_BASE}/p/prod/mcp`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      });
    const off = await makeApp().fetch(preflight('http://localhost:3000'));
    expect(off.headers.get('access-control-allow-origin')).toBeNull();

    const on = makeApp({ corsOrigins: ['https://app.example.com'] });
    const allowed = await on.fetch(preflight('https://app.example.com'));
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(allowed.headers.get('access-control-allow-headers')).toMatch(/authorization/i);
    const other = await on.fetch(preflight('https://evil.example'));
    expect(other.status).toBe(403);
    expect(() => makeApp({ corsOrigins: ['app.example.com'] })).toThrow(TypeError);
  });

  it('refuses an oversized body with 413 before authentication', async () => {
    const reasons: string[] = [];
    const app = makeApp({
      maxBodyBytes: 2048,
      hooks: { onAuthFailure: (_c, i) => void reasons.push(i.reason) },
    });
    const res = await app.fetch(
      mcpPost('/p/prod/mcp', { body: 'x'.repeat(4096), headers: { 'content-length': '4096' } }),
    );
    expect(res.status).toBe(413);
    expect(reasons).toEqual([]);
    // Streamed (no Content-Length) bodies are bounded by the MCP handler with the same limit.
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('x'.repeat(4096)));
        c.close();
      },
    });
    const chunked = await app.fetch(
      new Request(`${URL_BASE}/p/prod/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${world.tokens.prod}`, 'content-type': 'application/json' },
        body: stream,
        duplex: 'half',
      } as RequestInit),
    );
    expect(chunked.status).toBe(413);
  });

  it('bounds a body that never ends: 504 at the deadline, before any tool runs (P2-12)', async () => {
    const app = makeApp({ requestTimeoutMs: 1000 });
    const stalled = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",'));
      },
    });
    const started = Date.now();
    const res = await app.fetch(
      new Request(`${URL_BASE}/p/prod/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${world.tokens.prod}`, 'content-type': 'application/json' },
        body: stalled,
        duplex: 'half',
      } as RequestInit),
    );
    expect(res.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(nerdGraph.calls).toEqual([]);
  });

  it('bounds a stuck MCP exchange: the response stream ends at the deadline', async () => {
    const app = makeApp({ requestTimeoutMs: 1000, fetch: () => new Promise<Response>(() => undefined) });
    const started = Date.now();
    const res = await app.fetch(
      mcpPost('/p/prod/mcp', {
        token: world.tokens.prod,
        headers: { 'mcp-protocol-version': '2025-11-25' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'whoami', arguments: {} },
        }),
      }),
    );
    const body = await res.text();
    expect(Date.now() - started).toBeLessThan(4000);
    expect(body).not.toContain('"result"');
    expect(logLines.some((l) => l.includes('mcp request timed out'))).toBe(true);
  });
});

describe('hooks', () => {
  it('beforeMcp can stop a request (rate limiting) and afterMcp sees the outcome (audit)', async () => {
    const after: { status: number; tool: string | null }[] = [];
    let block = false;
    const app = makeApp({
      hooks: {
        beforeMcp: () => (block ? new Response('slow down', { status: 429 }) : undefined),
        afterMcp: (_c, info, outcome) => void after.push({ status: outcome.status, tool: info.mcpName }),
      },
    });
    expect((await app.fetch(mcpPost('/p/prod/mcp', { token: world.tokens.prod }))).status).toBe(200);
    block = true;
    const res = await app.fetch(mcpPost('/p/prod/mcp', { token: world.tokens.prod }));
    expect(res.status).toBe(429);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    await new Promise((r) => setTimeout(r, 0));
    expect(after).toEqual([{ status: 200, tool: null }]);
  });

  it('logs one redacted line per request, without the token', async () => {
    await makeApp().fetch(mcpPost('/p/prod/mcp', { token: world.tokens.prod }));
    const line = logLines.map((l) => JSON.parse(l)).find((l) => l.msg === 'http request');
    expect(line).toMatchObject({ status: 200, project: 'prod', route: '/p/:slug/mcp' });
    expect(JSON.stringify(line)).toBe(redact(JSON.stringify(line)));
  });
});

describe('write tools need the write audit hook (P7-28)', () => {
  it('refuses writeTools without hooks.onWriteIntent, accepts it with one (also through mergeHooks)', () => {
    expect(() => makeApp({ writeTools: true })).toThrow(/onWriteIntent/);
    expect(() => makeApp({ writeTools: true, hooks: mergeHooks({ onToolCall: () => undefined }) })).toThrow(
      /onWriteIntent/,
    );
    expect(() =>
      makeApp({ writeTools: true, hooks: { onWriteIntent: async () => undefined } }),
    ).not.toThrow();
    expect(() =>
      makeApp({ writeTools: true, hooks: mergeHooks({}, { onWriteIntent: async () => undefined }) }),
    ).not.toThrow();
    expect(() => makeApp()).not.toThrow();
  });

  it('mergeHooks runs every intent hook in order and the first rejection refuses', async () => {
    const seen: string[] = [];
    const merged = mergeHooks(
      { onWriteIntent: async () => void seen.push('a') },
      { onWriteIntent: async () => Promise.reject(new Error('store down')) },
      { onWriteIntent: async () => void seen.push('c') },
    );
    const intent = { tool: 'close_issue', input: {}, record: {} };
    await expect(merged.onWriteIntent?.({} as never, {} as McpRequestInfo, intent)).rejects.toThrow(
      'store down',
    );
    expect(seen).toEqual(['a']);
  });
});
