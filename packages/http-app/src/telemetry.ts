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
// A failing or slow collector never changes a response: exports run in the app's background runner, are capped in
// flight, and are skipped for a while after a failure.

import type { ToolCallEvent } from '@relic-bridge/core';
import {
  type Clock,
  type FetchLike,
  type Logger,
  silentLogger,
  systemClock,
  VERSION,
} from '@relic-bridge/core';
import type { HttpAppHooks, McpRequestInfo, RejectInfo } from './app.ts';
import type { PassthroughRequestInfo } from './passthrough.ts';

export const TELEMETRY_SERVICE_NAME = 'relic-bridge';
/** Instrument and span names, and their attributes: the documented telemetry contract (docs/guide/observability.md). */
export const TELEMETRY_NAMES: Readonly<{
  span: string;
  toolCalls: string;
  toolDuration: string;
  rejected: string;
}> = Object.freeze({
  span: 'tools/call',
  toolCalls: 'relic_bridge.tool.calls',
  toolDuration: 'relic_bridge.tool.duration',
  rejected: 'relic_bridge.requests.rejected',
});
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

/** Validated `RB_OTEL*` configuration; `null` from `telemetrySettingsFromEnv` means off. */
export interface TelemetrySettings {
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly traceSampleRate: number;
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
}

export interface Telemetry {
  /** Compose with `mergeHooks(...)`. */
  readonly hooks: HttpAppHooks;
}

type Attr = { key: string; value: { stringValue: string } | { intValue: string } };
const str = (key: string, value: string): Attr => ({ key, value: { stringValue: value } });

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const ERROR_CODE = /^RB_[A-Z0-9_]{1,48}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REASON = /^[a-z][a-z0-9_]{0,48}$/;
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
  const resource = {
    attributes: [
      str('service.name', TELEMETRY_SERVICE_NAME),
      str('service.version', VERSION),
      ...(options.runtime === undefined ? [] : [str('process.runtime.name', options.runtime)]),
    ],
  };
  const scope = { name: TELEMETRY_SERVICE_NAME, version: VERSION };

  // Bookkeeping about the exporter itself, not request data.
  let inFlight = 0;
  let pausedUntil = 0;

  const post = async (path: string, body: unknown): Promise<void> => {
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
        redirect: 'error',
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

  const record = async (event: ToolCallEvent, extra: readonly Attr[]): Promise<void> => {
    const end = clock.now();
    const durationMs = Number.isFinite(event.durationMs) ? Math.max(0, event.durationMs) : 0;
    const start = end - durationMs;
    const attrs: Attr[] = [
      str('tool', pick(event.tool, TOOL_NAME)),
      str('status', event.status === 'ok' ? 'ok' : 'error'),
      ...(event.status === 'error' ? [str('error.code', pick(event.errorCode, ERROR_CODE))] : []),
      ...extra,
    ];
    const tasks: Promise<void>[] = [
      post('/v1/metrics', {
        resourceMetrics: [
          {
            resource,
            scopeMetrics: [
              {
                scope,
                metrics: [
                  {
                    name: TELEMETRY_NAMES.toolCalls,
                    unit: '{call}',
                    sum: {
                      aggregationTemporality: 1,
                      isMonotonic: true,
                      dataPoints: [
                        {
                          attributes: attrs,
                          startTimeUnixNano: nanos(start),
                          timeUnixNano: nanos(end),
                          asInt: '1',
                        },
                      ],
                    },
                  },
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
                ],
              },
            ],
          },
        ],
      }),
    ];
    if (sampleRate > 0 && random() < sampleRate) {
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
                      traceId: hex(16),
                      spanId: hex(8),
                      name: TELEMETRY_NAMES.span,
                      kind: 2,
                      startTimeUnixNano: nanos(start),
                      endTimeUnixNano: nanos(end),
                      attributes: attrs,
                      status:
                        event.status === 'ok'
                          ? { code: 1 }
                          : { code: 2, message: pick(event.errorCode, ERROR_CODE) },
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

  const hooks: HttpAppHooks = {
    async onToolCall(_c, info: McpRequestInfo, event) {
      await record(event, [str('project', pick(info.projectSlug, SLUG)), str('mode', 'token')]);
    },
    async onPassthroughToolCall(_c, _info: PassthroughRequestInfo, event) {
      await record(event, [str('mode', 'passthrough')]);
    },
    async onRejected(_c, info: RejectInfo) {
      const now = clock.now();
      const attrs = [
        str('reason', pick(info.reason ?? `http_${info.status}`, REASON)),
        str('http.response.status_code', String(info.status >= 400 && info.status < 600 ? info.status : 0)),
      ];
      await post('/v1/metrics', {
        resourceMetrics: [
          {
            resource,
            scopeMetrics: [
              {
                scope,
                metrics: [
                  {
                    name: TELEMETRY_NAMES.rejected,
                    unit: '{request}',
                    sum: {
                      aggregationTemporality: 1,
                      isMonotonic: true,
                      dataPoints: [
                        {
                          attributes: attrs,
                          startTimeUnixNano: nanos(now),
                          timeUnixNano: nanos(now),
                          asInt: '1',
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      });
    },
  };
  return { hooks };
}
