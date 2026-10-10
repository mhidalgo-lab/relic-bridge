// SPDX-License-Identifier: Apache-2.0
// Response hardening and request-origin checks (THREAT_MODEL T13 spirit, T24). Web-standard only.
import {
  localhostAllowedHostnames,
  validateHostHeader,
  validateOriginHeader,
} from '@modelcontextprotocol/server';
import { ASSET_CACHE_CONTROL, PERMISSIONS_POLICY, UI_CSP, UI_REFERRER_POLICY } from '@relic-bridge/admin-ui';

/** One year, the usual HSTS preload minimum. */
export const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

/**
 * Headers set on every response. The app serves JSON and SSE only, so the CSP forbids everything (it also covers any
 * error page a proxy might render inside our origin).
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  // On every response, assets and JSON included (P4-12: ZAP 10063 flagged the script asset).
  'Permissions-Policy': PERMISSIONS_POLICY,
  'Cache-Control': 'no-store',
});

/**
 * Set the security headers. Two values a response may bring survive (P4-03), compared exactly: the admin UI's page CSP
 * (`UI_CSP`, HTML pages under `/admin` and `/auth`) and the immutable cache header of the hashed UI assets. Any other
 * CSP or caching a handler set is replaced.
 */
export function applySecurityHeaders(headers: Headers, hsts: boolean): void {
  const uiPage = headers.get('content-security-policy') === UI_CSP;
  const asset = headers.get('cache-control') === ASSET_CACHE_CONTROL;
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (name === 'Content-Security-Policy' && uiPage) continue;
    if (name === 'Cache-Control' && asset) continue;
    // A browser sends `Origin: null` on a form POST under `no-referrer`, which the CSRF check must refuse: the admin
    // pages use `same-origin` (a real Origin to ourselves, nothing to anyone else).
    if (name === 'Referrer-Policy' && uiPage) {
      headers.set(name, UI_REFERRER_POLICY);
      continue;
    }
    headers.set(name, value);
  }
  if (hsts) headers.set('Strict-Transport-Security', HSTS_VALUE);
  // Never advertise the framework.
  headers.delete('X-Powered-By');
}

/** Default Host / Origin allowlist: the loopback names (`localhost`, `127.0.0.1`, `[::1]`). */
export function defaultAllowedHostnames(): string[] {
  return localhostAllowedHostnames();
}

export type HostCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** DNS-rebinding protection: the `Host` header must name one of `allowed` (port-agnostic). `'*'` disables it. */
export function checkHost(host: string | null | undefined, allowed: readonly string[] | '*'): HostCheck {
  if (allowed === '*') return { ok: true };
  const r = validateHostHeader(host, [...allowed]);
  return r.ok ? { ok: true } : { ok: false, reason: r.errorCode };
}

/**
 * Browser cross-origin protection (MCP transport spec: servers MUST validate `Origin`). A missing `Origin` passes
 * (non-browser clients don't send one); any present value must name an allowed hostname, and `null` is refused.
 */
export function checkOrigin(origin: string | null | undefined, allowed: readonly string[]): HostCheck {
  const r = validateOriginHeader(origin, [...allowed]);
  return r.ok ? { ok: true } : { ok: false, reason: r.errorCode };
}

/** Hostname of an origin URL (`https://app.example.com:8443` → `app.example.com`), or null when not an origin. */
export function originHostname(origin: string): string | null {
  try {
    const u = new URL(origin);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin !== origin) return null;
    return u.hostname.startsWith('[') ? u.hostname : u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

const MCP_HEADER_RE = /^[A-Za-z0-9_.:/=+-]{1,128}$/;

/** `Mcp-Method` / `Mcp-Name` for logs and hooks: kept only when short and plain, else null (never echoed raw). */
export function safeMcpHeader(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return MCP_HEADER_RE.test(v) ? v : null;
}
