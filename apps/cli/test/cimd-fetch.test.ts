// SPDX-License-Identifier: Apache-2.0
// The Node SSRF guard for client metadata documents (P5-03, T11). No network: DNS is injected, and the only server is
// a local plain-http one reached with the test-only switch. The guard decides inside the socket's `lookup`, so a
// refused host never gets a connection (the local server counts requests to prove it).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BlockedDestinationError,
  createCimdFetch,
  guardedLookup,
  type ResolvedAddress,
} from '../src/cimd-fetch.ts';

const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });
const v6 = (address: string): ResolvedAddress => ({ address, family: 6 });

let server: Server;
let port = 0;
let hits = 0;
const routes = new Map<string, (res: import('node:http').ServerResponse) => void>();

beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    // Iterate the registered handlers instead of calling one looked up by the request path.
    for (const [path, handler] of routes) {
      if (path === req.url) {
        handler(res);
        return;
      }
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  routes.set('/doc.json', (res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=600' });
    res.end('{"client_id":"x"}');
  });
  routes.set('/redirect', (res) => {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
    res.end();
  });
  routes.set('/big', (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('x'.repeat(50_000));
  });
  routes.set('/hang', () => {
    // never answers
  });
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

/** A fetcher for the local server: any host name resolves to 127.0.0.1, which the test allows. */
const local = (over: Parameters<typeof createCimdFetch>[0] = {}) =>
  createCimdFetch({
    resolve: async () => [v4('127.0.0.1')],
    allowAddress: () => true,
    allowHttpForTests: true,
    ...over,
  });

const signal = () => new AbortController().signal;

describe('guardedLookup', () => {
  const run = (addresses: readonly ResolvedAddress[], options: { all?: boolean; family?: number } = {}) =>
    new Promise<{ error: Error | null; result: unknown }>((resolve) => {
      guardedLookup(
        async () => addresses,
        (a) => !a.startsWith('10.') && a !== '127.0.0.1' && a !== '::1',
      )(
        'host.example',
        options as never,
        ((error: Error | null, address: unknown, family?: number) =>
          resolve({ error, result: options.all ? address : [address, family] })) as never,
      );
    });

  it('returns every address when all are allowed (all: true and single forms)', async () => {
    expect(await run([v4('1.1.1.1'), v6('2606:4700::1')], { all: true })).toEqual({
      error: null,
      result: [
        { address: '1.1.1.1', family: 4 },
        { address: '2606:4700::1', family: 6 },
      ],
    });
    expect(await run([v4('1.1.1.1')])).toEqual({ error: null, result: ['1.1.1.1', 4] });
    expect((await run([v4('1.1.1.1'), v6('2606:4700::1')], { family: 6 })).result).toEqual([
      '2606:4700::1',
      6,
    ]);
  });

  it('refuses a host when any of its addresses is not allowed, or it has none', async () => {
    for (const set of [[v4('10.0.0.1')], [v4('1.1.1.1'), v4('10.0.0.1')], [v6('::1')], []]) {
      const { error } = await run(set, { all: true });
      expect(error, JSON.stringify(set)).toBeInstanceOf(BlockedDestinationError);
    }
  });

  it('passes resolver failures on', async () => {
    const error = await new Promise<Error | null>((resolve) => {
      guardedLookup(
        async () => {
          throw new Error('ENOTFOUND');
        },
        () => true,
      )('x.example', {} as never, ((e: Error | null) => resolve(e)) as never);
    });
    expect(error?.message).toBe('ENOTFOUND');
  });
});

describe('createCimdFetch', () => {
  it('fetches a document (no redirects followed, headers kept)', async () => {
    const res = await local()(`http://doc.example:${port}/doc.json`, { signal: signal() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('max-age=600');
    expect(await res.text()).toBe('{"client_id":"x"}');
    const redirect = await local()(`http://doc.example:${port}/redirect`, { signal: signal() });
    expect(redirect.status).toBe(302);
    expect(await redirect.text()).toBe('');
  });

  it('cuts the body one byte past the limit', async () => {
    const res = await local({ maxBytes: 100 })(`http://doc.example:${port}/big`, { signal: signal() });
    expect((await res.arrayBuffer()).byteLength).toBe(101);
  });

  it('times out a server that never answers, and honours the caller’s abort', async () => {
    await expect(
      local({ timeoutMs: 100 })(`http://doc.example:${port}/hang`, { signal: signal() }),
    ).rejects.toThrow();
    const ac = new AbortController();
    const pending = local()(`http://doc.example:${port}/hang`, { signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toThrow();
  });

  it('never connects to a host that resolves to a non-public address (default policy)', async () => {
    const before = hits;
    for (const addresses of [
      [v4('127.0.0.1')],
      [v4('10.0.0.5')],
      [v4('169.254.169.254')],
      [v4('100.64.1.1')],
      [v6('::1')],
      [v6('::ffff:127.0.0.1')],
      [v6('fd00::1')],
      [v4('93.184.215.14'), v4('127.0.0.1')],
    ]) {
      const fetcher = createCimdFetch({ resolve: async () => addresses, allowHttpForTests: true });
      await expect(
        fetcher(`http://rebind.example:${port}/doc.json`, { signal: signal() }),
        JSON.stringify(addresses),
      ).rejects.toThrow(BlockedDestinationError);
    }
    expect(hits).toBe(before);
  });

  it('refuses non-https URLs and non-public IP literals before connecting', async () => {
    const fetcher = createCimdFetch({
      resolve: async () => {
        throw new Error('no DNS for IP literals or refused schemes');
      },
    });
    for (const url of [
      `http://doc.example:${port}/doc.json`,
      'https://127.0.0.1/doc.json',
      'https://[::1]/doc.json',
      'https://10.0.0.1/doc.json',
      'https://169.254.169.254/latest',
      'https://u:p@doc.example/doc.json',
      'ftp://doc.example/doc.json',
      'not a url',
    ]) {
      await expect(fetcher(url, { signal: signal() }), url).rejects.toThrow(BlockedDestinationError);
    }
  });
});
