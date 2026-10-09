// SPDX-License-Identifier: Apache-2.0
// Response headers of every admin UI page (P4-03, THREAT_MODEL T13). The HTTP app's security middleware keeps exactly
// this policy on HTML pages and replaces anything else with its JSON-only `default-src 'none'`.

/**
 * Content Security Policy of every HTML page: nothing inline (no `unsafe-inline`, no nonces needed: the pages carry
 * no inline script or style at all), scripts and styles only from our own origin, forms only to our own origin, never
 * framed, no `<base>`, and Trusted Types so no script can feed strings to HTML sinks.
 */
export const UI_CSP: string = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "require-trusted-types-for 'script'",
].join('; ');

/** Powerful features the admin never needs. */
export const PERMISSIONS_POLICY: string = [
  'accelerometer=()',
  'camera=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'payment=()',
  'usb=()',
].join(', ');

/**
 * Headers an HTML page sets itself (the app adds `nosniff`, `X-Frame-Options`, HSTS, …). `no-store` is set here too,
 * not only by the app: pages carry CSRF tokens and the one-time device token page (P4-04) must never be cached.
 */
export const UI_PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': UI_CSP,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': PERMISSIONS_POLICY,
});
