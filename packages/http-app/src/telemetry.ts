// SPDX-License-Identifier: Apache-2.0
// Self-monitoring (P7-08, THREAT_MODEL T30): opt-in OTLP/HTTP JSON export of how relic-bridge itself behaves, as
// traces (one span per tool call) and metrics (call count, duration, refused requests). A tiny hand-written exporter
// instead of the Node OpenTelemetry SDK: it uses only `fetch` (web-standard, ADR-0004), adds no dependency and no
// measurable CPU on Workers.
//
// What leaves the process is an allowlist built here, never an object passed through: tool name, outcome, `RB_*` error
// code, duration, project slug, refusal reason, runtime. Never exported: NRQL text (masked or not), tool arguments,
// result data, account ids, user/grant/token/client ids, emails, IP addresses, credentials. Every attribute value is
// validated against a pattern, so a hostile string (a made-up tool name in a request) is exported as `other`.
// Logs (P7-18): the redacting logger's records are exported as the OTLP logs signal through the same kind of
// allowlist: severity, a message that looks like a static English phrase, and a handful of named fields whose values
// match a pattern. Everything else a log line may carry is dropped. Trace context (P7-18): an inbound W3C `traceparent`
// is only used to give the span a parent for correlation, and only with `RB_OTEL_TRACEPARENT=on`; it never influences
// authorization, sampling of anything else, or logging, and it is not forwarded to NerdGraph (see docs).
// A failing or slow collector never changes a response: exports run in the app's background runner, are capped in
// flight, and are skipped for a while after a failure.

import type { ToolCallEvent } from '@relic-bridge/core';
import {
  type Clock,
  ErrorCode,
  type FetchLike,
  type LogFields,
  type Logger,
  type LogLevel,
  redact,
  redactValue,
  silentLogger,
  systemClock,
  VERSION,
} from '@relic-bridge/core';
import type { Context } from 'hono';
import type { HttpAppHooks, McpRequestInfo, RejectInfo } from './app.ts';
import type { PassthroughRequestInfo } from './passthrough.ts';

export const TELEMETRY_SERVICE_NAME = 'relic-bridge';
/** Instrument and span names, and their attributes: the documented telemetry contract (docs/guide/observability.md). */
export const TELEMETRY_NAMES: Readonly<{
  span: string;
  toolCalls: string;
  toolDuration: string;
  rejected: string;
  nerdgraphCalls: string;
  nerdgraphBytes: string;
  rpcServerDuration: string;
}> = Object.freeze({
  span: 'tools/call',
  toolCalls: 'relic_bridge.tool.calls',
  toolDuration: 'relic_bridge.tool.duration',
  rejected: 'relic_bridge.requests.rejected',
  nerdgraphCalls: 'relic_bridge.nerdgraph.calls',
  nerdgraphBytes: 'relic_bridge.nerdgraph.response_bytes',
  // OpenTelemetry RPC server metric: New Relic builds `apm.service.transaction.duration` (and so the service golden
  // metrics) from it (P8-51, docs/RESEARCH.md).
  rpcServerDuration: 'rpc.server.duration',
});
/** The MCP span name prefix; the tool name follows (`tools/call whoami`). */
export const TELEMETRY_SPAN_PREFIX = 'tools/call';
/** Most log records held between flushes; the oldest are dropped beyond it. */
export const TELEMETRY_LOG_BUFFER = 200;
const LOG_BATCH = 100;
/** Histogram bucket bounds in milliseconds. */
export const DURATION_BUCKETS_MS: readonly number[] = Object.freeze([
  25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000,
]);
export const DEFAULT_TELEMETRY_TIMEOUT_MS = 5000;
export const DEFAULT_TELEMETRY_MAX_IN_FLIGHT = 8;
/** After a failed export, further exports are skipped for this long. */
export const TELEMETRY_BACKOFF_MS = 30_000;

export class TelemetryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelemetryConfigError';
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validate the OTLP base URL: `https` only (the headers carry a license key), except loopback for a local collector.
 * No credentials in the URL, no query or fragment. Error messages never repeat the value.
 */
export function parseOtlpEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new TelemetryConfigError('the OTLP endpoint is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new TelemetryConfigError('the OTLP endpoint must use https (http only for localhost)');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new TelemetryConfigError('the OTLP endpoint must not contain credentials, a query or a fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

/** Parse `name=value,name2=value2` (the `OTEL_EXPORTER_OTLP_HEADERS` format; values may be percent-encoded). */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined || raw.trim() === '') return out;
  for (const pair of raw.split(',')) {
    const at = pair.indexOf('=');
    const name = at < 0 ? '' : pair.slice(0, at).trim();
    if (!HEADER_NAME.test(name)) throw new TelemetryConfigError('the OTLP headers are not name=value pairs');
    let value: string;
    try {
      value = decodeURIComponent(pair.slice(at + 1).trim());
    } catch {
      throw new TelemetryConfigError('the OTLP headers are not name=value pairs');
    }
    if (/[\r\n\0]/.test(value)) throw new TelemetryConfigError('the OTLP headers are not name=value pairs');
    out[name.toLowerCase()] = value;
  }
  return out;
}

/** `0`-`1` (or `off`); anything else is a configuration error. */
export function parseSampleRate(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 1;
  if (raw.trim().toLowerCase() === 'off') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new TelemetryConfigError('the trace sample rate must be a number from 0 to 1');
  }
  return n;
}

function parseOnOff(name: string, raw: string | undefined): boolean {
  const v = raw?.toLowerCase();
  if (v === undefined || v === 'off' || v === 'false' || v === '0') return false;
  if (v === 'on' || v === 'true' || v === '1') return true;
  throw new TelemetryConfigError(`${name} must be on or off`);
}

/** Validated `RB_OTEL*` configuration; `null` from `telemetrySettingsFromEnv` means off. */
export interface TelemetrySettings {
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly traceSampleRate: number;
  /** `RB_OTEL_TRACEPARENT=on`: spans join an inbound W3C `traceparent` (HTTP only). Default off. */
  readonly acceptTraceparent: boolean;
}

/**
 * Read `RB_OTEL` (`on`/`off`, default off), `RB_OTEL_ENDPOINT`, `RB_OTEL_HEADERS` (secret) and `RB_OTEL_SAMPLE`.
 * Anything set without `RB_OTEL=on` is ignored. Throws `TelemetryConfigError` (messages never contain the values).
 */
export function telemetrySettingsFromEnv(env: Readonly<Record<string, unknown>>): TelemetrySettings | null {
  const get = (name: string): string | undefined => {
    const v = env[name];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') throw new TelemetryConfigError(`${name} must be a string`);
    return v.trim() === '' ? undefined : v.trim();
  };
  const flag = get('RB_OTEL')?.toLowerCase();
  if (flag === undefined || flag === 'off' || flag === 'false' || flag === '0') return null;
  if (flag !== 'on' && flag !== 'true' && flag !== '1')
    throw new TelemetryConfigError('RB_OTEL must be on or off');
  const endpoint = get('RB_OTEL_ENDPOINT');
  if (endpoint === undefined) throw new TelemetryConfigError('RB_OTEL=on needs RB_OTEL_ENDPOINT');
  return {
    endpoint: parseOtlpEndpoint(endpoint),
    headers: parseOtlpHeaders(get('RB_OTEL_HEADERS')),
    traceSampleRate: parseSampleRate(get('RB_OTEL_SAMPLE')),
    acceptTraceparent: parseOnOff('RB_OTEL_TRACEPARENT', get('RB_OTEL_TRACEPARENT')),
  };
}

export interface TelemetryOptions {
  /** OTLP base URL (validated with `parseOtlpEndpoint`); `/v1/traces` and `/v1/metrics` are appended. */
  readonly endpoint: string;
  /** Request headers, e.g. `{ 'api-key': licenseKey }`. Never logged. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Share of tool calls exported as spans, 0-1 (default 1). Metrics are always exported. */
  readonly traceSampleRate?: number;
  /** `node` or `workers`: the `process.runtime.name` resource attribute. */
  readonly runtime?: string;
  readonly fetch?: FetchLike;
  readonly logger?: Logger;
  readonly clock?: Clock;
  /** 0 <= x < 1 (tests). Default `Math.random`. */
  readonly random?: () => number;
  readonly timeoutMs?: number;
  readonly maxInFlight?: number;
  /** Join an inbound `traceparent` header on HTTP tool calls (default off; see `parseTraceparent`). */
  readonly acceptTraceparent?: boolean;
  /** Flush buffered logs on this interval (Node); Workers flush with the next tool call or rejection instead. */
  readonly logFlushIntervalMs?: number;
}

/** Where a tool call came from, for the `mode` attribute and (HTTP) the project slug. */
export interface ToolCallOrigin {
  readonly mode: 'token' | 'passthrough' | 'stdio';
  readonly projectSlug?: string | null;
  /** A validated parent from `parseTraceparent`. */
  readonly parent?: TraceParent;
}

export interface TraceParent {
  readonly traceId: string;
  readonly spanId: string;
}

export interface Telemetry {
  /** Compose with `mergeHooks(...)`. */
  readonly hooks: HttpAppHooks;
  /** Record one finished tool call outside the HTTP hooks (stdio). Never throws. */
  recordToolCall(event: ToolCallEvent, origin: ToolCallOrigin): Promise<void>;
  /**
   * Wrap a logger so its records are also exported as OTLP logs (`info` and above, allowlisted). The wrapper logs to
   * the wrapped logger exactly as before. Records wait in a bounded buffer for `flush`.
   */
  wrapLogger(logger: Logger): Logger;
  /** Send buffered logs and wait for exports in flight (process exit, tests). Never throws. */
  flush(): Promise<void>;
  /** Stop the flush timer. */
  close(): void;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/**
 * Strict W3C `traceparent` (version 00 only, lowercase hex, non-zero ids). Anything else is ignored, so a hostile or
 * malformed header can only ever produce "no parent". The ids are random-looking and carry no information about the
 * caller beyond what the client chose to send; they are used for nothing but joining the span to that trace.
 */
export function parseTraceparent(raw: string | null | undefined): TraceParent | undefined {
  if (raw === null || raw === undefined || raw.length !== 55) return undefined;
  const m = TRACEPARENT.exec(raw);
  if (m === null) return undefined;
  const [, traceId, spanId] = m as unknown as [string, string, string];
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return { traceId, spanId };
}

/** Who a failed tool call is attributed to (P8-59): the caller (their input, limits, grants) or the server side. */
export type ErrorFault = 'caller' | 'server';

/** How a failed tool call is exported (P8-59). */
export interface ErrorClassification {
  readonly fault: ErrorFault;
  /**
   * Server errors only: the gRPC status code set as `rpc.grpc.status_code` on `rpc.server.duration`, the attribute New
   * Relic reads to count an RPC data point in `apm.service.error.count` (only 2, 4, 12, 13, 14 and 15 count). A
   * deliberate deviation (`rpc.system` is `jsonrpc`), documented in docs/guide/observability.md.
   */
  readonly grpcStatusCode?: number;
}

/** gRPC status codes (https://grpc.github.io/grpc/core/md_doc_statuscodes.html) that New Relic counts as errors. */
const GRPC = Object.freeze({ unknown: 2, deadlineExceeded: 4, internal: 13, unavailable: 14 });
const CALLER: ErrorClassification = Object.freeze({ fault: 'caller' });
const server = (grpcStatusCode: number): ErrorClassification =>
  Object.freeze({ fault: 'server', grpcStatusCode });

/**
 * Every `RB_*` code, classified (P8-59; the table in docs/guide/observability.md). Caller errors are answers the caller
 * can fix by changing the request: invalid input, limits and quotas, a missing query id, a tool or account the
 * connection does not grant, a request too broad for the per-call NerdGraph budget. Server errors are failures of
 * relic-bridge, of its New Relic credential or of New Relic. A full record, so a new code cannot stay unclassified.
 */
export const ERROR_CLASSIFICATION: Readonly<Record<ErrorCode, ErrorClassification>> = Object.freeze({
  [ErrorCode.InputInvalid]: CALLER,
  [ErrorCode.AuthUnauthorized]: CALLER,
  [ErrorCode.AuthForbidden]: CALLER,
  // The configured New Relic key is refused: the operator's credential (pass-through: the caller's own key, below).
  [ErrorCode.AuthInvalidKey]: server(GRPC.internal),
  [ErrorCode.AuthWrongRegion]: server(GRPC.internal),
  [ErrorCode.LimitQuery]: CALLER,
  [ErrorCode.LimitResponseTooLarge]: CALLER,
  [ErrorCode.LimitRate]: CALLER,
  [ErrorCode.LimitQuota]: CALLER,
  [ErrorCode.QueryNotFound]: CALLER,
  [ErrorCode.NerdGraphError]: server(GRPC.unknown),
  // gRPC's HTTP-to-gRPC mapping turns an upstream 429 into UNAVAILABLE, like 502, 503 and 504.
  [ErrorCode.NerdGraphRateLimited]: server(GRPC.unavailable),
  [ErrorCode.NerdGraphTimeout]: server(GRPC.deadlineExceeded),
  [ErrorCode.NerdGraphUnavailable]: server(GRPC.unavailable),
  [ErrorCode.BudgetExhausted]: CALLER,
  [ErrorCode.ToolDisabled]: CALLER,
  [ErrorCode.Internal]: server(GRPC.internal),
});
const CLASSIFIED: ReadonlyMap<string, ErrorClassification> = new Map(Object.entries(ERROR_CLASSIFICATION));
/** Pass-through connections bring their own New Relic key: a refused key is the caller's to fix. */
const CALLER_KEY_ERRORS: ReadonlySet<string> = new Set([ErrorCode.AuthInvalidKey, ErrorCode.AuthWrongRegion]);

/**
 * Classify a failed tool call's error code. Anything that is not a known `RB_*` code (a future code, or `other` after
 * the pattern check) is a server error with gRPC UNKNOWN: an unexplained failure should show up, not hide.
 */
export function classifyToolError(code: string, mode: ToolCallOrigin['mode']): ErrorClassification {
  if (mode === 'passthrough' && CALLER_KEY_ERRORS.has(code)) return CALLER;
  return CLASSIFIED.get(code) ?? server(GRPC.unknown);
}

type Attr = { key: string; value: { stringValue: string } | { intValue: string } };
const str = (key: string, value: string): Attr => ({ key, value: { stringValue: value } });
const int = (key: string, value: number): Attr => ({ key, value: { intValue: String(value) } });

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const ERROR_CODE = /^RB_[A-Z0-9_]{1,48}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REASON = /^[a-z][a-z0-9_]{0,48}$/;
const SEVERITY: Record<LogLevel, number> = { debug: 5, info: 9, warn: 13, error: 17 };
// The only log fields that are exported, and the pattern each value must match (`count`: a non-negative number).
const LOG_FIELDS: Readonly<Record<string, RegExp | 'count'>> = Object.freeze({
  tool: TOOL_NAME,
  code: ERROR_CODE,
  errorCode: ERROR_CODE,
  status: /^[a-z0-9_]{1,32}$/,
  // Access log (P8-50): the HTTP method from a fixed set, and the route *pattern* the app registered (`/p/:slug/mcp`,
  // never the request path: ids and slugs are not in it). The numeric HTTP status is exported as an integer below.
  method: /^(?:GET|POST|DELETE|OPTIONS|HEAD)$/,
  route: /^\/(?:(?:[A-Za-z0-9_.:*-]{1,64})(?:\/[A-Za-z0-9_.:*-]{1,64}){0,5})?$/,
  // The MCP method of the request (P8-50): the names the spec and SDK define; anything else is `other`.
  mcpMethod:
    /^(?:initialize|ping|subscriptions\/listen|logging\/setLevel|completion\/complete|tools\/(?:list|call)|resources\/(?:list|read|subscribe|unsubscribe|templates\/list)|prompts\/(?:list|get)|tasks\/[a-z]{1,24}|notifications\/[a-z_]{1,32}(?:\/[a-z_]{1,32})?)$/,
  // Only a tool name (and only with `tools/call`, checked where it is read); other names (resource URIs, prompts) never leave.
  mcpName: TOOL_NAME,
  error: /^[A-Za-z][A-Za-z0-9_]{0,48}$/,
  // HTTP route paths only (the collector endpoints and `/p/<slug>/mcp`); a filesystem path never matches (P7-30, L2).
  path: /^\/(?:v1\/(?:traces|metrics|logs)|p\/[a-z0-9-]{1,64}\/mcp|mcp|health|healthz|ready|readyz)$/,
  reason: REASON,
  ms: 'count',
  removed: 'count',
});
/** A message is exported only when it reads like a fixed phrase: no `@`, `=`, quotes, URLs or long opaque runs. */
const LOG_MESSAGE = /^[A-Za-z][A-Za-z0-9 ,.:()_-]{0,119}$/;
// Log messages are written by us, never built from request text; this is the belt to that braces (NRQL words, ids).
const NRQL_WORD = /\b(select|from|where|facet|since|until|limit|timeseries|compare)\b/i;
const LONG_TOKEN = /[A-Za-z0-9_-]{24,}/;
const pick = (value: string | null | undefined, pattern: RegExp): string =>
  value !== null && value !== undefined && pattern.test(value) ? value : 'other';

const nanos = (ms: number): string => `${Math.max(0, Math.round(ms))}000000`;

function hex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function bucketCounts(ms: number): string[] {
  const counts = new Array<number>(DURATION_BUCKETS_MS.length + 1).fill(0);
  const i = DURATION_BUCKETS_MS.findIndex((bound) => ms <= bound);
  counts[i < 0 ? DURATION_BUCKETS_MS.length : i] = 1;
  return counts.map(String);
}

export function createTelemetry(options: TelemetryOptions): Telemetry {
  const base = options.endpoint.replace(/\/+$/, '');
  const logger = options.logger ?? silentLogger;
  const clock = options.clock ?? systemClock;
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const random = options.random ?? Math.random;
  const sampleRate = options.traceSampleRate ?? 1;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TELEMETRY_TIMEOUT_MS;
  const maxInFlight = options.maxInFlight ?? DEFAULT_TELEMETRY_MAX_IN_FLIGHT;
  const headers: Record<string, string> = {
    ...options.headers,
    'content-type': 'application/json',
  };
  // `telemetry.sdk.language`: `nodejs` is the semconv value for Node. Workers run JavaScript but are not Node and
  // not a browser; the semconv list has no value for them and allows a custom one, `webjs` (the registry's "other
  // JavaScript runtime" value) is the closest known one, so New Relic's language-aware UI treats them as JS.
  const language =
    options.runtime === 'node' ? 'nodejs' : options.runtime === 'workers' ? 'webjs' : undefined;
  const resource = {
    attributes: [
      str('service.name', TELEMETRY_SERVICE_NAME),
      str('service.version', VERSION),
      // A random id per exporter (process or isolate), never derived from host, user or request data.
      str('service.instance.id', hex(16)),
      str('telemetry.sdk.name', TELEMETRY_SERVICE_NAME),
      ...(language === undefined ? [] : [str('telemetry.sdk.language', language)]),
      str('telemetry.sdk.version', VERSION),
      ...(options.runtime === undefined ? [] : [str('process.runtime.name', options.runtime)]),
    ],
  };
  const scope = { name: TELEMETRY_SERVICE_NAME, version: VERSION };
  const acceptTraceparent = options.acceptTraceparent === true;
  const logBuffer: Record<string, unknown>[] = [];

  // Bookkeeping about the exporter itself, not request data.
  let inFlight = 0;
  let pausedUntil = 0;

  const pending = new Set<Promise<void>>();
  const post = (path: string, body: unknown): Promise<void> => {
    const p = send(path, body);
    pending.add(p);
    void p.then(() => pending.delete(p));
    return p;
  };
  const send = async (path: string, body: unknown): Promise<void> => {
    if (inFlight >= maxInFlight || clock.now() < pausedUntil) return;
    inFlight += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        // Never follow a redirect (the headers hold the license key). `manual`, not `error`: workerd rejects
        // `error` ("use manual and check the status"), so a 3xx (or an opaque redirect) fails as `!ok` below (P8-65).
        redirect: 'manual',
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw new Error(`status ${response.status}`);
    } catch (error) {
      const now = clock.now();
      if (now >= pausedUntil) {
        // Once per pause; the endpoint, headers and error text are not logged (they can hold the license key).
        logger.warn('telemetry export failed; pausing exports', {
          path,
          error: error instanceof Error ? error.name : typeof error,
        });
      }
      pausedUntil = now + TELEMETRY_BACKOFF_MS;
    } finally {
      clearTimeout(timer);
      inFlight -= 1;
    }
  };

  const sumMetric = (
    name: string,
    unit: string,
    attrs: readonly Attr[],
    start: number,
    end: number,
    value: number,
  ) => ({
    name,
    unit,
    sum: {
      aggregationTemporality: 1,
      isMonotonic: true,
      dataPoints: [
        {
          attributes: attrs,
          startTimeUnixNano: nanos(start),
          timeUnixNano: nanos(end),
          asInt: String(Math.max(0, Math.round(value))),
        },
      ],
    },
  });
  const metricsBody = (metrics: unknown[]) => ({
    resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics }] }],
  });

  const count = (v: number | undefined): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;

  const record = async (event: ToolCallEvent, origin: ToolCallOrigin): Promise<void> => {
    const end = clock.now();
    const durationMs = Number.isFinite(event.durationMs) ? Math.max(0, event.durationMs) : 0;
    const start = end - durationMs;
    const tool = pick(event.tool, TOOL_NAME);
    const errorCode = event.status === 'error' ? pick(event.errorCode, ERROR_CODE) : undefined;
    const failure = errorCode === undefined ? undefined : classifyToolError(errorCode, origin.mode);
    // Semconv: `error.type` (and span status ERROR) only when the operation failed on the server side; a caller's
    // mistake is not a failed server operation (P8-59). Caller errors stay countable by `status`, `error.code`, `fault`.
    const errorType = failure?.fault === 'server' ? errorCode : undefined;
    // OpenTelemetry `rpc.*` attributes of the server operation, for New Relic's transaction name
    // (`WebTransaction/server/jsonrpc/mcp.<tool>`) and error count.
    const rpcAttrs: Attr[] = [
      str('rpc.system', 'jsonrpc'),
      str('rpc.service', 'mcp'),
      str('rpc.method', tool),
      ...(errorType === undefined ? [] : [str('error.type', errorType)]),
    ];
    const attrs: Attr[] = [
      str('tool', tool),
      str('status', event.status === 'ok' ? 'ok' : 'error'),
      ...(errorCode === undefined || failure === undefined
        ? []
        : [str('error.code', errorCode), str('fault', failure.fault)]),
      ...(origin.mode === 'token' ? [str('project', pick(origin.projectSlug, SLUG))] : []),
      str('mode', origin.mode),
    ];
    const calls = count(event.nerdgraphCalls);
    const bytes = count(event.nerdgraphBytes);
    const metrics: unknown[] = [
      sumMetric(TELEMETRY_NAMES.toolCalls, '{call}', attrs, start, end, 1),
      {
        name: TELEMETRY_NAMES.toolDuration,
        unit: 'ms',
        histogram: {
          aggregationTemporality: 1,
          dataPoints: [
            {
              attributes: attrs,
              startTimeUnixNano: nanos(start),
              timeUnixNano: nanos(end),
              count: '1',
              sum: durationMs,
              min: durationMs,
              max: durationMs,
              bucketCounts: bucketCounts(durationMs),
              explicitBounds: DURATION_BUCKETS_MS,
            },
          ],
        },
      },
      {
        name: TELEMETRY_NAMES.rpcServerDuration,
        unit: 'ms',
        histogram: {
          aggregationTemporality: 1,
          dataPoints: [
            {
              // New Relic counts an RPC error only from `rpc.grpc.status_code` (P8-59): set on server errors only.
              attributes:
                failure?.grpcStatusCode === undefined
                  ? rpcAttrs
                  : [...rpcAttrs, int('rpc.grpc.status_code', failure.grpcStatusCode)],
              startTimeUnixNano: nanos(start),
              timeUnixNano: nanos(end),
              count: '1',
              sum: durationMs,
              min: durationMs,
              max: durationMs,
              bucketCounts: bucketCounts(durationMs),
              explicitBounds: DURATION_BUCKETS_MS,
            },
          ],
        },
      },
      ...(calls === undefined
        ? []
        : [sumMetric(TELEMETRY_NAMES.nerdgraphCalls, '{call}', attrs, start, end, calls)]),
      ...(bytes === undefined
        ? []
        : [sumMetric(TELEMETRY_NAMES.nerdgraphBytes, 'By', attrs, start, end, bytes)]),
    ];
    const tasks: Promise<void>[] = [post('/v1/metrics', metricsBody(metrics)), flushLogs()];
    if (sampleRate > 0 && random() < sampleRate) {
      const spanAttrs: Attr[] = [
        ...attrs,
        // OpenTelemetry MCP semantic conventions (development) plus `rpc.*`; no arguments, results or ids.
        str('mcp.method.name', 'tools/call'),
        str('gen_ai.operation.name', 'execute_tool'),
        str('gen_ai.tool.name', tool),
        ...rpcAttrs,
        str('network.transport', origin.mode === 'stdio' ? 'pipe' : 'tcp'),
        ...(calls === undefined ? [] : [int('nerdgraph.calls', calls)]),
        ...(bytes === undefined ? [] : [int('nerdgraph.response_bytes', bytes)]),
      ];
      tasks.push(
        post('/v1/traces', {
          resourceSpans: [
            {
              resource,
              scopeSpans: [
                {
                  scope,
                  spans: [
                    {
                      traceId: origin.parent?.traceId ?? hex(16),
                      spanId: hex(8),
                      ...(origin.parent === undefined ? {} : { parentSpanId: origin.parent.spanId }),
                      name: `${TELEMETRY_SPAN_PREFIX} ${tool}`,
                      kind: 2,
                      startTimeUnixNano: nanos(start),
                      endTimeUnixNano: nanos(end),
                      attributes: spanAttrs,
                      // OK; ERROR for a server error; Unset (no status) for a caller error (P8-59).
                      ...(event.status === 'ok'
                        ? { status: { code: 1 } }
                        : errorType === undefined
                          ? {}
                          : { status: { code: 2, message: errorType } }),
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );
    }
    await Promise.all(tasks);
  };

  // ---- logs ----------------------------------------------------------------------------------------------------
  const flushLogs = async (): Promise<void> => {
    const tasks: Promise<void>[] = [];
    while (logBuffer.length > 0) {
      const batch = logBuffer.splice(0, LOG_BATCH);
      tasks.push(
        post('/v1/logs', { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: batch }] }] }),
      );
    }
    await Promise.all(tasks);
  };

  const enqueueLog = (level: LogLevel, msg: string, fields: LogFields): void => {
    // Never export the exporter's own diagnostics (a failing collector must not feed itself), nor debug noise.
    if (level === 'debug' || msg.startsWith('telemetry ')) return;
    try {
      const safeMsg = redact(msg);
      const attributes: Attr[] = [];
      const red = redactValue(fields) as LogFields;
      for (const [key, value] of Object.entries(red)) {
        const kind = LOG_FIELDS[key];
        if (kind === undefined) continue;
        if (key === 'mcpName') {
          if (red['mcpMethod'] === 'tools/call' && typeof value === 'string' && TOOL_NAME.test(value)) {
            attributes.push(str('log.mcpName', value));
          }
        } else if (key === 'status' && typeof value === 'number') {
          // The HTTP status code of an access-log record: an integer in the valid range, nothing else.
          if (Number.isInteger(value) && value >= 100 && value <= 599)
            attributes.push(int('log.status', value));
        } else if (kind === 'count') {
          if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
            attributes.push(int(`log.${key}`, Math.round(value)));
          }
        } else if (typeof value === 'string') {
          attributes.push(str(`log.${key}`, pick(value, kind)));
        }
      }
      logBuffer.push({
        timeUnixNano: nanos(clock.now()),
        severityNumber: SEVERITY[level],
        severityText: level.toUpperCase(),
        body: {
          stringValue:
            LOG_MESSAGE.test(safeMsg) && !LONG_TOKEN.test(safeMsg) && !NRQL_WORD.test(safeMsg)
              ? safeMsg
              : 'other',
        },
        attributes,
      });
      if (logBuffer.length > TELEMETRY_LOG_BUFFER)
        logBuffer.splice(0, logBuffer.length - TELEMETRY_LOG_BUFFER);
    } catch {
      // logging never breaks anything
    }
  };

  const wrap = (inner: Logger, base: LogFields): Logger => ({
    debug: (m, f) => inner.debug(m, f),
    info: (m, f) => {
      inner.info(m, f);
      enqueueLog('info', m, { ...base, ...f });
    },
    warn: (m, f) => {
      inner.warn(m, f);
      enqueueLog('warn', m, { ...base, ...f });
    },
    error: (m, f) => {
      inner.error(m, f);
      enqueueLog('error', m, { ...base, ...f });
    },
    child: (fields) => wrap(inner.child(fields), { ...base, ...fields }),
  });

  const timer =
    options.logFlushIntervalMs === undefined
      ? undefined
      : setInterval(() => void flushLogs(), options.logFlushIntervalMs);
  (timer as { unref?: () => void } | undefined)?.unref?.();

  const parentOf = (c: Context): TraceParent | undefined =>
    acceptTraceparent ? parseTraceparent(c.req.header('traceparent')) : undefined;

  const hooks: HttpAppHooks = {
    async onToolCall(c, info: McpRequestInfo, event) {
      await record(event, { mode: 'token', projectSlug: info.projectSlug, ...optParent(parentOf(c)) });
    },
    async onPassthroughToolCall(c, _info: PassthroughRequestInfo, event) {
      await record(event, { mode: 'passthrough', ...optParent(parentOf(c)) });
    },
    async onRejected(_c, info: RejectInfo) {
      const now = clock.now();
      const attrs = [
        str('reason', pick(info.reason ?? `http_${info.status}`, REASON)),
        str('http.response.status_code', String(info.status >= 400 && info.status < 600 ? info.status : 0)),
      ];
      await Promise.all([
        post(
          '/v1/metrics',
          metricsBody([sumMetric(TELEMETRY_NAMES.rejected, '{request}', attrs, now, now, 1)]),
        ),
        flushLogs(),
      ]);
    },
  };
  return {
    hooks,
    recordToolCall: (event, origin) => record(event, origin).catch(() => undefined),
    wrapLogger: (logger) => wrap(logger, {}),
    async flush() {
      await flushLogs();
      await Promise.all([...pending]);
    },
    close() {
      if (timer !== undefined) clearInterval(timer);
    },
  };
}

const optParent = (parent: TraceParent | undefined): { parent?: TraceParent } =>
  parent === undefined ? {} : { parent };
