// SPDX-License-Identifier: Apache-2.0
// P8-50: an open-ended stream (standalone GET, `subscriptions/listen`) reaching the request deadline is normal and
// logs at info; a real request that never finishes still logs the timeout warning. The SDK handler is replaced by one
// whose response never ends, because the real stateless handler answers GET with 405.
import { createLogger } from '@relic-bridge/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpApp } from '../src/index.ts';
import { mockNerdGraph, seedWorld, type World } from './fixtures.ts';

vi.mock('@modelcontextprotocol/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('@modelcontextprotocol/server')>();
  return {
    ...original,
    createMcpHandler: () => ({
      fetch: async () =>
        new Response(new ReadableStream({ start: () => undefined }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    }),
  };
});

let world: World;
let logLines: string[];

beforeEach(async () => {
  world = await seedWorld();
  logLines = [];
});
afterEach(() => vi.restoreAllMocks());

function makeApp() {
  return createHttpApp({
    storage: world.storage,
    keyring: world.keyring,
    clock: world.clock,
    fetch: mockNerdGraph().fetch,
    requestTimeoutMs: 1000,
    logger: createLogger({ level: 'debug', sink: (l) => logLines.push(l), now: () => world.clock.now() }),
  });
}

const records = () => logLines.map((l) => JSON.parse(l) as Record<string, unknown>);
const deadline = () =>
  records().filter(
    (r) => r['msg'] === 'mcp request timed out' || r['msg'] === 'mcp stream closed at deadline',
  );

const headers = () => ({
  accept: 'application/json, text/event-stream',
  authorization: `Bearer ${world.tokens.prod}`,
  'mcp-protocol-version': '2025-11-25',
});

describe('deadline on an open stream', () => {
  it('GET stream: info "mcp stream closed at deadline", no warning', async () => {
    const res = await makeApp().fetch(
      new Request('http://localhost/p/prod/mcp', { method: 'GET', headers: headers() }),
    );
    await res.text();
    const lines = deadline();
    expect(lines.map((r) => [r['msg'], r['level']])).toEqual([['mcp stream closed at deadline', 'info']]);
    expect(lines[0]?.['ms']).toBe(1000);
    expect(records().some((r) => r['timeout'] === true)).toBe(false);
  });

  it('subscriptions/listen stream: info, no warning', async () => {
    const res = await makeApp().fetch(
      new Request('http://localhost/p/prod/mcp', {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json', 'mcp-method': 'subscriptions/listen' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'subscriptions/listen', params: {} }),
      }),
    );
    await res.text();
    expect(deadline().map((r) => [r['msg'], r['level']])).toEqual([
      ['mcp stream closed at deadline', 'info'],
    ]);
  });

  it('POST tools/call that never finishes: still warns', async () => {
    const res = await makeApp().fetch(
      new Request('http://localhost/p/prod/mcp', {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'whoami', arguments: {} },
        }),
      }),
    );
    await res.text();
    const lines = deadline();
    expect(lines.map((r) => [r['msg'], r['level']])).toEqual([['mcp request timed out', 'warn']]);
    expect(lines[0]?.['mcpMethod']).toBe('tools/call');
  });
});
