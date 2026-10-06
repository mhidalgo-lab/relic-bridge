// SPDX-License-Identifier: Apache-2.0
// Self-monitoring (P7-08, T30): a local mock OTLP receiver stands in for the collector; no real endpoint or key.
import { createLogger, type FetchLike } from '@relic-bridge/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHttpApp,
  createTelemetry,
  mergeHooks,
  parseOtlpEndpoint,
  parseOtlpHeaders,
  parseSampleRate,
  TelemetryConfigError,
  telemetrySettingsFromEnv,
} from '../src/index.ts';
import { connect, mockNerdGraph, NR_KEY, seedWorld, type World } from './fixtures.ts';

const LICENSE = `lic-${'k'.repeat(30)}NRAL`;

interface Received {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

let received: Received[];
let base: string;
let world: World;
let logLines: string[];
let up: boolean;

/** The mock OTLP receiver: records what the exporter posts (web-standard; the Node socket test lives in apps/cli). */
const receiverFetch: FetchLike = async (url, init) => {
  if (!up) throw new TypeError('connect ECONNREFUSED');
  received.push({
    path: new URL(String(url)).pathname,
    headers: Object.fromEntries(new Headers(init.headers).entries()),
    body: String(init.body),
  });
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

beforeEach(async () => {
  received = [];
  up = true;
  base = 'http://127.0.0.1:4318';
  world = await seedWorld();
  logLines = [];
});

const logger = () => createLogger({ level: 'debug', sink: (l) => logLines.push(l) });

function appWith(options: Partial<Parameters<typeof createTelemetry>[0]> = {}) {
  const telemetry = createTelemetry({
    endpoint: base,
    fetch: receiverFetch,
    headers: { 'api-key': LICENSE },
    logger: logger(),
    ...options,
  });
  return createHttpApp({
    storage: world.storage,
    keyring: world.keyring,
    clock: world.clock,
    logger: logger(),
    fetch: mockNerdGraph().fetch,
    hooks: mergeHooks(telemetry.hooks),
  });
}

describe('OTLP export', () => {
  it('exports a span and metrics per tool call, with an allowlisted attribute set and the headers', async () => {
    const app = appWith();
    const client = await connect(app, 'prod', world.tokens.prod, 'modern');
    await client.callTool({ name: 'whoami', arguments: {} });
    await client.callTool({
      name: 'run_nrql',
      arguments: { nrql: "SELECT count(*) FROM Transaction WHERE email = 'SECRET-VALUE@example.com'" },
    });
    await client.close();
    await vi.waitFor(() => expect(received.filter((r) => r.path === '/v1/traces').length).toBe(2));
    await vi.waitFor(() => expect(received.filter((r) => r.path === '/v1/metrics').length).toBe(2));

    const spans = received
      .filter((r) => r.path === '/v1/traces')
      // biome-ignore lint/suspicious/noExplicitAny: test inspects raw OTLP JSON
      .flatMap((r) => (JSON.parse(r.body) as any).resourceSpans[0].scopeSpans[0].spans);
    expect(spans.map((s: { name: string }) => s.name)).toEqual(['tools/call', 'tools/call']);
    const tools = spans.map(
      (s: { attributes: { key: string; value: { stringValue: string } }[] }) =>
        s.attributes.find((a) => a.key === 'tool')?.value.stringValue,
    );
    expect(tools.sort()).toEqual(['run_nrql', 'whoami']);
    for (const s of spans) {
      expect(s.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
      const keys = s.attributes.map((a: { key: string }) => a.key);
      for (const k of keys) expect(['tool', 'status', 'error.code', 'project', 'mode']).toContain(k);
    }
    expect(received[0]?.headers['api-key']).toBe(LICENSE);

    // T8/T30: nothing from the request, the result or the credentials leaves the process.
    const dump = received.map((r) => r.body).join('\n') + logLines.join('\n');
    for (const forbidden of [
      'SECRET-VALUE',
      'SELECT',
      'a@example.com',
      NR_KEY,
      LICENSE,
      ...Object.values(world.tokens),
    ]) {
      expect(dump).not.toContain(forbidden);
    }
    expect(dump).not.toMatch(/\brb_(live|test)_/);
    expect(dump).toContain('relic_bridge.tool.duration');
  });

  it('exports refused requests as a counter by reason, without addresses or credentials', async () => {
    const rejected = createTelemetry({ endpoint: base, fetch: receiverFetch, logger: logger() });
    await rejected.hooks.onRejected?.({} as never, { requestId: 'r', status: 429, reason: 'rate_limit_ip' });
    await rejected.hooks.onRejected?.({} as never, { requestId: 'r', status: 400, reason: "x'; DROP" });
    expect(received.length).toBe(2);
    expect(received[0]?.body).toContain('relic_bridge.requests.rejected');
    expect(received[0]?.body).toContain('rate_limit_ip');
    expect(received[1]?.body).not.toContain('DROP');
    expect(received[1]?.body).toContain('"other"');
  });

  it('masks hostile tool names and error codes into `other`', async () => {
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch, traceSampleRate: 0 });
    await t.hooks.onToolCall?.({} as never, { projectSlug: 'prod' } as never, {
      tool: 'SELECT * FROM x',
      status: 'error',
      errorCode: 'user@example.com',
      durationMs: 12,
      input: { nrql: 'secret' },
      meta: undefined,
    });
    expect(received.map((r) => r.path)).toEqual(['/v1/metrics']); // sample rate 0: no spans
    expect(received[0]?.body).not.toContain('SELECT');
    expect(received[0]?.body).not.toContain('user@example.com');
    expect(received[0]?.body).not.toContain('secret');
  });

  it('samples traces but always exports metrics', async () => {
    const t = createTelemetry({
      endpoint: base,
      fetch: receiverFetch,
      traceSampleRate: 0.5,
      random: () => 0.9,
    });
    const event = {
      tool: 'whoami',
      status: 'ok',
      errorCode: null,
      durationMs: 5,
      input: {},
      meta: undefined,
    } as const;
    await t.hooks.onToolCall?.({} as never, { projectSlug: 'prod' } as never, event);
    expect(received.map((r) => r.path)).toEqual(['/v1/metrics']);
  });
});

describe('failures never reach the caller', () => {
  it('survives an unreachable collector, logs once without the endpoint or headers, then pauses', async () => {
    up = false;
    const app = appWith({ timeoutMs: 500 });
    const client = await connect(app, 'prod', world.tokens.prod, 'modern');
    const out = await client.callTool({ name: 'whoami', arguments: {} });
    expect(out.isError).not.toBe(true);
    await client.callTool({ name: 'whoami', arguments: {} });
    await client.close();
    await vi.waitFor(() => expect(logLines.some((l) => l.includes('telemetry export failed'))).toBe(true));
    const dump = logLines.join('\n');
    expect(dump).not.toContain(LICENSE);
    expect(dump).not.toContain(base);
  });

  it('survives a collector answering 500 and a throwing fetch', async () => {
    const t = createTelemetry({
      endpoint: base,
      fetch: async () => new Response('no', { status: 500 }),
      logger: logger(),
    });
    const event = {
      tool: 'whoami',
      status: 'ok',
      errorCode: null,
      durationMs: 5,
      input: {},
      meta: undefined,
    } as const;
    await expect(
      t.hooks.onToolCall?.({} as never, { projectSlug: 'p' } as never, event),
    ).resolves.toBeUndefined();
    const t2 = createTelemetry({
      endpoint: base,
      fetch: async () => {
        throw new Error(`boom ${LICENSE}`);
      },
      logger: logger(),
    });
    await expect(
      t2.hooks.onToolCall?.({} as never, { projectSlug: 'p' } as never, event),
    ).resolves.toBeUndefined();
    expect(logLines.join('\n')).not.toContain(LICENSE);
  });

  it('drops exports beyond the in-flight cap', async () => {
    let calls = 0;
    const t = createTelemetry({
      endpoint: base,
      maxInFlight: 1,
      traceSampleRate: 0,
      fetch: () => {
        calls += 1;
        return new Promise(() => undefined);
      },
      timeoutMs: 60_000,
    });
    const event = {
      tool: 'whoami',
      status: 'ok',
      errorCode: null,
      durationMs: 5,
      input: {},
      meta: undefined,
    } as const;
    void t.hooks.onToolCall?.({} as never, { projectSlug: 'p' } as never, event);
    await t.hooks.onToolCall?.({} as never, { projectSlug: 'p' } as never, event);
    expect(calls).toBe(1);
  });
});

describe('configuration', () => {
  it('is off unless RB_OTEL=on', () => {
    expect(telemetrySettingsFromEnv({})).toBeNull();
    expect(telemetrySettingsFromEnv({ RB_OTEL: 'off', RB_OTEL_ENDPOINT: 'https://x.example' })).toBeNull();
    expect(() => telemetrySettingsFromEnv({ RB_OTEL: 'on' })).toThrow(TelemetryConfigError);
    expect(() => telemetrySettingsFromEnv({ RB_OTEL: 'maybe' })).toThrow(TelemetryConfigError);
    expect(
      telemetrySettingsFromEnv({
        RB_OTEL: 'on',
        RB_OTEL_ENDPOINT: 'https://otlp.example.com:4318/',
        RB_OTEL_HEADERS: 'api-key=abc%3D',
        RB_OTEL_SAMPLE: '0.25',
      }),
    ).toEqual({
      endpoint: 'https://otlp.example.com:4318',
      headers: { 'api-key': 'abc=' },
      traceSampleRate: 0.25,
    });
  });

  it('requires https (loopback excepted) and refuses credentials in the URL, without echoing the value', () => {
    expect(parseOtlpEndpoint('http://localhost:4318')).toBe('http://localhost:4318');
    for (const bad of [
      'http://collector.example.com',
      'https://u:p@x.example',
      'https://x.example/?k=v',
      'nope',
    ]) {
      expect(() => parseOtlpEndpoint(bad)).toThrow(TelemetryConfigError);
      try {
        parseOtlpEndpoint(bad);
      } catch (e) {
        expect((e as Error).message).not.toContain('collector.example.com');
        expect((e as Error).message).not.toContain('p@x');
      }
    }
  });

  it('validates headers and the sample rate', () => {
    expect(parseOtlpHeaders(undefined)).toEqual({});
    expect(() => parseOtlpHeaders('no-equals')).toThrow(TelemetryConfigError);
    expect(() => parseOtlpHeaders('bad name=1')).toThrow(TelemetryConfigError);
    expect(parseSampleRate(undefined)).toBe(1);
    expect(parseSampleRate('off')).toBe(0);
    expect(() => parseSampleRate('2')).toThrow(TelemetryConfigError);
    expect(() => parseSampleRate('x')).toThrow(TelemetryConfigError);
  });
});
