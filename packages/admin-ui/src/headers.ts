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

/**
 * A `form-action` source for an OAuth redirect URI (P5-04), or null when the URI can't be one. Browsers apply
 * `form-action` to the redirects that follow a form post, so the consent form (posted to us, answered with a redirect to
 * the client) must also allow the client's origin. CSP host sources can't spell an IPv6 literal: `http://[::1]`
 * redirects get the `http:` scheme source instead.
 */
export function formActionSource(redirectUri: string): string | null {
  let u: URL;
  try {
    u = new URL(redirectUri);
  } catch {
    return null;
  }
  if (u.username !== '' || u.password !== '') return null;
  if (u.protocol === 'http:' && u.hostname.startsWith('[')) return 'http:';
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!/^[a-z0-9.-]{1,253}$/.test(u.hostname)) return null;
  return u.origin;
}

/** A source `formActionSource` can return: an http(s) origin with a plain host name or IPv4 address, or `http:`. */
const FORM_ACTION_SOURCE_RE = /^(?:http:|https?:\/\/[a-z0-9.-]{1,253}(?::\d{1,5})?)$/;
const FORM_ACTION_SELF = "form-action 'self'";

/** The UI policy with `form-action` widened to `'self'` and one more source (the consent page, P5-04). */
export function consentCsp(source: string): string {
  if (!FORM_ACTION_SOURCE_RE.test(source)) throw new TypeError('not a form-action source');
  return UI_CSP.replace(FORM_ACTION_SELF, `${FORM_ACTION_SELF} ${source}`);
}

/** Whether a response's CSP is one of the UI's own (kept by the app's security middleware, replaced otherwise). */
export function isUiCsp(value: string | null): boolean {
  if (value === null) return false;
  if (value === UI_CSP) return true;
  const [before, after] = UI_CSP.split(FORM_ACTION_SELF) as [string, string];
  if (!value.startsWith(`${before}${FORM_ACTION_SELF} `) || !value.endsWith(after)) return false;
  const source = value.slice(before.length + FORM_ACTION_SELF.length + 1, value.length - after.length);
  return FORM_ACTION_SOURCE_RE.test(source);
}

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
 * Referrer policy of HTML pages. Not `no-referrer`: with it a browser sends `Origin: null` on every form POST (Fetch
 * spec), which the CSRF check rightly refuses, so no form would ever work. `same-origin` sends the real `Origin` to
 * this server and no referrer at all to anyone else (found by the P4-11 browser run).
 */
export const UI_REFERRER_POLICY = 'same-origin';

/**
 * Headers an HTML page sets itself (the app adds `nosniff`, `X-Frame-Options`, HSTS, …). `no-store` is set here too,
 * not only by the app: pages carry CSRF tokens and the one-time device token page (P4-04) must never be cached.
 */
export const UI_PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': UI_REFERRER_POLICY,
  'Content-Security-Policy': UI_CSP,
  'Cross-Origin-Opener-Policy': 'same-origin',
  // Every subresource is same-origin (P4-12: ZAP 90004), so the strictest embedder policy costs nothing.
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Permissions-Policy': PERMISSIONS_POLICY,
});
