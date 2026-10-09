// SPDX-License-Identifier: Apache-2.0
// The unauthenticated OAuth endpoints (P5-01) have their own per-IP budget (`oauth` rule) on top of the per-IP flood
// limit, and it applies to them only.
import { describe, expect, it } from 'vitest';
import { createHttpApp, createRateLimitHooks, MemoryRateLimiter } from '../src/index.ts';
import { seedWorld } from './fixtures.ts';

describe('OAuth endpoint rate limit', () => {
  it('refuses the n+1st OAuth request from one address with a 429, and leaves MCP routes to their own rules', async () => {
    const world = await seedWorld();
    const limiter = new MemoryRateLimiter({ clock: world.clock });
    const app = createHttpApp({
      storage: world.storage,
      keyring: world.keyring,
      clock: world.clock,
      hooks: createRateLimitHooks({
        limiter,
        rules: { ip: null, authFailures: null, oauth: { requests: 2, perSeconds: 60 } },
        getClientIp: () => '203.0.113.9',
      }),
      identity: {
        publicUrl: 'http://localhost',
        providers: [],
        policy: { emails: [], domains: [], githubOrgs: [], autoProvision: 'off' },
        storage: world.storage,
      },
      oauth: { consent: () => new Response(null, { status: 500 }) },
    });
    const meta = () => app.fetch(new Request('http://localhost/.well-known/oauth-authorization-server'));
    expect((await meta()).status).toBe(200);
    expect((await meta()).status).toBe(200);
    const refused = await meta();
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).not.toBeNull();
    const token = await app.fetch(
      new Request('http://localhost/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=refresh_token&refresh_token=x',
      }),
    );
    expect(token.status).toBe(429);
    const mcp = await app.fetch(
      new Request('http://localhost/p/prod/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${world.tokens.prod}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 't', version: '0' },
          },
        }),
      }),
    );
    expect(mcp.status).toBe(200);
  });
});
