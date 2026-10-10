// SPDX-License-Identifier: Apache-2.0
import { createGrant, issueAccessToken } from '@relic-bridge/auth';
import { createLogger } from '@relic-bridge/core';
import type { Context } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHttpApp,
  createRateLimitHooks,
  type HttpAppHooks,
  type HttpAppOptions,
  type McpRequestInfo,
  MemoryRateLimiter,
  mergeHooks,
  normalizeClientIp,
  type RateLimiter,
  rateLimited,
  resolveClientIp,
} from '../src/index.ts';
import {
  CATALOG,
  connect,
  ManualClock,
  mockNerdGraph,
  NR_KEY,
  seedWorld,
  T0,
  type World,
} from './fixtures.ts';

describe('MemoryRateLimiter (token bucket)', () => {
  const rule = { requests: 3, perSeconds: 3 }; // 1 token per second, burst 3
  let clock: ManualClock;
  let rl: MemoryRateLimiter;
  beforeEach(() => {
    clock = new ManualClock();
    rl = new MemoryRateLimiter({ clock, maxKeys: 4 });
  });

  it('allows a burst up to capacity, then refuses with a retry time', () => {
    expect([1, 2, 3].map(() => rl.take('a', rule).allowed)).toEqual([true, true, true]);
    const refused = rl.take('a', rule);
    expect(refused).toEqual({ allowed: false, retryAfterMs: 1000, remaining: 0 });
  });

  it('refills continuously, never above capacity', () => {
    for (let i = 0; i < 3; i++) rl.take('a', rule);
    clock.advance(500);
    expect(rl.take('a', rule)).toMatchObject({ allowed: false, retryAfterMs: 500 });
    clock.advance(500);
    expect(rl.take('a', rule).allowed).toBe(true);
    clock.advance(1_000_000);
    expect(rl.take('a', rule).remaining).toBe(2);
  });

  it('a refused take consumes nothing; peek never consumes', () => {
    for (let i = 0; i < 3; i++) rl.take('a', rule);
    for (let i = 0; i < 5; i++) rl.take('a', rule);
    clock.advance(1000);
    expect(rl.peek('a', rule).allowed).toBe(true);
    expect(rl.peek('a', rule).allowed).toBe(true);
    expect(rl.take('a', rule).allowed).toBe(true);
    expect(rl.peek('a', rule).allowed).toBe(false);
  });

  it('peek on an unknown key allocates nothing', () => {
    expect(rl.peek('ghost', rule)).toMatchObject({ allowed: true, remaining: 3 });
    expect(rl.size).toBe(0);
  });

  it('supports cost, and a cost above capacity is never allowed', () => {
    expect(rl.take('a', rule, 2).allowed).toBe(true);
    expect(rl.take('a', rule, 2)).toMatchObject({ allowed: false, retryAfterMs: 1000 });
    expect(rl.take('b', rule, 4)).toMatchObject({ allowed: false, retryAfterMs: Number.POSITIVE_INFINITY });
    expect(rl.size).toBe(1);
  });

  it('keys are independent', () => {
    for (let i = 0; i < 3; i++) rl.take('a', rule);
    expect(rl.take('a', rule).allowed).toBe(false);
    expect(rl.take('b', rule).allowed).toBe(true);
  });

  it('applies a changed rule to an existing bucket (capacity re-capped)', () => {
    for (let i = 0; i < 3; i++) rl.take('a', rule);
    clock.advance(100_000);
    const tighter = { requests: 1, perSeconds: 60 };
    expect(rl.take('a', tighter).allowed).toBe(true);
    expect(rl.take('a', tighter).allowed).toBe(false);
  });

  it('a clock that goes backwards does not refill or throw', () => {
    for (let i = 0; i < 3; i++) rl.take('a', rule);
    clock.advance(-60_000);
    expect(rl.take('a', rule).allowed).toBe(false);
  });

  it('rejects invalid rules and costs', () => {
    expect(() => rl.take('a', { requests: 0, perSeconds: 1 })).toThrow(RangeError);
    expect(() => rl.take('a', { requests: 1, perSeconds: 1.5 })).toThrow(RangeError);
    expect(() => rl.take('a', rule, 0)).toThrow(RangeError);
    expect(() => rl.take('a', rule, Number.NaN)).toThrow(RangeError);
    expect(() => new MemoryRateLimiter({ maxKeys: 0 })).toThrow(RangeError);
  });

  it('is bounded: when nothing is idle the least recently used bucket goes', () => {
    for (const k of ['a', 'b', 'c', 'd']) rl.take(k, rule, 3);
    rl.take('a', rule, 0.5); // refused (drained) but touched: a is now the most recently used
    rl.take('e', rule, 1);
    expect(rl.size).toBe(4);
    expect(rl.take('b', rule, 3).allowed).toBe(true); // b was evicted: starts fresh
    expect(rl.take('a', rule, 3).allowed).toBe(false); // a kept its debt
  });

  it('prefers evicting a fully refilled bucket over a drained one', () => {
    rl.take('drained1', rule, 3);
    rl.take('idle', { requests: 3, perSeconds: 3 }, 1);
    rl.take('drained2', rule, 3);
    rl.take('drained3', rule, 3);
    clock.advance(2000); // idle is full again; the drained ones are at 2/3
    rl.take('new', rule, 1);
    expect(rl.size).toBe(4);
    expect(rl.take('drained1', rule, 3).allowed).toBe(false); // survived, debt intact
  });

  it('stays bounded under a flood of distinct keys', () => {
    for (let i = 0; i < 1000; i++) rl.take(`ip:${i}`, rule);
    expect(rl.size).toBeLessThanOrEqual(4);
  });
});

describe('client IP', () => {
  it('normalises IPv4, IPv4-mapped IPv6 and buckets IPv6 by /64', () => {
    expect(normalizeClientIp('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeClientIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeClientIp('::ffff:cb00:7107')).toBe('203.0.113.7');
    expect(normalizeClientIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(normalizeClientIp('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(normalizeClientIp('[2001:db8::1]')).toBe('2001:db8:0:0::/64');
    expect(normalizeClientIp('::1')).toBe('0:0:0:0::/64');
  });

  it('never makes a key from text that is not an address', () => {
    for (const bad of [
      '',
      'unknown',
      '1.2.3',
      '999.1.1.1',
      '1.2.3.4, 5.6.7.8',
      'a'.repeat(300),
      '::g',
      '1::2::3',
      null,
      undefined,
    ]) {
      expect(normalizeClientIp(bad)).toBeNull();
    }
  });

  it('ignores X-Forwarded-For unless proxies are trusted, then counts hops from the right', () => {
    const xff = '6.6.6.6, 198.51.100.9, 10.0.0.2';
    expect(resolveClientIp({ socketIp: '10.0.0.1', forwardedFor: xff })).toBe('10.0.0.1');
    expect(resolveClientIp({ socketIp: '10.0.0.1', forwardedFor: xff, trustedProxyHops: 1 })).toBe(
      '10.0.0.2',
    );
    expect(resolveClientIp({ socketIp: '10.0.0.1', forwardedFor: xff, trustedProxyHops: 2 })).toBe(
      '198.51.100.9',
    );
    // Fewer entries than hops, or garbage where the client should be: fall back to the socket.
    expect(resolveClientIp({ socketIp: '10.0.0.1', forwardedFor: '1.1.1.1', trustedProxyHops: 3 })).toBe(
      '10.0.0.1',
    );
    expect(resolveClientIp({ socketIp: '10.0.0.1', forwardedFor: 'evil', trustedProxyHops: 1 })).toBe(
      '10.0.0.1',
    );
    expect(resolveClientIp({ socketIp: undefined })).toBeNull();
  });
});

describe('rateLimited response', () => {
  it('is a 429 JSON-RPC error with a whole-second Retry-After (at least 1, capped)', async () => {
    const r = rateLimited(1200);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('2');
    const body = (await r.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/Slow down/);
    expect(rateLimited(0).headers.get('retry-after')).toBe('1');
    expect(rateLimited(Number.POSITIVE_INFINITY).headers.get('retry-after')).toBe('86400');
  });
});

describe('mergeHooks', () => {
  it('runs before-hooks in order (first Response wins) and runs every on/after hook', async () => {
    const seen: string[] = [];
    const h = mergeHooks(
      {
        beforeAuth: () => void seen.push('a1'),
        onAuthFailure: () => {
          seen.push('f1');
          throw new Error('boom');
        },
      },
      undefined,
      {
        beforeAuth: () => new Response('stop', { status: 429 }),
        onAuthFailure: () => void seen.push('f2'),
      },
      { beforeAuth: () => void seen.push('never') },
    );
    expect((await h.beforeAuth?.({} as Context, 'r', 'mcp_token'))?.status).toBe(429);
    h.onAuthFailure?.({} as Context, { requestId: 'r', reason: 'x' });
    expect(seen).toEqual(['a1', 'f1', 'f2']);
  });

  it('refuseAuthFailure: the first Response wins and a throwing hook is skipped', async () => {
    const seen: string[] = [];
    const h = mergeHooks(
      {
        refuseAuthFailure: () => {
          seen.push('r1');
          throw new Error('boom');
        },
      },
      { refuseAuthFailure: () => new Response('stop', { status: 429 }) },
      { refuseAuthFailure: () => void seen.push('never') },
    );
    expect((await h.refuseAuthFailure?.({} as Context, { requestId: 'r', reason: 'x' }))?.status).toBe(429);
    expect(seen).toEqual(['r1']);
  });
});

// ---------------------------------------------------------------------------------------------------------------

let world: World;
let logLines: string[];

beforeEach(async () => {
  world = await seedWorld();
  logLines = [];
});

afterEach(() => {
  const all = logLines.join('\n');
  expect(all).not.toContain(NR_KEY);
  for (const token of Object.values(world.tokens)) expect(all).not.toContain(token);
});

function makeApp(hooks: HttpAppHooks, over: Partial<HttpAppOptions> = {}) {
  return createHttpApp({
    storage: world.storage,
    keyring: world.keyring,
    clock: world.clock,
    fetch: mockNerdGraph().fetch,
    logger: createLogger({ level: 'debug', sink: (l) => logLines.push(l), now: () => world.clock.now() }),
    hooks,
    ...over,
  });
}

const post = (token: string | undefined, headers: Record<string, string> = {}, body?: unknown) =>
  new Request('http://localhost/p/prod/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: JSON.stringify(
      body ?? {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      },
    ),
  });

/** The client IP of a test request comes from a header (the host would use the socket). */
const ipFromHeader = (c: Context): string | null => normalizeClientIp(c.req.header('x-test-ip'));

function hooksFor(rules: Parameters<typeof createRateLimitHooks>[0]['rules'], clock = world.clock) {
  const limiter = new MemoryRateLimiter({ clock });
  const preAuthLimiter = new MemoryRateLimiter({ clock });
  return {
    limiter,
    preAuthLimiter,
    hooks: createRateLimitHooks({
      limiter,
      preAuthLimiter,
      rules,
      getClientIp: ipFromHeader,
      logger: createLogger({ level: 'debug', sink: (l) => logLines.push(l) }),
    }),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const none = { ip: null, authFailures: null, token: null, grant: null };

describe('auth-failure throttling (T1)', () => {
  const rules = { ...none, authFailures: { requests: 3, perSeconds: 30 } };

  it('refuses further failures from an IP after N, and recovers', async () => {
    const app = makeApp(hooksFor(rules).hooks);
    const bad = `rb_live_${'x'.repeat(40)}`;
    for (let i = 0; i < 3; i++) {
      expect((await app.fetch(post(bad, { 'x-test-ip': '203.0.113.1' }))).status).toBe(401);
      await tick();
    }
    const blockedBad = await app.fetch(post(bad, { 'x-test-ip': '203.0.113.1' }));
    const blockedNone = await app.fetch(post(undefined, { 'x-test-ip': '203.0.113.1' }));
    for (const r of [blockedBad, blockedNone]) {
      expect(r.status).toBe(429);
      expect(Number(r.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    }
    // Same body whatever the failure was (T19).
    expect(await blockedBad.text()).toBe(await blockedNone.text());
    // Other IPs are unaffected.
    expect((await app.fetch(post(bad, { 'x-test-ip': '203.0.113.2' }))).status).toBe(401);
    // Recovery: one failure per 10 s.
    world.clock.advance(10_000);
    expect((await app.fetch(post(bad, { 'x-test-ip': '203.0.113.1' }))).status).toBe(401);
    expect((await app.fetch(post(bad, { 'x-test-ip': '203.0.113.1' }))).status).toBe(429);
  });

  it('never locks out a valid token: served from an IP that sprayed bad tokens (P3-13, review M6)', async () => {
    const lim = hooksFor(rules);
    const app = makeApp(lim.hooks);
    const ip = { 'x-test-ip': '203.0.113.1' };
    for (let i = 0; i < 20; i++) {
      await app.fetch(post(`rb_live_${'y'.repeat(30)}${i}`, ip));
      await tick();
    }
    expect((await app.fetch(post('rb_live_nope', ip))).status).toBe(429);
    // The valid token goes through, again and again, while the IP stays locked for failures.
    for (let i = 0; i < 5; i++) expect((await app.fetch(post(world.tokens.prod, ip))).status).toBe(200);
    // A token that is valid but not granted on this project is a failure like any other.
    const other = await app.fetch(new Request('http://localhost/p/eu/mcp', post(world.tokens.prod, ip)));
    expect(other.status).toBe(429);
    expect(lim.preAuthLimiter.peek('fail:203.0.113.1', rules.authFailures).allowed).toBe(false);
  });

  it('an expired token keeps failing (and charging) from a locked IP; the live one is served', async () => {
    const app = makeApp(hooksFor(rules).hooks);
    const ip = { 'x-test-ip': '203.0.113.7' };
    world.clock.advance(10_001); // `shortLived` has expired
    for (let i = 0; i < 3; i++) {
      expect((await app.fetch(post(world.tokens.shortLived, ip))).status).toBe(401);
      await tick();
    }
    expect((await app.fetch(post(world.tokens.shortLived, ip))).status).toBe(429);
    world.clock.advance(10_000); // one failure refilled
    expect((await app.fetch(post(world.tokens.shortLived, ip))).status).toBe(401);
    expect((await app.fetch(post(world.tokens.shortLived, ip))).status).toBe(429);
    expect((await app.fetch(post(world.tokens.prod, ip))).status).toBe(200);
  });

  it('does not count successful requests, and a 429 is not itself a charge', async () => {
    const lim = hooksFor(rules);
    const app = makeApp(lim.hooks);
    for (let i = 0; i < 10; i++) {
      expect((await app.fetch(post(world.tokens.prod, { 'x-test-ip': '203.0.113.1' }))).status).toBe(200);
    }
    expect(lim.preAuthLimiter.peek('fail:203.0.113.1', rules.authFailures).remaining).toBe(3);
  });

  it('a different IPv6 address in the same /64 shares the bucket', async () => {
    const app = makeApp(hooksFor(rules).hooks);
    for (let i = 0; i < 3; i++) {
      await app.fetch(post('rb_live_nope', { 'x-test-ip': `2001:db8:1:2::${i + 1}` }));
      await tick();
    }
    const r = await app.fetch(post('rb_live_nope', { 'x-test-ip': '2001:db8:1:2:ffff::9' }));
    expect(r.status).toBe(429);
  });

  it('unknown client addresses share one bucket instead of bypassing the limit', async () => {
    const app = makeApp(hooksFor(rules).hooks);
    for (let i = 0; i < 3; i++) {
      await app.fetch(post('rb_live_nope', { 'x-test-ip': 'not-an-ip' }));
      await tick();
    }
    expect((await app.fetch(post('rb_live_nope'))).status).toBe(429);
  });

  it('X-Forwarded-For cannot be used to dodge or to frame an IP (no trusted proxy)', async () => {
    const limiter = new MemoryRateLimiter({ clock: world.clock });
    const hooks = createRateLimitHooks({
      limiter,
      rules,
      getClientIp: (c) =>
        resolveClientIp({ socketIp: '192.0.2.50', forwardedFor: c.req.header('x-forwarded-for') }),
    });
    const app = makeApp(hooks);
    for (let i = 0; i < 3; i++) {
      await app.fetch(post('rb_live_nope', { 'x-forwarded-for': `9.9.9.${i}` }));
      await tick();
    }
    expect((await app.fetch(post('rb_live_nope', { 'x-forwarded-for': '8.8.8.8' }))).status).toBe(429);
    expect(limiter.peek('fail:9.9.9.1', rules.authFailures).remaining).toBe(3);
  });
});

describe('per-IP request limit', () => {
  it('limits all requests per IP before authentication', async () => {
    const app = makeApp(hooksFor({ ...none, ip: { requests: 2, perSeconds: 60 } }).hooks);
    const h = { 'x-test-ip': '198.51.100.4' };
    expect((await app.fetch(post(undefined, h))).status).toBe(401);
    expect((await app.fetch(post(world.tokens.prod, h))).status).toBe(200);
    const r = await app.fetch(post(world.tokens.prod, h));
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('30');
    expect((await app.fetch(post(world.tokens.prod, { 'x-test-ip': '198.51.100.5' }))).status).toBe(200);
  });
});

describe('per-token and per-grant limits', () => {
  it('limits a token over HTTP with an SDK client; other tokens of the grant are unaffected until the grant limit', async () => {
    const app = makeApp(hooksFor({ ...none, token: { requests: 2, perSeconds: 60 } }).hooks);
    const client = await connect(app, 'prod', world.tokens.prod, 'modern');
    let refused: unknown;
    for (let i = 0; i < 10 && refused === undefined; i++) {
      await client.callTool({ name: 'whoami', arguments: {} }).catch((e: unknown) => (refused = e));
    }
    expect(String(refused)).toMatch(/Rate limit|429/);
    await client.close();
    // Another token (other grant) is unaffected.
    const other = await app.fetch(post(world.tokens.limited));
    expect(other.status).toBe(200);
  });

  it('answers 429 with Retry-After and a slow-down message', async () => {
    const app = makeApp(hooksFor({ ...none, token: { requests: 1, perSeconds: 10 } }).hooks);
    expect((await app.fetch(post(world.tokens.prod))).status).toBe(200);
    const r = await app.fetch(post(world.tokens.prod));
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('10');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/Slow down/);
    world.clock.advance(10_000);
    expect((await app.fetch(post(world.tokens.prod))).status).toBe(200);
  });

  it("uses the grant's own rateLimit instead of the default", async () => {
    const { grant } = await createGrant(
      world.storage,
      { projectId: world.projectIds.prod, label: 'slow', rateLimit: { requests: 2, perSeconds: 60 } },
      CATALOG,
      T0,
    );
    const slow = (
      await issueAccessToken(world.storage, { grantId: grant.id, label: 't' }, T0)
    ).token.reveal();
    const other = (
      await issueAccessToken(world.storage, { grantId: grant.id, label: 't2' }, T0)
    ).token.reveal();
    const app = makeApp(hooksFor({ ...none, grant: { requests: 100, perSeconds: 60 } }).hooks);
    expect((await app.fetch(post(slow))).status).toBe(200);
    expect((await app.fetch(post(other))).status).toBe(200);
    // Two tokens, one grant: the grant bucket is shared.
    expect((await app.fetch(post(slow))).status).toBe(429);
    expect((await app.fetch(post(other))).status).toBe(429);
    // The unlimited default grant is untouched.
    expect((await app.fetch(post(world.tokens.prod))).status).toBe(200);
  });

  it('does not count subscriptions/listen', async () => {
    const app = makeApp(hooksFor({ ...none, token: { requests: 1, perSeconds: 60 } }).hooks);
    const listen = () =>
      app.fetch(
        post(
          world.tokens.prod,
          { 'mcp-method': 'subscriptions/listen' },
          { jsonrpc: '2.0', id: 1, method: 'subscriptions/listen', params: {} },
        ),
      );
    for (let i = 0; i < 5; i++) expect((await listen()).status).not.toBe(429);
    expect((await app.fetch(post(world.tokens.prod))).status).toBe(200);
    expect((await app.fetch(post(world.tokens.prod))).status).toBe(429);
  });

  it('counts a request whose header claims subscriptions/listen but whose body is a tool call (P2-12)', async () => {
    const ng = mockNerdGraph();
    const app = makeApp(hooksFor({ ...none, token: { requests: 1, perSeconds: 60 } }).hooks, {
      fetch: ng.fetch,
    });
    const spoofed = () =>
      app.fetch(
        post(
          world.tokens.prod,
          { 'mcp-method': 'subscriptions/listen', 'mcp-protocol-version': '2025-11-25' },
          { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
        ),
      );
    expect((await spoofed()).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await spoofed()).status).toBe(429);
    const calls = ng.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect((await spoofed()).status).toBe(429);
    expect(ng.calls.length).toBe(calls);
  });

  it('refuses JSON-RPC batches (one request is one call for the limits and the audit)', async () => {
    const ng = mockNerdGraph();
    const app = makeApp(hooksFor({ ...none, token: { requests: 5, perSeconds: 60 } }).hooks, {
      fetch: ng.fetch,
    });
    const call = (id: number) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    });
    const res = await app.fetch(
      post(world.tokens.prod, { 'mcp-protocol-version': '2025-03-26' }, [call(1), call(2), call(3)]),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });
    expect(ng.calls).toEqual([]);
  });

  it('a 429 never reaches the credential or NerdGraph', async () => {
    const ng = mockNerdGraph();
    const app = makeApp(hooksFor({ ...none, token: { requests: 1, perSeconds: 60 } }).hooks, {
      fetch: ng.fetch,
    });
    await app.fetch(post(world.tokens.prod));
    const before = ng.calls.length;
    await app.fetch(post(world.tokens.prod));
    expect(ng.calls.length).toBe(before);
  });
});

describe('limiter failures', () => {
  it('fail open and are logged, without breaking authentication', async () => {
    const broken: RateLimiter = {
      take: () => Promise.reject(new Error('store down')),
      peek: () => {
        throw new Error('store down');
      },
    };
    const hooks = createRateLimitHooks({
      limiter: broken,
      getClientIp: ipFromHeader,
      logger: createLogger({ level: 'debug', sink: (l) => logLines.push(l) }),
    });
    const app = makeApp(hooks);
    expect((await app.fetch(post(world.tokens.prod, { 'x-test-ip': '203.0.113.1' }))).status).toBe(200);
    expect((await app.fetch(post('rb_live_nope', { 'x-test-ip': '203.0.113.1' }))).status).toBe(401);
    expect(logLines.some((l) => l.includes('rate limiter failed'))).toBe(true);
  });
});

describe('defaults', () => {
  it('apply when no rules are given (IP 600/min, failures 10 per 5 min)', async () => {
    const limiter = new MemoryRateLimiter({ clock: world.clock });
    const app = makeApp(createRateLimitHooks({ limiter, getClientIp: () => '203.0.113.1' }));
    for (let i = 0; i < 10; i++) {
      await app.fetch(post('rb_live_nope'));
      await tick();
    }
    expect((await app.fetch(post('rb_live_nope'))).status).toBe(429);
    expect((await app.fetch(post(world.tokens.prod))).status).toBe(200);
  });
});

describe('write bucket charging by round (P7-35)', () => {
  const rounds = ['dry_run', 'question', 'answered', 'confirm'] as const;
  const info = (writeRound: McpRequestInfo['writeRound'], grantId = 'grt_w') =>
    ({
      tokenId: 'tok_w',
      grantId,
      listen: false,
      mcpMethod: 'tools/call',
      mcpName: 'close_issue',
      ...(writeRound === undefined ? {} : { writeRound }),
      access: { tools: ['close_issue', 'whoami'], rateLimit: null },
    }) as unknown as McpRequestInfo;
  const c = { get: () => undefined } as never;
  const make = (write: number) => {
    const limiter = new MemoryRateLimiter({ clock: new ManualClock() });
    const hooks = createRateLimitHooks({
      limiter,
      rules: {
        ip: null,
        authFailures: null,
        token: null,
        grant: null,
        write: { requests: write, perSeconds: 3600 },
      },
      getClientIp: () => '203.0.113.7',
    });
    return { hooks, limiter };
  };
  const remaining = (limiter: MemoryRateLimiter) =>
    limiter.peek('write:grt_w', { requests: 100, perSeconds: 3600 }).remaining;

  it('charges exactly the rounds that can reach a mutation', async () => {
    for (const round of rounds) {
      const { hooks, limiter } = make(100);
      expect(await hooks.beforeMcp?.(c, info(round))).toBeUndefined();
      const charged = round === 'answered' || round === 'confirm';
      expect(remaining(limiter), round).toBe(charged ? 99 : 100);
    }
  });

  it('a call with no classification is charged (fail closed)', async () => {
    const { hooks, limiter } = make(100);
    await hooks.beforeMcp?.(c, info(undefined));
    await hooks.beforeMcp?.(c, info(null));
    expect(remaining(limiter)).toBe(98);
  });

  it('elicitation: the question round plus the answered round cost one unit', async () => {
    const { hooks } = make(2);
    for (let write = 0; write < 2; write++) {
      expect(await hooks.beforeMcp?.(c, info('question'))).toBeUndefined();
      expect(await hooks.beforeMcp?.(c, info('answered'))).toBeUndefined();
    }
    // Two confirmed writes used the whole bucket: the next one that can mutate is refused, at either shape.
    expect((await hooks.beforeMcp?.(c, info('answered')))?.status).toBe(429);
    expect((await hooks.beforeMcp?.(c, info('confirm')))?.status).toBe(429);
  });

  it('negative: confirm: true without elicitation, and junk or empty inputResponses, are charged', async () => {
    const { hooks } = make(1);
    expect(await hooks.beforeMcp?.(c, info('confirm'))).toBeUndefined();
    expect((await hooks.beforeMcp?.(c, info('confirm')))?.status).toBe(429);
    expect((await hooks.beforeMcp?.(c, info('answered')))?.status).toBe(429);
  });

  it('negative: question-only rounds never touch the write bucket, so an exhausted bucket still refuses mutations', async () => {
    const { hooks } = make(1);
    expect(await hooks.beforeMcp?.(c, info('answered'))).toBeUndefined();
    for (let i = 0; i < 50; i++) expect(await hooks.beforeMcp?.(c, info('question'))).toBeUndefined();
    expect((await hooks.beforeMcp?.(c, info('answered')))?.status).toBe(429);
  });

  it('repeated question rounds stay bounded by the token and grant limits', async () => {
    const limiter = new MemoryRateLimiter({ clock: new ManualClock() });
    const hooks = createRateLimitHooks({
      limiter,
      rules: {
        ip: null,
        authFailures: null,
        token: { requests: 5, perSeconds: 60 },
        grant: { requests: 100, perSeconds: 60 },
        write: { requests: 1, perSeconds: 3600 },
      },
      getClientIp: () => '203.0.113.7',
    });
    const codes: (number | undefined)[] = [];
    for (let i = 0; i < 8; i++) codes.push((await hooks.beforeMcp?.(c, info('question')))?.status);
    expect(codes).toEqual([undefined, undefined, undefined, undefined, undefined, 429, 429, 429]);
    // The same bound holds for dry runs.
    const dry: (number | undefined)[] = [];
    for (let i = 0; i < 3; i++) dry.push((await hooks.beforeMcp?.(c, info('dry_run', 'grt_other')))?.status);
    expect(dry).toEqual([429, 429, 429]);
  });

  it('the limiter failing closes the charged rounds only', async () => {
    const broken: RateLimiter = {
      take: (key: string) => {
        if (key.startsWith('write:')) throw new Error('store down');
        return { allowed: true, retryAfterMs: 0, remaining: 1 };
      },
      peek: () => ({ allowed: true, retryAfterMs: 0, remaining: 1 }),
    } as unknown as RateLimiter;
    const hooks = createRateLimitHooks({
      limiter: broken,
      rules: { ip: null, authFailures: null, token: null, grant: null },
      getClientIp: () => null,
    });
    expect(await hooks.beforeMcp?.(c, info('question'))).toBeUndefined();
    expect(await hooks.beforeMcp?.(c, info('dry_run'))).toBeUndefined();
    expect((await hooks.beforeMcp?.(c, info('answered')))?.status).toBe(429);
    expect((await hooks.beforeMcp?.(c, info('confirm')))?.status).toBe(429);
  });
});
