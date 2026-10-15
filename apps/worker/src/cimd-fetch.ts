// SPDX-License-Identifier: Apache-2.0
// The Workers fetcher for OAuth Client ID Metadata Documents (P5-03, ADR-0012, THREAT_MODEL T11). A Worker cannot
// resolve DNS, so the SSRF guard is the platform's: its `fetch` has no route into private networks (no VPC or Tunnel
// binding is configured), and with the `global_fetch_strictly_public` compatibility flag (`wrangler.jsonc`) requests
// to our own zone go through Cloudflare's front door instead of straight to the origin. On top: `redirect: 'manual'`
// (a redirect is a failure), and the http-app checks the client id (https, a DNS name, no internal names, port 443)
// before calling this. Without the flag CIMD stays off.
import { outboundFetch } from '@relic-bridge/core';
import type { ClientMetadataFetch } from '@relic-bridge/http-app';

interface CloudflareGlobal {
  readonly compatibilityFlags?: Readonly<Record<string, boolean>>;
}

/** Whether this Worker runs with `global_fetch_strictly_public` (read from the runtime, never assumed). */
export function hasStrictlyPublicFetch(): boolean {
  const cf = (globalThis as { readonly Cloudflare?: CloudflareGlobal }).Cloudflare;
  return cf?.compatibilityFlags?.['global_fetch_strictly_public'] === true;
}

/** The metadata-document fetcher, or null when the runtime offers no SSRF guard (then CIMD stays off). */
export function strictlyPublicCimdFetch(
  fetcher: typeof fetch = (input, init) => outboundFetch(String(input), init ?? {}),
): ClientMetadataFetch | null {
  if (!hasStrictlyPublicFetch()) return null;
  return (url, init) =>
    fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: init.signal,
    });
}
