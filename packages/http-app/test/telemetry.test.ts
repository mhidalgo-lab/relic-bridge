// SPDX-License-Identifier: Apache-2.0
// Self-monitoring (P7-08, T30): a local mock OTLP receiver stands in for the collector; no real endpoint or key.
import { createLogger, ErrorCode, type FetchLike } from '@relic-bridge/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyToolError,
  createHttpApp,
  createTelemetry,
  ERROR_CLASSIFICATION,
  mergeHooks,
  parseOtlpEndpoint,
  parseOtlpHeaders,
  parseSampleRate,
  parseTraceparent,
  TELEMETRY_LOG_BUFFER,
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
    expect(spans.map((s: { name: string }) => s.name).sort()).toEqual([
      'tools/call run_nrql',
      'tools/call whoami',
    ]);
    const tools = spans.map(
      (s: { attributes: { key: string; value: { stringValue: string } }[] }) =>
        s.attributes.find((a) => a.key === 'tool')?.value.stringValue,
    );
    expect(tools.sort()).toEqual(['run_nrql', 'whoami']);
    for (const s of spans) {
      expect(s.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
      const keys = s.attributes.map((a: { key: string }) => a.key);
      for (const k of keys)
        expect([
          'tool',
          'status',
          'error.code',
          'project',
          'mode',
          'nerdgraph.calls',
          'nerdgraph.response_bytes',
          'mcp.method.name',
          'gen_ai.operation.name',
          'gen_ai.tool.name',
          'rpc.system',
          'rpc.service',
          'rpc.method',
          'network.transport',
          'error.type',
          'fault',
        ]).toContain(k);
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
      acceptTraceparent: false,
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

const EVENT = {
  tool: 'whoami',
  status: 'ok',
  errorCode: null,
  durationMs: 5,
  input: {},
  meta: undefined,
} as const;

// biome-ignore lint/suspicious/noExplicitAny: test inspects raw OTLP JSON
const bodies = (path: string): any[] =>
  received.filter((r) => r.path === path).map((r) => JSON.parse(r.body));

describe('budget usage (P7-18)', () => {
  it('exports NerdGraph calls and bytes per tool call as low-cardinality counters, and on the span', async () => {
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch });
    await t.hooks.onToolCall?.({} as never, { projectSlug: 'prod' } as never, {
      ...EVENT,
      nerdgraphCalls: 3,
      nerdgraphBytes: 4096,
    });
    const metrics = bodies('/v1/metrics')[0].resourceMetrics[0].scopeMetrics[0].metrics;
    const byName = Object.fromEntries(metrics.map((m: { name: string }) => [m.name, m]));
    expect(byName['relic_bridge.nerdgraph.calls'].sum.dataPoints[0].asInt).toBe('3');
    expect(byName['relic_bridge.nerdgraph.response_bytes'].sum.dataPoints[0].asInt).toBe('4096');
    expect(byName['relic_bridge.nerdgraph.response_bytes'].unit).toBe('By');
    const keys = byName['relic_bridge.nerdgraph.calls'].sum.dataPoints[0].attributes.map(
      (a: { key: string }) => a.key,
    );
    expect(keys).toEqual(['tool', 'status', 'project', 'mode']);
    const span = bodies('/v1/traces')[0].resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.attributes).toContainEqual({ key: 'nerdgraph.calls', value: { intValue: '3' } });
  });

  it('ignores missing or hostile usage numbers', async () => {
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch, traceSampleRate: 0 });
    await t.hooks.onToolCall?.({} as never, { projectSlug: 'prod' } as never, {
      ...EVENT,
      nerdgraphCalls: Number.NaN,
      nerdgraphBytes: -5,
    });
    expect(received[0]?.body).not.toContain('nerdgraph');
  });

  it('counts calls and bytes on a real tool call through the app', async () => {
    const app = appWith();
    const client = await connect(app, 'prod', world.tokens.prod, 'modern');
    await client.callTool({ name: 'whoami', arguments: {} });
    await client.close();
    await vi.waitFor(() => expect(bodies('/v1/metrics').length).toBe(1));
    const names = bodies('/v1/metrics')[0].resourceMetrics[0].scopeMetrics[0].metrics.map(
      (m: { name: string }) => m.name,
    );
    expect(names).toContain('relic_bridge.nerdgraph.calls');
    expect(names).toContain('relic_bridge.nerdgraph.response_bytes');
  });
});

describe('OTLP logs (P7-18)', () => {
  it('exports only allowlisted, pattern-checked fields; secrets and free text never leave', async () => {
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch });
    const log = t.wrapLogger(createLogger({ level: 'debug', sink: (l) => logLines.push(l) }));
    log.debug('tool ok', { ms: 3 });
    log.info('tool error', {
      tool: 'run_nrql',
      code: 'RB_NRQL_INVALID',
      ms: 12,
      nrql: "SELECT * FROM Log WHERE user = 'victim@example.com'",
      apiKey: NR_KEY,
      error: 'x; DROP TABLE',
      email: 'victim@example.com',
    });
    log.child({ tool: 'whoami', token: world.tokens.prod }).warn(`bad token ${world.tokens.prod}`);
    log.warn('user victim@example.com signed in');
    log.error('NerdGraph said: SELECT secret');
    log.info('telemetry export failed; pausing exports');
    await t.flush();
    const records = bodies('/v1/logs').flatMap((b) => b.resourceLogs[0].scopeLogs[0].logRecords);
    expect(records.map((r: { severityText: string }) => r.severityText)).toEqual([
      'INFO',
      'WARN',
      'WARN',
      'ERROR',
    ]);
    expect(records[0].body.stringValue).toBe('tool error');
    expect(records[0].attributes).toEqual([
      { key: 'log.tool', value: { stringValue: 'run_nrql' } },
      { key: 'log.code', value: { stringValue: 'RB_NRQL_INVALID' } },
      { key: 'log.ms', value: { intValue: '12' } },
      { key: 'log.error', value: { stringValue: 'other' } },
    ]);
    expect(records[1].body.stringValue).toBe('other');
    expect(records[2].body.stringValue).toBe('other');
    expect(records[3].body.stringValue).toBe('other');
    const dump = received.map((r) => r.body).join('\n');
    for (const forbidden of ['SELECT', 'victim', 'DROP', NR_KEY, world.tokens.prod]) {
      expect(dump).not.toContain(forbidden);
    }
  });

  it('exports the access-log status (integer), method and route pattern; unknown values become other (P8-50)', async () => {
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch });
    const log = t.wrapLogger(createLogger({ level: 'debug', sink: (l) => logLines.push(l) }));
    log.info('http request', { requestId: 'r1', method: 'POST', route: '/p/:slug/mcp', status: 401, ms: 4 });
    log.info('http request', {
      method: 'PROPFIND',
      route: '/p/prod/mcp?x=victim@example.com',
      status: 'Not OK!',
    });
    log.info('http request', { method: 'GET', route: 'unmatched', status: 99999 });
    log.info('http request', { method: 'GET', route: '/admin/*', status: 200.5 });
    await t.flush();
    const records = bodies('/v1/logs').flatMap((b) => b.resourceLogs[0].scopeLogs[0].logRecords);
    const attrs = (i: number) =>
      Object.fromEntries(
        records[i].attributes.map((a: { key: string; value: Record<string, string> }) => [
          a.key,
          a.value['intValue'] !== undefined ? Number(a.value['intValue']) : a.value['stringValue'],
        ]),
      );
    expect(attrs(0)).toEqual({
      'log.method': 'POST',
      'log.route': '/p/:slug/mcp',
      'log.status': 401,
      'log.ms': 4,
    });
    expect(attrs(1)).toEqual({ 'log.method': 'other', 'log.route': 'other', 'log.status': 'other' });
    expect(attrs(2)).toEqual({ 'log.method': 'GET', 'log.route': 'other' });
    expect(attrs(3)).toEqual({ 'log.method': 'GET', 'log.route': '/admin/*' });
    expect(received.map((r) => r.body).join('\n')).not.toContain('victim');
  });

  it('exports the MCP method from a fixed set and a tool name only for tools/call (P8-50)', async () => {
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch });
    const log = t.wrapLogger(createLogger({ level: 'debug', sink: (l) => logLines.push(l) }));
    log.warn('mcp request timed out', { ms: 1000, mcpMethod: 'tools/call', mcpName: 'run_nrql' });
    log.warn('mcp request timed out', { mcpMethod: 'subscriptions/listen', mcpName: 'run_nrql' });
    log.warn('mcp request timed out', { mcpMethod: 'resources/read', mcpName: 'nrql://reference' });
    log.warn('mcp request timed out', { mcpMethod: 'evil/victim@example.com', mcpName: 'run_nrql' });
    log.warn('mcp request timed out', { mcpMethod: 'tasks/get' });
    await t.flush();
    const records = bodies('/v1/logs').flatMap((b) => b.resourceLogs[0].scopeLogs[0].logRecords);
    const keys = (i: number) =>
      Object.fromEntries(
        records[i].attributes.map((a: { key: string; value: Record<string, string> }) => [
          a.key,
          a.value['stringValue'] ?? a.value['intValue'],
        ]),
      );
    expect(keys(0)).toEqual({ 'log.ms': '1000', 'log.mcpMethod': 'tools/call', 'log.mcpName': 'run_nrql' });
    expect(keys(1)).toEqual({ 'log.mcpMethod': 'subscriptions/listen' });
    expect(keys(2)).toEqual({ 'log.mcpMethod': 'resources/read' });
    expect(keys(3)).toEqual({ 'log.mcpMethod': 'other' });
    expect(keys(4)).toEqual({ 'log.mcpMethod': 'tasks/get' });
    expect(received.map((r) => r.body).join('\n')).not.toContain('victim');
    expect(received.map((r) => r.body).join('\n')).not.toContain('nrql://');
  });

  it('keeps writing the wrapped logger unchanged and bounds the buffer', async () => {
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch });
    const log = t.wrapLogger(createLogger({ sink: (l) => logLines.push(l) }));
    for (let i = 0; i < 350; i++) log.info('purged');
    expect(logLines.length).toBe(350);
    await t.flush();
    const n = bodies('/v1/logs').reduce((a, b) => a + b.resourceLogs[0].scopeLogs[0].logRecords.length, 0);
    expect(n).toBe(TELEMETRY_LOG_BUFFER);
  });

  it('exports route paths but never a filesystem path (L2)', async () => {
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch });
    const log = t.wrapLogger(createLogger({ sink: (l) => logLines.push(l) }));
    log.info('database created', { path: '/home/someone/relic-bridge/data.db' });
    log.info('route seen', { path: '/p/prod/mcp' });
    await t.flush();
    const records = bodies('/v1/logs').flatMap((b) => b.resourceLogs[0].scopeLogs[0].logRecords);
    const dump = JSON.stringify(records);
    expect(dump).not.toContain('someone');
    expect(dump).toContain('/p/prod/mcp');
  });

  it('flushes with the next tool call, and a failing collector does not re-export its own warning', async () => {
    up = false;
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch, logger: logger() });
    const log = t.wrapLogger(logger());
    log.info('housekeeping done');
    await t.hooks.onToolCall?.({} as never, { projectSlug: 'prod' } as never, EVENT);
    up = true;
    t.close();
    expect(received).toEqual([]);
  });

  it('exports logs alongside a tool call when the collector is up', async () => {
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch });
    t.wrapLogger(silentLoggerFor()).info('housekeeping done');
    await t.hooks.onToolCall?.({} as never, { projectSlug: 'prod' } as never, EVENT);
    expect(received.map((r) => r.path).sort()).toEqual(['/v1/logs', '/v1/metrics', '/v1/traces']);
  });
});

function silentLoggerFor() {
  return createLogger({ sink: () => undefined });
}

describe('trace context (P7-18)', () => {
  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  const PARENT = '00f067aa0ba902b7';
  const ctx = (value: string | undefined) =>
    ({ req: { header: (n: string) => (n === 'traceparent' ? value : undefined) } }) as never;

  it('parses only a strict version 00 header', () => {
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-01`)).toEqual({ traceId: TRACE, spanId: PARENT });
    for (const bad of [
      undefined,
      '',
      `01-${TRACE}-${PARENT}-01`,
      `00-${TRACE.toUpperCase()}-${PARENT}-01`,
      `00-${'0'.repeat(32)}-${PARENT}-01`,
      `00-${TRACE}-${'0'.repeat(16)}-01`,
      `00-${TRACE}-${PARENT}-01-extra`,
      `00-${TRACE}-${PARENT}`,
      `00-${TRACE}-${PARENT}-0g`,
      `00-${TRACE}-${PARENT}-01\n`,
    ]) {
      expect(parseTraceparent(bad)).toBeUndefined();
    }
  });

  it('is ignored unless enabled', async () => {
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch });
    await t.hooks.onToolCall?.(ctx(`00-${TRACE}-${PARENT}-01`), { projectSlug: 'prod' } as never, EVENT);
    const span = bodies('/v1/traces')[0].resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).not.toBe(TRACE);
    expect(span.parentSpanId).toBeUndefined();
  });

  it('joins the client trace when enabled, and falls back to a fresh trace for a bad header', async () => {
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch, acceptTraceparent: true });
    await t.hooks.onToolCall?.(ctx(`00-${TRACE}-${PARENT}-01`), { projectSlug: 'prod' } as never, EVENT);
    await t.hooks.onPassthroughToolCall?.(ctx('garbage'), {} as never, EVENT);
    const spans = bodies('/v1/traces').map((b) => b.resourceSpans[0].scopeSpans[0].spans[0]);
    expect(spans[0].traceId).toBe(TRACE);
    expect(spans[0].parentSpanId).toBe(PARENT);
    expect(spans[1].traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spans[1].traceId).not.toBe(TRACE);
    expect(spans[1].parentSpanId).toBeUndefined();
  });

  it('never changes a response, and is not forwarded to NerdGraph', async () => {
    const nerdgraph = mockNerdGraph();
    const seenHeaders: string[] = [];
    const spy: FetchLike = (url, init) => {
      seenHeaders.push(JSON.stringify([...new Headers(init.headers).entries()]));
      return nerdgraph.fetch(url, init);
    };
    const telemetry = createTelemetry({
      endpoint: base,
      fetch: receiverFetch,
      acceptTraceparent: true,
    });
    const app = createHttpApp({
      storage: world.storage,
      keyring: world.keyring,
      clock: world.clock,
      logger: logger(),
      fetch: spy,
      hooks: mergeHooks(telemetry.hooks),
    });
    const withHeader = {
      fetch: (req: Request) => {
        const headers = new Headers(req.headers);
        headers.set('traceparent', `00-${TRACE}-${PARENT}-01`);
        return app.fetch(new Request(req, { headers }));
      },
    };
    const client = await connect(withHeader, 'prod', world.tokens.prod, 'modern');
    const out = await client.callTool({ name: 'whoami', arguments: {} });
    await client.close();
    expect(out.isError).toBeFalsy();
    await vi.waitFor(() => expect(bodies('/v1/traces').length).toBe(1));
    expect(bodies('/v1/traces')[0].resourceSpans[0].scopeSpans[0].spans[0].traceId).toBe(TRACE);
    expect(seenHeaders.length).toBeGreaterThan(0);
    expect(seenHeaders.join('')).not.toMatch(/traceparent|tracestate/);
    expect(seenHeaders.join('')).not.toContain(TRACE);
  });
});

describe('service entity signals (P8-51)', () => {
  const event = (tool: string, status: 'ok' | 'error' = 'ok') =>
    ({
      tool,
      status,
      errorCode: status === 'ok' ? null : 'RB_UPSTREAM',
      durationMs: 40,
      input: {},
      meta: undefined,
    }) as const;
  // biome-ignore lint/suspicious/noExplicitAny: test inspects raw OTLP JSON
  const attrMap = (attrs: any[]): Record<string, string> =>
    Object.fromEntries(attrs.map((a) => [a.key, a.value.stringValue ?? a.value.intValue]));

  it('adds telemetry.sdk.*, service.instance.id and the runtime to the resource of every signal', async () => {
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch, runtime: 'node' });
    await t.hooks.onToolCall?.({} as never, { projectSlug: 'prod' } as never, event('whoami'));
    await t.hooks.onRejected?.({} as never, { requestId: 'r', status: 429, reason: 'rate_limit_ip' });
    expect(received.length).toBeGreaterThanOrEqual(3);
    const resources = received.map((r) => {
      const j = JSON.parse(r.body);
      return attrMap((j.resourceSpans ?? j.resourceMetrics ?? j.resourceLogs)[0].resource.attributes);
    });
    for (const r of resources) {
      expect(r['service.name']).toBe('relic-bridge');
      expect(r['telemetry.sdk.name']).toBe('relic-bridge');
      expect(r['telemetry.sdk.language']).toBe('nodejs');
      expect(r['telemetry.sdk.version']).toMatch(/^\d+\.\d+\.\d+/);
      expect(r['service.instance.id']).toMatch(/^[0-9a-f]{32}$/);
      expect(r['process.runtime.name']).toBe('node');
    }
    expect(new Set(resources.map((r) => r['service.instance.id'])).size).toBe(1);
  });

  it('uses a different random instance id per exporter (process or isolate)', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      received = [];
      const t = createTelemetry({ endpoint: base, fetch: receiverFetch, runtime: 'workers' });
      await t.hooks.onToolCall?.({} as never, { projectSlug: 'prod' } as never, event('whoami'));
      const r = attrMap(JSON.parse(received[0]?.body ?? '{}').resourceMetrics[0].resource.attributes);
      expect(r['telemetry.sdk.language']).toBe('webjs');
      ids.add(r['service.instance.id'] ?? '');
    }
    expect(ids.size).toBe(3);
  });

  it('omits the language when the runtime is unknown', async () => {
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch });
    await t.hooks.onToolCall?.({} as never, { projectSlug: 'prod' } as never, event('whoami'));
    const r = attrMap(JSON.parse(received[0]?.body ?? '{}').resourceMetrics[0].resource.attributes);
    expect(r['telemetry.sdk.language']).toBeUndefined();
    expect(r['service.instance.id']).toBeDefined();
  });

  // biome-ignore lint/suspicious/noExplicitAny: test inspects raw OTLP JSON
  const spanOf = (): any =>
    JSON.parse(received.find((r) => r.path === '/v1/traces')?.body ?? '{}').resourceSpans[0].scopeSpans[0]
      .spans[0];

  it('names the span `tools/call <tool>` and adds the MCP and RPC attributes', async () => {
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch });
    await t.hooks.onToolCall?.({} as never, { projectSlug: 'prod' } as never, event('get_entity', 'error'));
    const span = spanOf();
    expect(span.name).toBe('tools/call get_entity');
    expect(span.kind).toBe(2);
    expect(attrMap(span.attributes)).toMatchObject({
      tool: 'get_entity',
      'mcp.method.name': 'tools/call',
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'get_entity',
      'rpc.system': 'jsonrpc',
      'rpc.service': 'mcp',
      'rpc.method': 'get_entity',
      'network.transport': 'tcp',
      'error.type': 'RB_UPSTREAM',
    });
  });

  it('an ok span has no error.type; stdio is a pipe', async () => {
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch });
    await t.recordToolCall(event('whoami'), { mode: 'stdio' });
    const a = attrMap(spanOf().attributes);
    expect(a['error.type']).toBeUndefined();
    expect(a['network.transport']).toBe('pipe');
  });

  it('an unknown or hostile tool name becomes `other` in the span name and every attribute', async () => {
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch });
    await t.hooks.onToolCall?.({} as never, { projectSlug: 'prod' } as never, {
      ...event("x'; DROP user@example.com", 'error'),
      errorCode: 'not a code@x.com',
    });
    const span = spanOf();
    expect(span.name).toBe('tools/call other');
    const a = attrMap(span.attributes);
    expect(a['gen_ai.tool.name']).toBe('other');
    expect(a['rpc.method']).toBe('other');
    expect(a['error.type']).toBe('other');
    expect(received.map((r) => r.body).join('')).not.toMatch(/DROP|user@example/);
  });

  it('exports rpc.server.duration (ms histogram) so New Relic builds the golden metrics', async () => {
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch, traceSampleRate: 0 });
    await t.hooks.onToolCall?.({} as never, { projectSlug: 'prod' } as never, event('whoami'));
    await t.hooks.onToolCall?.({} as never, { projectSlug: 'prod' } as never, event('whoami', 'error'));
    const metrics = received
      .filter((r) => r.path === '/v1/metrics')
      // biome-ignore lint/suspicious/noExplicitAny: test inspects raw OTLP JSON
      .flatMap((r) => (JSON.parse(r.body) as any).resourceMetrics[0].scopeMetrics[0].metrics)
      .filter((m: { name: string }) => m.name === 'rpc.server.duration');
    expect(metrics.length).toBe(2);
    for (const m of metrics) {
      expect(m.unit).toBe('ms');
      expect(m.histogram.aggregationTemporality).toBe(1);
      expect(m.histogram.dataPoints[0].sum).toBe(40);
    }
    const [ok, err] = metrics.map((m: { histogram: { dataPoints: { attributes: unknown[] }[] } }) =>
      attrMap(m.histogram.dataPoints[0]?.attributes as never[]),
    );
    expect(ok).toEqual({ 'rpc.system': 'jsonrpc', 'rpc.service': 'mcp', 'rpc.method': 'whoami' });
    expect(err).toEqual({ ...ok, 'error.type': 'RB_UPSTREAM', 'rpc.grpc.status_code': '2' });
  });
});

describe('server and caller errors (P8-59)', () => {
  const failed = (errorCode: string) =>
    ({ tool: 'run_nrql', status: 'error', errorCode, durationMs: 30, input: {}, meta: undefined }) as const;
  // biome-ignore lint/suspicious/noExplicitAny: test inspects raw OTLP JSON
  const attrMap = (attrs: any[]): Record<string, string> =>
    Object.fromEntries(attrs.map((a) => [a.key, a.value.stringValue ?? a.value.intValue]));
  // biome-ignore lint/suspicious/noExplicitAny: test inspects raw OTLP JSON
  const metricsOf = (): any[] =>
    received
      .filter((r) => r.path === '/v1/metrics')
      .flatMap((r) => JSON.parse(r.body).resourceMetrics[0].scopeMetrics[0].metrics);
  const rpcPoint = () =>
    attrMap(metricsOf().find((m) => m.name === 'rpc.server.duration').histogram.dataPoints[0].attributes);
  const callsPoint = () =>
    attrMap(metricsOf().find((m) => m.name === 'relic_bridge.tool.calls').sum.dataPoints[0].attributes);
  // biome-ignore lint/suspicious/noExplicitAny: test inspects raw OTLP JSON
  const spanOf = (): any =>
    JSON.parse(received.find((r) => r.path === '/v1/traces')?.body ?? '{}').resourceSpans[0].scopeSpans[0]
      .spans[0];

  it('classifies every RB_* code, each server error with a status code New Relic counts', () => {
    expect(Object.keys(ERROR_CLASSIFICATION).sort()).toEqual(Object.values(ErrorCode).sort());
    for (const c of Object.values(ERROR_CLASSIFICATION)) {
      if (c.fault === 'server') expect([2, 4, 12, 13, 14, 15]).toContain(c.grpcStatusCode);
      else expect(c.grpcStatusCode).toBeUndefined();
    }
    const caller = Object.entries(ERROR_CLASSIFICATION)
      .filter(([, c]) => c.fault === 'caller')
      .map(([code]) => code)
      .sort();
    expect(caller).toEqual(
      [
        'RB_INPUT_INVALID',
        'RB_AUTH_UNAUTHORIZED',
        'RB_AUTH_FORBIDDEN',
        'RB_LIMIT_QUERY',
        'RB_LIMIT_RESPONSE_TOO_LARGE',
        'RB_LIMIT_RATE',
        'RB_LIMIT_QUOTA',
        'RB_QUERY_NOT_FOUND',
        'RB_BUDGET_EXHAUSTED',
        'RB_TOOL_DISABLED',
      ].sort(),
    );
    expect(classifyToolError('RB_NERDGRAPH_TIMEOUT', 'token')).toEqual({
      fault: 'server',
      grpcStatusCode: 4,
    });
    expect(classifyToolError('RB_NERDGRAPH_UNAVAILABLE', 'stdio').grpcStatusCode).toBe(14);
    expect(classifyToolError('RB_NERDGRAPH_RATE_LIMITED', 'token').grpcStatusCode).toBe(14);
    expect(classifyToolError('RB_NERDGRAPH_ERROR', 'token').grpcStatusCode).toBe(2);
    expect(classifyToolError('RB_INTERNAL', 'token').grpcStatusCode).toBe(13);
  });

  it('a refused New Relic key is the server side on a stored credential, the caller on pass-through', () => {
    for (const code of ['RB_AUTH_INVALID_KEY', 'RB_AUTH_WRONG_REGION']) {
      expect(classifyToolError(code, 'token')).toEqual({ fault: 'server', grpcStatusCode: 13 });
      expect(classifyToolError(code, 'stdio').fault).toBe('server');
      expect(classifyToolError(code, 'passthrough')).toEqual({ fault: 'caller' });
    }
    expect(classifyToolError('RB_INPUT_INVALID', 'passthrough').fault).toBe('caller');
    expect(classifyToolError('RB_NERDGRAPH_TIMEOUT', 'passthrough').fault).toBe('server');
  });

  it('unknown codes, `other` and inherited property names are server errors (UNKNOWN)', () => {
    for (const code of ['RB_SOMETHING_NEW', 'other', 'constructor', '__proto__', 'toString']) {
      expect(classifyToolError(code, 'token')).toEqual({ fault: 'server', grpcStatusCode: 2 });
    }
  });

  it('a server error: span ERROR, error.type, rpc.grpc.status_code on rpc.server.duration, fault=server', async () => {
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch });
    await t.hooks.onToolCall?.(
      {} as never,
      { projectSlug: 'prod' } as never,
      failed('RB_NERDGRAPH_UNAVAILABLE'),
    );
    const span = spanOf();
    expect(span.status).toEqual({ code: 2, message: 'RB_NERDGRAPH_UNAVAILABLE' });
    expect(attrMap(span.attributes)).toMatchObject({
      status: 'error',
      'error.code': 'RB_NERDGRAPH_UNAVAILABLE',
      'error.type': 'RB_NERDGRAPH_UNAVAILABLE',
      fault: 'server',
    });
    // The span does not carry the gRPC code: Errors Inbox names the group from the status message.
    expect(attrMap(span.attributes)['rpc.grpc.status_code']).toBeUndefined();
    expect(rpcPoint()).toEqual({
      'rpc.system': 'jsonrpc',
      'rpc.service': 'mcp',
      'rpc.method': 'run_nrql',
      'error.type': 'RB_NERDGRAPH_UNAVAILABLE',
      'rpc.grpc.status_code': '14',
    });
    const rpc = metricsOf().find((m) => m.name === 'rpc.server.duration');
    const code = rpc.histogram.dataPoints[0].attributes.find(
      (a: { key: string }) => a.key === 'rpc.grpc.status_code',
    );
    expect(code.value).toEqual({ intValue: '14' }); // an integer, like the semconv attribute
    expect(callsPoint()).toMatchObject({
      status: 'error',
      'error.code': 'RB_NERDGRAPH_UNAVAILABLE',
      fault: 'server',
    });
  });

  it('a caller error: span Unset, no error.type or status code, still counted by error.code and fault', async () => {
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch });
    await t.hooks.onToolCall?.({} as never, { projectSlug: 'prod' } as never, failed('RB_LIMIT_QUERY'));
    const span = spanOf();
    expect(span.status).toBeUndefined();
    const a = attrMap(span.attributes);
    expect(a).toMatchObject({ status: 'error', 'error.code': 'RB_LIMIT_QUERY', fault: 'caller' });
    expect(a['error.type']).toBeUndefined();
    expect(rpcPoint()).toEqual({ 'rpc.system': 'jsonrpc', 'rpc.service': 'mcp', 'rpc.method': 'run_nrql' });
    expect(callsPoint()).toMatchObject({ status: 'error', 'error.code': 'RB_LIMIT_QUERY', fault: 'caller' });
  });

  it('pass-through: the caller’s own refused key is a caller error', async () => {
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch });
    await t.hooks.onPassthroughToolCall?.({} as never, {} as never, failed('RB_AUTH_INVALID_KEY'));
    expect(spanOf().status).toBeUndefined();
    expect(rpcPoint()['rpc.grpc.status_code']).toBeUndefined();
    expect(callsPoint()['fault']).toBe('caller');
  });

  it('a successful call has no fault, error.code, error.type or status code', async () => {
    const t = createTelemetry({ endpoint: base, fetch: receiverFetch });
    await t.recordToolCall({ ...failed('x'), status: 'ok', errorCode: null }, { mode: 'stdio' });
    expect(spanOf().status).toEqual({ code: 1 });
    const a = attrMap(spanOf().attributes);
    expect(a['fault']).toBeUndefined();
    expect(a['error.code']).toBeUndefined();
    expect(rpcPoint()).toEqual({ 'rpc.system': 'jsonrpc', 'rpc.service': 'mcp', 'rpc.method': 'run_nrql' });
  });

  it('a real caller error through the app is not a span error (RB_INPUT_INVALID)', async () => {
    const app = appWith();
    const client = await connect(app, 'prod', world.tokens.prod, 'modern');
    const r = await client.callTool({
      name: 'get_query_result',
      arguments: { query_id: 'nope', account: 1 },
    });
    expect(r.isError).toBe(true);
    await client.close();
    await vi.waitFor(() => expect(received.some((x) => x.path === '/v1/traces')).toBe(true));
    const span = spanOf();
    expect(span.status).toBeUndefined();
    expect(attrMap(span.attributes)['fault']).toBe('caller');
  });
});
