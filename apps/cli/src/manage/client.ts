// SPDX-License-Identifier: Apache-2.0
// One client interface over the Admin API (P2-09) with two transports: HTTPS to a remote instance, or in-process
// against the local SQLite database. Every command is written once against `AdminClient`.
import { redact } from '@relic-bridge/core';
import { ConfigError } from '../config.ts';
import type { ManageHost } from './io.ts';

export const ADMIN_BASE = '/api/admin/v1';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface CallOptions {
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
}

export interface AdminClient {
  readonly mode: 'local' | 'remote';
  /** `https://host` of a remote instance, `null` locally. */
  readonly baseUrl: string | null;
  /** Raw call: returns the status and parsed JSON body (`null` for 204). */
  call(method: string, path: string, options?: CallOptions): Promise<{ status: number; body: unknown }>;
  close(): Promise<void>;
}

/** An error answer from the Admin API (`{error:{code,message}}`). Messages are server text, redacted again here. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;
  readonly detail: string | undefined;
  constructor(status: number, code: string, message: string, field?: string, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field;
    this.detail = detail;
  }
}

/** Call and unwrap: a 4xx/5xx becomes an {@link ApiError}. */
export async function api<T = unknown>(
  client: AdminClient,
  method: string,
  path: string,
  options?: CallOptions,
): Promise<T> {
  const { status, body } = await client.call(method, path, options);
  if (status >= 400) throw toApiError(status, body);
  return body as T;
}

function toApiError(status: number, body: unknown): ApiError {
  const err = (body as { error?: Record<string, unknown> } | null)?.error;
  const text = (v: unknown): string | undefined =>
    typeof v === 'string' ? redact(v).slice(0, 300) : undefined;
  return new ApiError(
    status,
    text(err?.['code']) ?? `http_${status}`,
    text(err?.['message']) ?? `the server answered ${status}`,
    text(err?.['field']),
    text(err?.['detail']),
  );
}

export function buildPath(path: string, query?: CallOptions['query']): string {
  if (query === undefined) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
  const s = qs.toString();
  return s === '' ? path : `${path}?${s}`;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validate `--remote`: https only, with `--insecure` allowing plain http solely for a loopback host. No credentials,
 * path, query or fragment in the URL (the admin token travels in a header, never the URL).
 */
export function parseRemoteUrl(raw: string, insecure: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('--remote is not a valid URL.', 'Example: https://relic-bridge.example.com');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConfigError('--remote must not contain credentials.');
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    throw new ConfigError('--remote takes only the server origin (https://host[:port]).');
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:') {
    if (!insecure) {
      throw new ConfigError(
        '--remote must be an https URL.',
        'Plain http sends the admin token in clear text. For a server on this machine use --insecure with localhost.',
      );
    }
    if (!LOOPBACK.has(url.hostname)) {
      throw new ConfigError('--insecure only allows http for localhost, 127.0.0.1 or [::1].');
    }
    return url;
  }
  throw new ConfigError('--remote must be an https URL.');
}

export function remoteClient(host: ManageHost, url: URL, adminToken: string): AdminClient {
  const origin = url.origin;
  return {
    mode: 'remote',
    baseUrl: origin,
    async call(method, path, options) {
      const target = `${origin}${ADMIN_BASE}${buildPath(path, options?.query)}`;
      const headers: Record<string, string> = {
        authorization: `Bearer ${adminToken}`,
        accept: 'application/json',
        'user-agent': 'relic-bridge-cli',
      };
      const init: RequestInit = {
        method,
        headers,
        // The bearer must never follow a redirect to another origin.
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      };
      if (options?.body !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(options.body);
      }
      let res: Response;
      try {
        res = await host.fetch(target, init);
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        throw new ConfigError(
          name === 'TimeoutError' ? `${origin} did not answer in time.` : `Could not reach ${origin}.`,
          'Check the URL, your network and that the server is running. Redirects are refused.',
        );
      }
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > MAX_RESPONSE_BYTES) throw new ConfigError('The server answer is too large.');
      const text = await res.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new ConfigError('The server answer is too large.');
      if (res.status === 204 || text === '') return { status: res.status, body: null };
      try {
        return { status: res.status, body: JSON.parse(text) as unknown };
      } catch {
        throw new ConfigError(
          `${origin} did not answer like a relic-bridge admin API (status ${res.status}).`,
        );
      }
    },
    close: () => Promise.resolve(),
  };
}
