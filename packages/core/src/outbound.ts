// SPDX-License-Identifier: Apache-2.0
// The outbound redirect policy (P8-96, ASVS V15.3.2, THREAT_MODEL T13/T15). Web-standard only (ADR-0004).
//
// Every request relic-bridge makes to another server (NerdGraph, identity providers and their key sets, OTLP, the
// admin CLI's own server, the `doctor` probes, client metadata documents) goes through `outboundFetch` or a fetch
// wrapped by `noRedirects`. A redirect is never followed: it could carry an `API-Key`, a bearer token or a request
// body to a host nobody configured. `manual` (not `error`) is the default so the caller sees the 3xx and answers with
// its own clear error instead of a generic network failure; a caller may ask for the stricter `error`.
// `scripts/test/outbound-redirects.test.ts` fails when source code calls the global `fetch` directly.
import type { FetchLike } from './nerdgraph/client.ts';

/** The `redirect` mode an outbound request really gets: `error` when asked for, else `manual`. Never `follow`. */
export function outboundRedirectMode(requested: RequestInit['redirect']): 'manual' | 'error' {
  return requested === 'error' ? 'error' : 'manual';
}

/** `fetch` with the redirect policy applied, whatever the caller put in `init.redirect`. */
export const outboundFetch: FetchLike = (url, init) =>
  globalThis.fetch(url, { ...init, redirect: outboundRedirectMode(init?.redirect) });

/** Wraps any fetch (an injected one included) so a request it is given can never be set to follow redirects. */
export function noRedirects(fetch: FetchLike): FetchLike {
  return (url, init) => fetch(url, { ...init, redirect: outboundRedirectMode(init?.redirect) });
}
