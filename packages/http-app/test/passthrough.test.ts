// SPDX-License-Identifier: Apache-2.0
// Pass-through mode (P2-15, THREAT_MODEL T8/T12/T20/T23): callers bring their own New Relic key per request. Off by
// default; when on, the key is validated, used for that request only and never logged, echoed, audited or stored.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createBuiltinTools, ErrorCode, RbError, Secret } from '@relic-bridge/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRateLimitHooks,
  type HttpAppOptions,
  MemoryRateLimiter,
  mergeHooks,
  PASSTHROUGH_PATH,
} from '../src/index.ts';
import {
  IdentityCache,
  isLoopbackHost,
  KeyFingerprinter,
  reachableAccounts,
  readPassthroughHeaders,
} from '../src/passthrough.ts';
import { ADMIN_TOKEN, createHarness, type Harness, NR_KEY_B } from './authz/harness.ts';
import { type Era, NR_KEY } from './fixtures.ts';

const READ_TOOLS = createBuiltinTools()
  .filter((t) => t.kind === 'read')
  .map((t) => t.name)
  .sort();
const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'pt', version: '0' } },
});

type App = { fetch(request: Request): Response | Promise<Response> };

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  // T8: neither key, nor any token, in any response, log line or audit row.
  await h.scan();
});

function ptApp(over: Partial<HttpAppOptions> = {}): App {
  return h.makeApp({ passthrough: {}, ...over });
}

async function connectPt(app: App, key: string, era: Era, region?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost${PASSTHROUGH_PATH}`), {
    requestInit: {
      headers: {
        'X-NewRelic-Api-Key': key,
        ...(region === undefined ? {} : { 'X-NewRelic-Region': region }),
      },
    },
    fetch: async (url, init) => {
      const res = await app.fetch(new Request(url, init));
      // Keep a copy of every body for the leak scan.
      h.responses.push(await res.clone().text());
      return res;
    },
  });
  const client = new Client(
    { name: 'pt-test', version: '0' },
    { versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: '2026-07-28' } } },
  );
  await client.connect(transport);
  return client;
}

function post(
  headers: Record<string, string>,
  body = INITIALIZE,
  host = 'localhost',
  scheme = 'http',
): Request {
  return new Request(`${scheme}://${host}${PASSTHROUGH_PATH}`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...headers,
    },
    body,
  });
}

const key = (k: string, region?: string): Record<string, string> => ({
  'x-newrelic-api-key': k,
  ...(region === undefined ? {} : { 'x-newrelic-region': region }),
});

describe('pass-through route', () => {
  it('is 404 when not configured', async () => {
    const res = await h.send(post(key(NR_KEY)));
    expect(res.status).toBe(404);
    expect(h.nerdGraph.calls).toEqual([]);
  });

  for (const era of ['legacy', 'modern'] as const) {
    it(`serves every read-only tool to an SDK client with its own key (${era})`, async () => {
      const app = ptApp();
      const client = await connectPt(app, NR_KEY, era);
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(READ_TOOLS);
      const who = await client.callTool({ name: 'whoami', arguments: {} });
      expect(who.isError ?? false).toBe(false);
      // Accounts = what the key reaches (sorted, default the lowest).
      expect(who.structuredContent).toMatchObject({ defaultAccount: 1 });
      const q = await client.callTool({
        name: 'run_nrql',
        arguments: { nrql: 'SELECT count(*) FROM Transaction SINCE 1 hour ago', accounts: [3] },
      });
      expect(q.isError ?? false).toBe(false);
      expect(JSON.stringify(q)).toContain('alpha');
      await client.close();
      expect(h.nerdGraph.calls.length).toBeGreaterThan(0);
      expect(h.nerdGraph.calls.every((c) => c.apiKey === NR_KEY)).toBe(true);
      // The access log names a key fingerprint id and the region, never the key.
      const line = h.logLines.find((l) => l.includes('"passthrough":true'));
      expect(line).toMatch(/"keyId":"pt_[0-9a-f]{12}"/);
      expect(line).toContain('"region":"US"');
    });
  }

  it('sends the key to the region it names', async () => {
    const urls: string[] = [];
    const app = ptApp({
      fetch: (url, init) => {
        urls.push(String(url));
        return h.nerdGraph.fetch(url, init);
      },
    });
    const client = await connectPt(app, NR_KEY, 'modern', 'eu');
    await client.callTool({ name: 'whoami', arguments: {} });
    await client.close();
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith('https://api.eu.newrelic.com/'))).toBe(true);
  });

  it('refuses an unknown region with 400 before any NerdGraph call', async () => {
    const res = await h.send(post(key(NR_KEY, 'MARS')), ptApp());
    expect(res.status).toBe(400);
    expect(res.text).toBe('{"error":"invalid_region"}');
    expect(h.nerdGraph.calls).toEqual([]);
  });

  it('answers 503 (not 401) when New Relic cannot be asked, and allows nothing', async () => {
    const app = ptApp({
      passthrough: {
        validateKey: async () => {
          throw new RbError(ErrorCode.NerdGraphUnavailable, 'down');
        },
      },
    });
    const res = await h.send(post(key(NR_KEY)), app);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
  });

  it('refuses a key that reaches no account', async () => {
    const app = ptApp({
      passthrough: { validateKey: async () => ({ user: { id: 1 }, accounts: [] }) as never },
    });
    const res = await h.send(post(key(NR_KEY)), app);
    expect(res.status).toBe(401);
    expect((await h.deniedRow(res.requestId as string)).errorCode).toBe('passthrough_no_accounts');
  });

  it('refuses JSON-RPC batches', async () => {
    const res = await h.send(post(key(NR_KEY), `[${INITIALIZE}]`), ptApp());
    expect(res.status).toBe(400);
  });

  it('refuses a declared body over the limit before reading the key', async () => {
    const req = new Request(`http://localhost${PASSTHROUGH_PATH}`, {
      method: 'POST',
      headers: {
        ...key(NR_KEY),
        'content-type': 'application/json',
        'content-length': String(2 * 1024 * 1024),
      },
      body: '{}',
    });
    const res = await h.send(req, ptApp());
    expect(res.status).toBe(413);
    expect(h.nerdGraph.calls).toEqual([]);
  });
});

describe('plain HTTP', () => {
  const remote = { allowedHosts: ['mcp.example.com'] };

  it('is refused for a non-loopback host before the key is looked at', async () => {
    const res = await h.send(post(key(NR_KEY), INITIALIZE, 'mcp.example.com'), ptApp(remote));
    expect(res.status).toBe(403);
    expect(res.text).toBe('{"error":"tls_required"}');
    expect(h.nerdGraph.calls).toEqual([]);
  });

  it('is accepted over https, behind a declared TLS proxy (hsts: true), on loopback, or when opted out', async () => {
    expect(
      (await h.send(post(key(NR_KEY), INITIALIZE, 'mcp.example.com', 'https'), ptApp(remote))).status,
    ).toBe(200);
    expect(
      (await h.send(post(key(NR_KEY), INITIALIZE, 'mcp.example.com'), ptApp({ ...remote, hsts: true })))
        .status,
    ).toBe(200);
    expect((await h.send(post(key(NR_KEY)), ptApp())).status).toBe(200);
    const optOut = ptApp({ ...remote, passthrough: { requireTls: false } });
    expect((await h.send(post(key(NR_KEY), INITIALIZE, 'mcp.example.com'), optOut)).status).toBe(200);
  });
});

describe('key validation cache', () => {
  const validations = () => h.nerdGraph.calls.filter((c) => c.op === 'RbIdentity').length;

  it('validates a key once per TTL, by fingerprint', async () => {
    const app = ptApp({ passthrough: { identityTtlMs: 10_000 } });
    await h.send(post(key(NR_KEY)), app);
    await h.send(post(key(NR_KEY)), app);
    expect(validations()).toBe(1);
    // Another key, or the same key in another region, is another entry.
    await h.send(post(key(NR_KEY_B)), app);
    await h.send(post(key(NR_KEY, 'EU')), app);
    expect(validations()).toBe(3);
    h.world.clock.advance(10_000);
    await h.send(post(key(NR_KEY)), app);
    expect(validations()).toBe(4);
  });

  it('validates every request with a TTL of 0, and never caches a refused key', async () => {
    const app = ptApp({ passthrough: { identityTtlMs: 0 } });
    await h.send(post(key(NR_KEY)), app);
    await h.send(post(key(NR_KEY)), app);
    expect(validations()).toBe(2);
    const bad = 'NRAK-UNKNOWNTESTKEY0123456789ABC';
    const cached = ptApp();
    expect((await h.send(post(key(bad)), cached)).status).toBe(401);
    expect((await h.send(post(key(bad)), cached)).status).toBe(401);
    expect(validations()).toBe(4);
  });

  it('refuses out-of-range options at construction', () => {
    expect(() => ptApp({ passthrough: { identityTtlMs: 300_001 } })).toThrow(RangeError);
    expect(() => ptApp({ passthrough: { identityCacheMaxEntries: 0 } })).toThrow(RangeError);
    expect(() => ptApp({ passthrough: { fingerprintSecret: new Secret('short') } })).toThrow(RangeError);
  });
});

describe('isolation between keys (T21)', () => {
  it('two keys interleaved never see each other’s data, caches included', async () => {
    h.nerdGraph.delayMs = 5;
    const app = ptApp();
    const [a, b] = await Promise.all([connectPt(app, NR_KEY, 'modern'), connectPt(app, NR_KEY_B, 'legacy')]);
    const calls = (c: Client) =>
      Promise.all(
        ['list_entity_types', 'list_event_types', 'list_entity_types', 'list_event_types'].map((name) =>
          c.callTool({ name, arguments: {} }),
        ),
      );
    const [ra, rb] = await Promise.all([calls(a), calls(b)]);
    const da = JSON.stringify(ra);
    const db = JSON.stringify(rb);
    expect(da).toContain('ALPHA');
    expect(da).not.toMatch(/beta/i);
    expect(db).toContain('BETA');
    expect(db).not.toMatch(/alpha/i);
    await a.close();
    await b.close();
  });
});

describe('rate limits', () => {
  function limitedApp(rules: Parameters<typeof createRateLimitHooks>[0]['rules']): App {
    const limits = createRateLimitHooks({
      limiter: new MemoryRateLimiter({ clock: h.world.clock }),
      preAuthLimiter: new MemoryRateLimiter({ clock: h.world.clock }),
      rules,
      getClientIp: () => '203.0.113.9',
    });
    return h.makeApp({ passthrough: {}, hooks: limits });
  }

  it('limits each key by its fingerprint, not the others', async () => {
    const app = limitedApp({ ip: null, passthroughKey: { requests: 2, perSeconds: 60 } });
    expect((await h.send(post(key(NR_KEY)), app)).status).toBe(200);
    expect((await h.send(post(key(NR_KEY)), app)).status).toBe(200);
    const third = await h.send(post(key(NR_KEY)), app);
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBe('30');
    expect((await h.send(post(key(NR_KEY_B)), app)).status).toBe(200);
    // The rate-limit key is the fingerprint id, never the key.
    expect(h.logLines.join('\n')).toContain('"reject":"rate_limit_passthrough_key"');
  });

  it('applies the per-IP limit before the key is validated', async () => {
    const app = limitedApp({ ip: { requests: 1, perSeconds: 60 } });
    expect((await h.send(post(key(NR_KEY)), app)).status).toBe(200);
    const before = h.nerdGraph.calls.length;
    expect((await h.send(post(key(NR_KEY_B)), app)).status).toBe(429);
    expect(h.nerdGraph.calls.length).toBe(before);
  });

  it('charges refused keys to the per-IP failure throttle, which then stops valid keys too', async () => {
    const app = limitedApp({ authFailures: { requests: 3, perSeconds: 300 } });
    for (let i = 0; i < 3; i++) {
      expect((await h.send(post(key('NRAK-UNKNOWNTESTKEY0123456789ABC')), app)).status).toBe(401);
    }
    await vi.waitFor(async () => {
      expect((await h.send(post(key(NR_KEY)), app)).status).toBe(429);
    });
  });
});

describe('audit (P2-16)', () => {
  const tools = async (app: App, k: string): Promise<void> => {
    const client = await connectPt(app, k, 'modern');
    await client.callTool({ name: 'whoami', arguments: {} });
    await client.callTool({
      name: 'run_nrql',
      arguments: { nrql: "SELECT count(*) FROM Transaction WHERE name = 'secret-value' SINCE 1 hour ago" },
    });
    await client.close();
  };
  const toolRows = async () => {
    let rows = (await h.auditRows()).filter((r) => r.kind === 'tool_call');
    await vi.waitFor(async () => {
      rows = (await h.auditRows()).filter((r) => r.kind === 'tool_call');
      if (rows.length < 2) throw new Error('rows not written yet');
    });
    return rows;
  };

  it('writes one tool_call row per call with the key fingerprint id as the actor, never the key', async () => {
    await tools(ptApp(), NR_KEY);
    const rows = await toolRows();
    expect(rows.map((r) => r.action).sort()).toEqual(['run_nrql', 'whoami']);
    for (const r of rows) {
      expect(r.keyId).toMatch(/^pt_[0-9a-f]{12}$/);
      expect(r).toMatchObject({ status: 'ok', grantId: null, tokenId: null, userId: null, projectId: null });
      expect(r.details).toMatchObject({ mode: 'passthrough', region: 'US' });
      expect(r.durationMs).not.toBeNull();
    }
    expect(new Set(rows.map((r) => r.keyId)).size).toBe(1);
    const q = rows.find((r) => r.action === 'run_nrql');
    expect(q?.accountIds).not.toBeNull();
    // afterEach: the leak scan covers the rows.
  });

  it('distinguishes keys', async () => {
    const app = ptApp();
    await tools(app, NR_KEY);
    await tools(app, NR_KEY_B);
    await vi.waitFor(async () => {
      if ((await h.auditRows()).filter((r) => r.kind === 'tool_call').length < 4) throw new Error('wait');
    });
    const rows = (await h.auditRows()).filter((r) => r.kind === 'tool_call');
    expect(new Set(rows.map((r) => r.keyId)).size).toBe(2);
  });

  it('audits a rate-limited pass-through request with the key id', async () => {
    const limits = createRateLimitHooks({
      limiter: new MemoryRateLimiter({ clock: h.world.clock }),
      preAuthLimiter: new MemoryRateLimiter({ clock: h.world.clock }),
      rules: { ip: null, passthroughKey: { requests: 1, perSeconds: 60 } },
      getClientIp: () => '203.0.113.9',
    });
    const app = h.makeApp({ passthrough: {}, hooks: mergeHooks(limits, h.recorderHooks) });
    expect((await h.send(post(key(NR_KEY)), app)).status).toBe(200);
    expect((await h.send(post(key(NR_KEY)), app)).status).toBe(429);
    await vi.waitFor(async () => {
      const row = (await h.auditRows()).find((r) => r.action === 'request.rejected');
      expect(row?.keyId).toMatch(/^pt_[0-9a-f]{12}$/);
      expect(row?.errorCode).toBe('rate_limit_passthrough_key');
    });
  });

  it('can be filtered through the admin audit API', async () => {
    const app = ptApp();
    await tools(app, NR_KEY);
    const rows = await toolRows();
    const keyId = rows[0]?.keyId as string;
    const get = async (qs: string) => {
      const res = await h.send(
        new Request(`http://localhost/api/admin/v1/audit?${qs}`, {
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        }),
        app,
      );
      expect(res.status).toBe(200);
      return (JSON.parse(res.text) as { data: { keyId: string | null }[] }).data;
    };
    expect((await get(`keyId=${keyId}`)).length).toBe(2);
    expect((await get('keyId=any')).every((r) => r.keyId !== null)).toBe(true);
    expect((await get('keyId=pt_000000000000')).length).toBe(0);
    const bad = await h.send(
      new Request('http://localhost/api/admin/v1/audit?keyId=NRAK-nope', {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      app,
    );
    expect(bad.status).toBe(400);
  });
});

describe('helpers', () => {
  it('reads the headers: key wrapped in a Secret, region defaulting to US', () => {
    const ok = readPassthroughHeaders(` ${NR_KEY} `, undefined);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.region).toBe('US');
      expect(String(ok.key)).not.toContain('NRAK');
      expect(JSON.stringify(ok)).not.toContain(NR_KEY);
    }
    expect(readPassthroughHeaders(NR_KEY, ' jp ')).toMatchObject({ ok: true, region: 'JP' });
    expect(readPassthroughHeaders(null, null)).toEqual({ ok: false, reason: 'passthrough_missing_key' });
    expect(readPassthroughHeaders('NRAK-short', null)).toEqual({
      ok: false,
      reason: 'passthrough_malformed_key',
    });
    expect(readPassthroughHeaders(`NRAK-${'A'.repeat(65)}`, null)).toMatchObject({ ok: false });
    expect(readPassthroughHeaders(NR_KEY, 'XX')).toEqual({ ok: false, reason: 'passthrough_bad_region' });
  });

  it('fingerprints are keyed: stable within an instance, different across instances and regions', async () => {
    const a = new KeyFingerprinter();
    const b = new KeyFingerprinter();
    const k = new Secret(NR_KEY);
    const fa = await a.fingerprint(k, 'US');
    expect(fa).toMatch(/^[0-9a-f]{64}$/);
    expect(await a.fingerprint(k, 'US')).toBe(fa);
    expect(await a.fingerprint(k, 'EU')).not.toBe(fa);
    expect(await b.fingerprint(k, 'US')).not.toBe(fa);
    const shared = new Secret('s'.repeat(32));
    expect(await new KeyFingerprinter(shared).fingerprint(k, 'US')).toBe(
      await new KeyFingerprinter(shared).fingerprint(k, 'US'),
    );
  });

  it('bounds the identity cache and expires entries', () => {
    const cache = new IdentityCache(1000, 2);
    cache.set('a', [1], 0);
    cache.set('b', [2], 0);
    cache.set('c', [3], 0);
    expect(cache.size).toBe(2);
    expect(cache.get('a', 0)).toBeUndefined();
    expect(cache.get('c', 999)).toEqual([3]);
    expect(cache.get('c', 1000)).toBeUndefined();
    const off = new IdentityCache(0, 2);
    off.set('a', [1], 0);
    expect(off.get('a', 0)).toBeUndefined();
  });

  it('keeps only positive, unique, sorted account ids', () => {
    expect(reachableAccounts([{ id: 3 }, { id: 1 }, { id: 3 }, { id: -1 }, { id: 1.5 }])).toEqual([1, 3]);
    expect(reachableAccounts(undefined)).toEqual([]);
  });

  it('recognises loopback hosts only', () => {
    for (const host of ['localhost', 'localhost:8787', '127.0.0.1:1', '[::1]:8787', 'LOCALHOST']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ['mcp.example.com', '127.0.0.2', 'localhost.example.com', '', undefined, 'a b']) {
      expect(isLoopbackHost(host), String(host)).toBe(false);
    }
  });
});
