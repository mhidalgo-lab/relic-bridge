// SPDX-License-Identifier: Apache-2.0
// P8-65: outbound requests that carry a credential never follow a redirect, on Node's real fetch. A local "upstream"
// answers 307 to a second local server; the second one must never be reached (it would receive the key).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createBudget,
  createLogger,
  ErrorCode,
  IDENTITY_QUERY,
  NerdGraphClient,
  RbError,
  Secret,
  unboundedLimiter,
} from '@relic-bridge/core';
import { createTelemetry } from '@relic-bridge/http-app';
import { afterEach, describe, expect, it } from 'vitest';

const FAKE_KEY = `NRAK-${'A'.repeat(27)}`;

interface Pair {
  readonly upstream: string;
  readonly upstreamHits: () => number;
  readonly elsewhereHits: () => number;
}

const servers: Server[] = [];
const listen = async (server: Server): Promise<string> => {
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

async function redirectingPair(): Promise<Pair> {
  let elsewhere = 0;
  let upstream = 0;
  const target = await listen(
    createServer((req, res) => {
      elsewhere++;
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":{}}');
    }),
  );
  const origin = await listen(
    createServer((req, res) => {
      upstream++;
      req.resume();
      res.writeHead(307, { location: `${target}/elsewhere` }).end();
    }),
  );
  return { upstream: origin, upstreamHits: () => upstream, elsewhereHits: () => elsewhere };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((ok) => s.close(ok))));
});

describe('credentialed requests do not follow redirects (Node fetch)', () => {
  it('NerdGraph: a 307 is refused once, without a retry, and never reaches the redirect target', async () => {
    const pair = await redirectingPair();
    const client = new NerdGraphClient({
      credential: { id: 'cred-1', region: 'US', apiKey: new Secret(FAKE_KEY) },
      budget: createBudget(10),
      limiter: unboundedLimiter,
      logger: createLogger({ level: 'error', sink: () => {} }),
      clock: { now: () => Date.now() },
      maxResponseBytes: 64 * 1024,
      // The real global fetch, pointed at the local upstream instead of api.newrelic.com.
      fetch: (_url, init) => fetch(`${pair.upstream}/graphql`, init),
    });
    const error = await client.query(IDENTITY_QUERY, { scope: 'IN_REGION' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RbError);
    expect((error as RbError).code).toBe(ErrorCode.NerdGraphError);
    expect((error as RbError).message).toMatch(/redirect/);
    expect(pair.upstreamHits()).toBe(1);
    expect(pair.elsewhereHits()).toBe(0);
  });

  it('OTLP export: a redirect fails the export and the header is never sent elsewhere', async () => {
    const pair = await redirectingPair();
    const t = createTelemetry({
      endpoint: pair.upstream,
      headers: { 'api-key': 'fake-license-key' },
      runtime: 'node',
      logger: createLogger({ level: 'error', sink: () => {} }),
    });
    await t.hooks.onToolCall?.({} as never, { projectSlug: 'prod' } as never, {
      tool: 'whoami',
      status: 'ok',
      errorCode: null,
      durationMs: 1,
      input: {},
      meta: undefined,
    });
    expect(pair.upstreamHits()).toBeGreaterThan(0);
    expect(pair.elsewhereHits()).toBe(0);
  });
});
