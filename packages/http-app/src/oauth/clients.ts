// SPDX-License-Identifier: Apache-2.0
// OAuth client registration policy (P5-03, ADR-0012, THREAT_MODEL T9/T10/T11). Web-standard only.
//
// - Client ID Metadata Documents (CIMD, draft-ietf-oauth-client-id-metadata-document, MCP 2026-07-28): a `client_id`
//   that is an https URL names a JSON document describing the client. relic-bridge fetches and validates it here (the
//   provider's own CIMD stays off) through a fetcher the host supplies with an SSRF guard (Node: connect-time address
//   check; Workers: `global_fetch_strictly_public`). The client id is checked before anything is fetched: canonical,
//   https, a DNS name (no IP literal or internal name), port 443, not ourselves. The fetch is bounded (no redirects,
//   5 s, 5 KiB, JSON media type). Only redirect URIs on the client id's own host, or loopback, are kept.
// - Dynamic Client Registration (RFC 7591): the request is checked before the provider stores anything (redirect URI
//   shape, optional host allow-list, display name).
// Display names are untrusted text either way: control, format (bidi, zero-width) and separator characters are refused
// so a consent screen can't be made to show something other than what was registered.

/** Fetches a client metadata document. Must refuse non-public destinations and must not follow redirects. */
export type ClientMetadataFetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;

/** Largest metadata document read (the draft's recommended maximum). */
export const CIMD_MAX_BYTES: number = 5 * 1024;
/** Time allowed for the whole fetch, body included. */
export const CIMD_TIMEOUT_MS = 5000;
/** Cache lifetime bounds of a validated document (the draft lets the server bound HTTP cache lifetimes). */
export const CIMD_MIN_TTL_S = 300;
export const CIMD_MAX_TTL_S = 86_400;
/** Cache lifetime when the document sends no usable `Cache-Control`. */
export const CIMD_DEFAULT_TTL_S = 3600;
export const MAX_CLIENT_ID_URL_CHARS = 512;
export const MAX_REDIRECT_URIS = 10;
export const MAX_REDIRECT_URI_CHARS = 2000;
export const MAX_CLIENT_NAME_CHARS = 100;

/** Host names that never name a public client (RFC 6761/6762/8375 special-use, common internal suffixes). */
const INTERNAL_SUFFIXES: readonly string[] = [
  'localhost',
  'local',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'private',
  'arpa',
  'test',
  'invalid',
  'example',
  'onion',
];

/** A refused client: `reason` is a stable code for logs (never shown to the caller, never contains input). */
export class ClientMetadataError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`client metadata refused: ${reason}`);
    this.name = 'ClientMetadataError';
    this.reason = reason;
  }
}

// ------------------------------------------------------------------------------------------------- addresses

/** IPv4 dotted quad → 32-bit number, or null. (URL parsing already normalises other IPv4 spellings to this form.) */
export function parseIpv4(text: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (m === null) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255 || ((m[i] as string).length > 1 && (m[i] as string).startsWith('0'))) return null;
    n = n * 256 + octet;
  }
  return n;
}

/** IPv6 text (no brackets, no zone) → eight 16-bit groups, or null. Accepts `::` and a trailing dotted IPv4. */
export function parseIpv6(text: string): number[] | null {
  if (text.length === 0 || text.length > 45 || !/^[0-9A-Fa-f:.]+$/.test(text)) return null;
  let head = text;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.')) {
    const v4 = parseIpv4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    tail.push(Math.floor(v4 / 65536), v4 % 65536);
    head = text.slice(0, lastColon + 1);
    // `::1.2.3.4` leaves `::`; `a:b::1.2.3.4` leaves `a:b::`; `a:…:1.2.3.4` leaves a trailing single colon.
    if (head.endsWith(':') && !head.endsWith('::')) head = head.slice(0, -1);
  }
  const parts = head.split('::');
  if (parts.length > 2) return null;
  const groups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9A-Fa-f]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const left = groups(parts[0] as string);
  const right = parts.length === 2 ? groups(parts[1] as string) : [];
  if (left === null || right === null) return null;
  const known = left.length + right.length + tail.length;
  if (parts.length === 2) {
    if (known > 7) return null;
    return [...left, ...new Array<number>(8 - known).fill(0), ...right, ...tail];
  }
  return known === 8 ? [...left, ...tail] : null;
}

/** Blocked IPv4 ranges: this network, private, CGNAT, loopback, link-local (cloud metadata), IETF, docs, benchmarks, multicast, reserved. */
const BLOCKED_V4: readonly (readonly [number, number])[] = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0586300, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
];

function publicV4(n: number): boolean {
  return !BLOCKED_V4.some(
    ([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)),
  );
}

/**
 * Whether an IP address (v4 dotted, or v6 without brackets) is a public unicast address a server may connect to.
 * Anything unparseable is not. IPv6 must be global unicast (2000::/3) outside the special-purpose blocks; IPv4-mapped,
 * NAT64 and 6to4 addresses are judged by the IPv4 address they carry.
 */
export function isPublicIp(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4 !== null) return publicV4(v4);
  const g = parseIpv6(address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address);
  if (g === null) return false;
  const [a, b, c, d, e, f, x, y] = g as [number, number, number, number, number, number, number, number];
  const embedded = x * 65536 + y;
  // ::ffff:a.b.c.d (mapped) and 64:ff9b::a.b.c.d (NAT64, RFC 6052): the IPv4 address decides.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return publicV4(embedded);
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return publicV4(embedded);
  // 2002::/16 (6to4) carries the IPv4 address in groups 2-3.
  if (a === 0x2002) return publicV4(b * 65536 + c);
  if (a < 0x2000 || a > 0x3fff) return false; // outside global unicast: ::, ::1, ULA, link-local, multicast, …
  if (a === 0x2001 && b < 0x0200) return false; // 2001::/23 IETF protocol assignments (Teredo, ORCHIDv2, …)
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  if (a === 0x3fff && b < 0x1000) return false; // 3fff::/20 documentation (RFC 9637)
  return true;
}

/** `localhost`, 127.0.0.0/8 or `[::1]` (RFC 8252 loopback redirect hosts). `hostname` as `URL.hostname` gives it. */
export function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  const v4 = parseIpv4(hostname);
  if (v4 !== null) return Math.floor(v4 / 2 ** 24) === 127;
  return hostname === '[::1]';
}

/** Whether `URL.hostname` is an IP literal (v4, or bracketed v6). */
export function isIpLiteral(hostname: string): boolean {
  return parseIpv4(hostname) !== null || (hostname.startsWith('[') && hostname.endsWith(']'));
}

// ------------------------------------------------------------------------------------------------- text

/** Refused in display names: controls, format characters (bidi overrides, zero-width), line/paragraph separators, private use. */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}]/u;

/** A word mixing Latin letters with Cyrillic or Greek ones: the look-alike trick ("Clаude" with a Cyrillic "а", P5-12). */
const MIXED_SCRIPT_WORD = /(?=\S*\p{Script=Latin})(?=\S*[\p{Script=Cyrillic}\p{Script=Greek}])\S+/u;

/** A client display name, or null when it is unsafe, too long or spells a word with look-alike letters. */
export function safeClientName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (
    name.length === 0 ||
    [...name].length > MAX_CLIENT_NAME_CHARS ||
    // The whole value, not only the trimmed name: `trim()` drops tabs, newlines, U+FEFF and U+2028/2029 at the ends,
    // and the registration stores the value as sent (P8-87).
    UNSAFE_TEXT.test(value) ||
    MIXED_SCRIPT_WORD.test(name)
  )
    return null;
  return name;
}

// ------------------------------------------------------------------------------------------------- client ids

/** Whether the provider would take this client id for a metadata-document URL (then we resolve it, or refuse it). */
export function looksLikeClientIdUrl(clientId: string): boolean {
  return /^[\s\p{Cc}]*https:/iu.test(clientId);
}

/**
 * Why a CIMD `client_id` is refused before anything is fetched, or null when it may be fetched. `issuerHost` is our own
 * host name (a document on it would be fetched from ourselves).
 */
export function clientIdUrlProblem(clientId: string, issuerHost: string): string | null {
  if (clientId.length > MAX_CLIENT_ID_URL_CHARS) return 'client_id_too_long';
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return 'client_id_not_url';
  }
  // Canonical form only: no dot segments, no uppercase scheme or host, no `:443`, no `\`, nothing the parser rewrites.
  // The draft compares the document's client_id with the URL as a string, so this costs real clients nothing.
  if (url.href !== clientId) return 'client_id_not_canonical';
  if (url.protocol !== 'https:') return 'client_id_not_https';
  if (url.username !== '' || url.password !== '') return 'client_id_userinfo';
  if (clientId.includes('#')) return 'client_id_fragment';
  if (url.port !== '') return 'client_id_port';
  if (url.pathname === '/' || url.pathname === '') return 'client_id_no_path';
  const host = url.hostname;
  if (isIpLiteral(host)) return 'client_id_ip_literal';
  if (!host.includes('.') || host.endsWith('.')) return 'client_id_internal_name';
  const tld = host.slice(host.lastIndexOf('.') + 1);
  if (INTERNAL_SUFFIXES.includes(tld)) return 'client_id_internal_name';
  if (host === issuerHost) return 'client_id_self';
  return null;
}

// ------------------------------------------------------------------------------------------------- redirect URIs

/** What a redirect URI is under our policy. `bad:*` refuses the whole document or registration. */
export type RedirectVerdict = 'usable' | 'unusable' | `bad:${string}`;

export interface RedirectPolicy {
  /** CIMD: https redirects must be on this host. */
  readonly clientHost?: string;
  /** DCR: when set, https redirects must be on one of these hosts (lowercase). */
  readonly allowedHosts?: readonly string[];
}

/**
 * Checks one redirect URI. Structural problems (no URL, fragment, wildcard, userinfo, whitespace, too long) are `bad`.
 * `usable`: https on a non-IP host (or a loopback IP), or http on loopback, within the policy's hosts.
 * `unusable`: anything else that is well-formed (another host, a private-use scheme): it can be listed but never gets a code.
 */
export function redirectUriVerdict(uri: unknown, policy: RedirectPolicy): RedirectVerdict {
  if (typeof uri !== 'string' || uri.length === 0) return 'bad:redirect_uri_type';
  if (uri.length > MAX_REDIRECT_URI_CHARS) return 'bad:redirect_uri_too_long';
  if (/[\s\p{Cc}]/u.test(uri)) return 'bad:redirect_uri_whitespace';
  if (uri.includes('#')) return 'bad:redirect_uri_fragment';
  if (uri.includes('*')) return 'bad:redirect_uri_wildcard';
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'bad:redirect_uri_not_url';
  }
  if (url.username !== '' || url.password !== '') return 'bad:redirect_uri_userinfo';
  const host = url.hostname;
  if (url.protocol === 'http:') return isLoopbackHost(host) ? 'usable' : 'bad:redirect_uri_http';
  if (url.protocol !== 'https:') return 'unusable';
  if (isLoopbackHost(host)) return 'usable';
  if (isIpLiteral(host)) return 'bad:redirect_uri_ip_literal';
  if (policy.clientHost !== undefined && host !== policy.clientHost) return 'unusable';
  if (policy.allowedHosts !== undefined && !policy.allowedHosts.includes(host))
    return 'bad:redirect_uri_host';
  return 'usable';
}

// ------------------------------------------------------------------------------------------------- DCR

export type RegistrationVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: 'invalid_redirect_uri' | 'invalid_client_metadata';
      readonly reason: string;
    };

/** RFC 7591 request checks that come before the provider stores anything. */
export function checkRegistration(body: string, allowedHosts?: readonly string[]): RegistrationVerdict {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, error: 'invalid_client_metadata', reason: 'not_json' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'invalid_client_metadata', reason: 'not_object' };
  }
  const meta = raw as Record<string, unknown>;
  const uris = meta['redirect_uris'];
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return { ok: false, error: 'invalid_redirect_uri', reason: 'redirect_uris_count' };
  }
  const policy: RedirectPolicy = allowedHosts === undefined ? {} : { allowedHosts };
  let usable = false;
  for (const uri of uris) {
    const verdict = redirectUriVerdict(uri, policy);
    if (verdict.startsWith('bad:'))
      return { ok: false, error: 'invalid_redirect_uri', reason: verdict.slice(4) };
    if (verdict === 'usable') usable = true;
  }
  if (!usable) return { ok: false, error: 'invalid_redirect_uri', reason: 'no_usable_redirect_uri' };
  if ('client_name' in meta && safeClientName(meta['client_name']) === null) {
    return { ok: false, error: 'invalid_client_metadata', reason: 'client_name' };
  }
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------- CIMD

/** The provider's client record for a metadata-document client (a public client; display fields: the name only). */
export interface MetadataDocumentClient {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: readonly string[];
  readonly tokenEndpointAuthMethod: 'none';
  readonly grantTypes: readonly string[];
  readonly responseTypes: readonly string[];
  /** Epoch seconds of the fetch. */
  readonly registrationDate: number;
}

const SUPPORTED_GRANTS = ['authorization_code', 'refresh_token'];

/** Validates a parsed document for `clientId` (the URL it was fetched from) into a client record. */
export function validateMetadataDocument(
  clientId: string,
  value: unknown,
  nowSeconds: number,
): MetadataDocumentClient {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ClientMetadataError('not_object');
  const doc = value as Record<string, unknown>;
  // Simple string comparison (draft §4.1): the document names exactly the URL it was served from.
  if (doc['client_id'] !== clientId) throw new ClientMetadataError('client_id_mismatch');
  const clientName = safeClientName(doc['client_name']);
  if (clientName === null) throw new ClientMetadataError('client_name');
  // Draft §4.1: no shared secrets. Only public clients here (`private_key_jwt` is out of scope).
  if ('client_secret' in doc || 'client_secret_expires_at' in doc)
    throw new ClientMetadataError('client_secret');
  const method = doc['token_endpoint_auth_method'];
  if (method !== undefined && method !== 'none') throw new ClientMetadataError('token_endpoint_auth_method');
  const strings = (v: unknown, fallback: readonly string[], what: string): readonly string[] => {
    if (v === undefined) return fallback;
    if (!Array.isArray(v) || v.length > 10 || !v.every((s) => typeof s === 'string'))
      throw new ClientMetadataError(what);
    return v as string[];
  };
  // Grants and response types we don't support are dropped; the code flow must be there.
  const grantTypes = strings(doc['grant_types'], ['authorization_code'], 'grant_types').filter((g) =>
    SUPPORTED_GRANTS.includes(g),
  );
  if (!grantTypes.includes('authorization_code')) throw new ClientMetadataError('grant_types');
  const responseTypes = strings(doc['response_types'], ['code'], 'response_types');
  if (!responseTypes.includes('code')) throw new ClientMetadataError('response_types');
  const uris = doc['redirect_uris'];
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    throw new ClientMetadataError('redirect_uris_count');
  }
  const clientHost = new URL(clientId).hostname;
  const redirectUris: string[] = [];
  for (const uri of uris) {
    const verdict = redirectUriVerdict(uri, { clientHost });
    if (verdict.startsWith('bad:')) throw new ClientMetadataError(verdict.slice(4));
    if (verdict === 'usable') redirectUris.push(uri as string);
  }
  if (redirectUris.length === 0) throw new ClientMetadataError('no_usable_redirect_uri');
  return Object.freeze({
    clientId,
    clientName,
    redirectUris: Object.freeze([...new Set(redirectUris)]),
    tokenEndpointAuthMethod: 'none',
    grantTypes: Object.freeze([...new Set(grantTypes)]),
    responseTypes: Object.freeze(['code']),
    registrationDate: nowSeconds,
  });
}

/** Cache lifetime (seconds) of a validated document from its `Cache-Control`, within our bounds. */
export function metadataCacheTtl(cacheControl: string | null): number {
  if (cacheControl === null) return CIMD_DEFAULT_TTL_S;
  const cc = cacheControl.toLowerCase();
  if (/(?:^|,)\s*(?:no-store|no-cache|private)\b/.test(cc)) return CIMD_MIN_TTL_S;
  const m =
    /(?:^|,)\s*s-maxage\s*=\s*"?(\d{1,10})/.exec(cc) ?? /(?:^|,)\s*max-age\s*=\s*"?(\d{1,10})/.exec(cc);
  if (m === null) return CIMD_DEFAULT_TTL_S;
  return Math.min(CIMD_MAX_TTL_S, Math.max(CIMD_MIN_TTL_S, Number(m[1])));
}

const JSON_TYPE = /^application\/(?:json|[a-z0-9.!#$&^_-]+\+json)$/;

/**
 * Reads at most `max` bytes of a body; null when it is larger (the stream is cancelled). Honours `signal` between chunks.
 */
export async function readBoundedBytes(
  body: ReadableStream<Uint8Array> | null,
  max: number,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  // An abort cancels the stream, which ends a pending read: a body that stops sending can't hold the request.
  const onAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new ClientMetadataError('timeout');
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new ClientMetadataError('timeout');
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return all;
}

/**
 * Fetches and validates the metadata document of `clientId` (already checked with {@link clientIdUrlProblem}).
 * Resolves the client record and its cache lifetime; throws {@link ClientMetadataError} otherwise. Nothing is cached
 * here: the caller stores a validated record only (errors are never cached, draft §4.4).
 */
export async function fetchMetadataDocument(
  clientId: string,
  fetcher: ClientMetadataFetch,
  nowSeconds: number,
): Promise<{ readonly client: MetadataDocumentClient; readonly ttlSeconds: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CIMD_TIMEOUT_MS);
  let response: Response | undefined;
  try {
    try {
      response = await fetcher(clientId, { signal: controller.signal });
    } catch {
      throw new ClientMetadataError(controller.signal.aborted ? 'timeout' : 'fetch_failed');
    }
    // No redirects: a document must be served from its own URL (and a redirect could lead anywhere, T11).
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new ClientMetadataError('redirect');
    }
    if (response.status !== 200) throw new ClientMetadataError('http_status');
    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!JSON_TYPE.test(mediaType)) throw new ClientMetadataError('content_type');
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d{1,15}$/.test(declared) || Number(declared) > CIMD_MAX_BYTES)) {
      throw new ClientMetadataError('too_large');
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await readBoundedBytes(response.body, CIMD_MAX_BYTES, controller.signal);
    } catch {
      throw new ClientMetadataError(controller.signal.aborted ? 'timeout' : 'fetch_failed');
    }
    if (bytes === null) throw new ClientMetadataError('too_large');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new ClientMetadataError('not_utf8');
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ClientMetadataError('not_json');
    }
    const client = validateMetadataDocument(clientId, value, nowSeconds);
    return { client, ttlSeconds: metadataCacheTtl(response.headers.get('cache-control')) };
  } catch (error) {
    await response?.body?.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
