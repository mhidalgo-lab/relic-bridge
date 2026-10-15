// SPDX-License-Identifier: Apache-2.0
// No token forwarding (P8-76, THREAT_MODEL T12): whatever credential a client presents to relic-bridge (a device token,
// an OAuth access token, a session cookie) stays here. Every outbound request the app makes while serving it (NerdGraph,
// the Client ID Metadata Document fetch, the OTLP export) is recorded, and none carries an `Authorization` or `Cookie`
// header or any of those values anywhere in its URL, headers or body. `passthrough.test.ts` covers the pass-through
// route, where the caller's New Relic key is meant to travel.
import type { Client } from '@modelcontextprotocol/client';
import type { FetchLike } from '@relic-bridge/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTelemetry, mergeHooks, type Telemetry } from '../src/index.ts';
import { ADMIN_TOKEN, createHarness, type Harness } from './authz/harness.ts';
import {
  CLAUDE_AI_CALLBACK,
  CLAUDE_AI_ID,
  claudeAiDoc,
  consentStandIn,
  jsonDoc,
  Client as OAuthClient,
} from './authz/oauth-suite.ts';
import { connect, NR_KEY } from './fixtures.ts';

interface Outbound {
  readonly kind: 'nerdgraph' | 'cimd' | 'otlp';
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

const OTLP_KEY = 'otlp-fake-license-key';

let h: Harness;
let outbound: Outbound[];
let telemetry: Telemetry;
let clients: Client[];

const record = (kind: Outbound['kind'], url: unknown, init?: RequestInit | { signal: AbortSignal }): void => {
  const i = (init ?? {}) as RequestInit;
  outbound.push({
    kind,
    url: String(url),
    headers: new Headers(i.headers),
    body: typeof i.body === 'string' ? i.body : i.body == null ? '' : '[binary]',
  });
};

beforeEach(async () => {
  h = await createHarness();
  // The OAuth provider reads `Date.now()`; keep it on the world's clock.
  vi.useFakeTimers({ toFake: ['Date'], now: h.world.clock.now() });
  outbound = [];
  clients = [];
  const otlpFetch: FetchLike = async (url, init) => {
    record('otlp', url, init);
    return new Response('{}', { status: 200 });
  };
  telemetry = createTelemetry({
    endpoint: 'https://otlp.example.test',
    headers: { 'api-key': OTLP_KEY },
    fetch: otlpFetch,
    clock: h.world.clock,
  });
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  telemetry.close();
  await h.scan();
  vi.useRealTimers();
});

describe('no token forwarding (T12)', () => {
  it('a device token, an OAuth token and a session cookie never reach NerdGraph, the CIMD fetch or the OTLP export', async () => {
    const nerdGraphFetch: FetchLike = async (url, init) => {
      record('nerdgraph', url, init);
      return h.nerdGraph.fetch(url, init);
    };
    const consent = consentStandIn();
    consent.next = { userId: 'usr_a', grantId: h.world.grantIds.prod };
    const app = h.makeApp({
      fetch: nerdGraphFetch,
      hooks: mergeHooks(h.recorderHooks, telemetry.hooks),
      oauth: {
        consent: consent.handler,
        accessTokenTtlSeconds: 600,
        clientMetadataDocuments: {
          fetch: async (url, init) => {
            record('cimd', url, init);
            return jsonDoc(claudeAiDoc())();
          },
        },
      },
    });
    const session = await h.addSession({ role: 'owner' });

    // 1. A device token (static bearer), with a session cookie riding along.
    const { token } = await h.addTenant('t12');
    const device = await connect(
      { fetch: (r: Request) => app.fetch(withCookie(r, session.cookie)) },
      't12',
      token.value,
      'modern',
    );
    clients.push(device);
    expect((await device.callTool({ name: 'whoami', arguments: {} })).isError ?? false).toBe(false);
    await device.callTool({
      name: 'run_nrql',
      arguments: { nrql: 'SELECT count(*) FROM Transaction SINCE 1 hour ago' },
    });

    // 2. An OAuth access token from a CIMD client (the metadata document is fetched by the server).
    const secrets: string[] = [];
    const oauth = new OAuthClient(h, app, secrets);
    oauth.clientId = CLAUDE_AI_ID;
    oauth.redirectUri = CLAUDE_AI_CALLBACK;
    const tokens = await oauth.tokens('prod');
    const viaOAuth = await connect(app, 'prod', tokens.access_token, 'modern');
    clients.push(viaOAuth);
    expect((await viaOAuth.callTool({ name: 'whoami', arguments: {} })).isError ?? false).toBe(false);
    await telemetry.flush();

    const kinds = new Set(outbound.map((o) => o.kind));
    expect([...kinds].sort()).toEqual(['cimd', 'nerdgraph', 'otlp']);
    const inbound = [
      token.value,
      tokens.access_token,
      tokens.refresh_token,
      session.value,
      session.csrf,
      ADMIN_TOKEN,
      ...secrets,
    ];
    for (const o of outbound) {
      const what = `${o.kind} ${o.url}`;
      expect(o.headers.has('authorization'), what).toBe(false);
      expect(o.headers.has('cookie'), what).toBe(false);
      const dump = `${o.url}\n${JSON.stringify([...o.headers])}\n${o.body}`;
      for (const secret of inbound)
        expect(dump.includes(secret), `${what} carries an inbound credential`).toBe(false);
      expect(dump).not.toMatch(/\brb_[A-Za-z0-9_-]{20,}/);
    }
    // Each destination gets only its own credential: the stored New Relic key, the OTLP header, nothing for CIMD.
    for (const o of outbound.filter((x) => x.kind === 'nerdgraph'))
      expect(o.headers.get('api-key')).toBe(NR_KEY);
    for (const o of outbound.filter((x) => x.kind === 'otlp'))
      expect(o.headers.get('api-key')).toBe(OTLP_KEY);
    for (const o of outbound.filter((x) => x.kind === 'cimd')) expect([...o.headers]).toEqual([]);
  });
});

function withCookie(request: Request, cookie: string): Request {
  const headers = new Headers(request.headers);
  headers.set('cookie', cookie);
  return new Request(request, { headers });
}
