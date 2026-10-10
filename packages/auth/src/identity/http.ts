// SPDX-License-Identifier: Apache-2.0
// Outbound calls to identity providers: injected fetch, a timeout, no redirects, a size cap and JSON only. Failures
// become `idp_unavailable` without the response body (it may echo codes or secrets back).
import type { FetchLike } from '@relic-bridge/core';
import { IdentityError } from './errors.ts';

/** Per IdP call. */
export const IDP_TIMEOUT_MS = 10_000;
/** Largest IdP response read (discovery documents and JWKS are a few KiB). */
export const IDP_MAX_RESPONSE_BYTES: number = 256 * 1024;

export interface IdpResponse {
  readonly status: number;
  readonly body: unknown;
}

/** The body as text, refusing (`idp_unavailable`) more than `max` bytes without reading further. */
export async function readCapped(res: Response, max: number): Promise<string> {
  const declared = res.headers.get('content-length');
  if (declared !== null && Number(declared) > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new IdentityError('idp_unavailable', 'identity provider response is too large');
  }
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new IdentityError('idp_unavailable', 'identity provider response is too large');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * Call an IdP endpoint and parse its JSON answer. Any status is returned (callers decide what an error status means);
 * network errors, timeouts, redirects, oversized and non-JSON bodies throw `idp_unavailable`.
 */
export async function idpJson(
  fetch: FetchLike,
  url: string,
  init: RequestInit = {},
  what = 'identity provider',
): Promise<IdpResponse> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(IDP_TIMEOUT_MS),
    });
  } catch {
    throw new IdentityError('idp_unavailable', `${what} is unreachable`);
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    throw new IdentityError('idp_unavailable', `${what} answered with a redirect`);
  }
  let text: string;
  try {
    text = await readCapped(res, IDP_MAX_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof IdentityError) throw error;
    throw new IdentityError('idp_unavailable', `${what} response could not be read`);
  }
  let body: unknown;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    throw new IdentityError('idp_unavailable', `${what} did not answer JSON`);
  }
  return { status: res.status, body };
}

export const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export const isLoopbackHostname = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';

/** An absolute https URL (or http to a loopback host when `allowLoopbackHttp`), without credentials or fragment. */
export function checkEndpoint(value: unknown, allowLoopbackHttp: boolean): URL | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.username !== '' || u.password !== '' || u.hash !== '') return null;
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && allowLoopbackHttp && isLoopbackHostname(u.hostname)) return u;
  return null;
}
