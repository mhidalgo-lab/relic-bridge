// SPDX-License-Identifier: Apache-2.0
// Pass-through mode (P2-15, ARCHITECTURE §3 mode E, THREAT_MODEL T8/T12/T20/T23): the caller sends its own New Relic
// User key in a header and the server stores nothing. This file holds the pieces with no HTTP plumbing: header parsing,
// the key fingerprint and the short-lived identity cache. Web-standard only; no module-level state (T21).
import type { KeyValidator } from '@relic-bridge/auth';
import { type QueryLimits, REGIONS, type Region, Secret } from '@relic-bridge/core';

/** The route, registered only when pass-through is enabled. */
export const PASSTHROUGH_PATH = '/passthrough/mcp';
/** Request header carrying the caller's New Relic User key. Never logged, echoed, stored or forwarded elsewhere. */
export const PASSTHROUGH_KEY_HEADER = 'X-NewRelic-Api-Key';
/** Request header naming the key's data center: `US` (default), `EU` or `JP`. */
export const PASSTHROUGH_REGION_HEADER = 'X-NewRelic-Region';

export const DEFAULT_PASSTHROUGH_IDENTITY_TTL_MS = 60_000;
export const MAX_PASSTHROUGH_IDENTITY_TTL_MS = 300_000;
export const DEFAULT_PASSTHROUGH_IDENTITY_ENTRIES = 1000;
/** Characters of the fingerprint used as the key id in logs, hooks and rate-limit keys (48 bits). */
const KEY_ID_HEX = 12;
/** Characters of the fingerprint used in the credential id that scopes tool caches (128 bits). */
const CREDENTIAL_ID_HEX = 32;
/** Same shape as core's User-key check; anything else is refused before a NerdGraph call is spent on it. */
const USER_KEY_RE = /^NRAK-[A-Za-z0-9]{10,64}$/;

export interface PassthroughOptions {
  /** Seconds-scale cache of a key's reachable accounts, in ms (0-300000, default 60000; 0 validates every request). */
  readonly identityTtlMs?: number;
  /** Most keys whose accounts are cached (default 1000). */
  readonly identityCacheMaxEntries?: number;
  /** Query limits for every pass-through request. Default: `DEFAULT_LIMITS`. */
  readonly limits?: QueryLimits;
  /** Asks New Relic which accounts a key reaches. Default: NerdGraph `actor` query (using the app's `fetch`). */
  readonly validateKey?: KeyValidator;
  /**
   * HMAC secret of the key fingerprint (≥ 32 bytes). Default: random per app instance, so fingerprints mean nothing
   * outside this process. Give a shared one only when several replicas share a rate limiter.
   */
  readonly fingerprintSecret?: Secret;
  /**
   * Refuse plain-HTTP requests unless `hsts: true` (TLS-terminating proxy) or the Host is loopback. Default true:
   * a misconfigured deployment fails loudly instead of collecting keys in clear text.
   */
  readonly requireTls?: boolean;
}

/** What the hooks know about a pass-through request. Never the key: only its fingerprint prefix. */
export interface PassthroughRequestInfo {
  readonly requestId: string;
  /** `pt_` + 12 hex characters of the key's fingerprint: stable per key for this app instance, not reversible. */
  readonly keyId: string;
  readonly region: Region;
  readonly mcpMethod: string | null;
  readonly mcpName: string | null;
  readonly listen: boolean;
  /** The key's reachable accounts (sorted). */
  readonly accounts: readonly number[];
}

export type PassthroughHeaders =
  | { readonly ok: true; readonly key: Secret; readonly region: Region }
  | { readonly ok: false; readonly reason: 'passthrough_missing_key' | 'passthrough_malformed_key' }
  | { readonly ok: false; readonly reason: 'passthrough_bad_region' };

/** Read the two headers. The key is wrapped in a `Secret` before anything else looks at it. */
export function readPassthroughHeaders(
  key: string | null | undefined,
  region: string | null | undefined,
): PassthroughHeaders {
  let parsedRegion: Region = 'US';
  if (region !== undefined && region !== null && region.trim() !== '') {
    const r = region.trim().toUpperCase();
    if (!(REGIONS as readonly string[]).includes(r)) return { ok: false, reason: 'passthrough_bad_region' };
    parsedRegion = r as Region;
  }
  if (key === undefined || key === null || key.trim() === '') {
    return { ok: false, reason: 'passthrough_missing_key' };
  }
  const secret = new Secret(key.trim());
  if (!USER_KEY_RE.test(secret.reveal())) return { ok: false, reason: 'passthrough_malformed_key' };
  return { ok: true, key: secret, region: parsedRegion };
}

/** `CryptoKey`, spelled so it type-checks under both the DOM/webworker lib and `@types/node`. */
type WebCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Keyed, non-reversible key fingerprints (HMAC-SHA-256 over region + key). One per app instance. */
export class KeyFingerprinter {
  readonly #key: Promise<WebCryptoKey>;

  constructor(secret?: Secret) {
    let raw: Uint8Array;
    if (secret === undefined) {
      raw = crypto.getRandomValues(new Uint8Array(32));
    } else {
      raw = new TextEncoder().encode(secret.reveal());
      if (raw.length < 32) throw new RangeError('passthrough.fingerprintSecret must be at least 32 bytes');
    }
    this.#key = crypto.subtle.importKey(
      'raw',
      raw as Uint8Array<ArrayBuffer>,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  }

  /** Full fingerprint (64 hex characters). */
  async fingerprint(key: Secret, region: Region): Promise<string> {
    const data = new TextEncoder().encode(`${region}\n${key.reveal()}`);
    return hex(await crypto.subtle.sign('HMAC', await this.#key, data));
  }
}

/** The log / rate-limit id of a fingerprint. */
export const keyIdOf = (fingerprint: string): string => `pt_${fingerprint.slice(0, KEY_ID_HEX)}`;
/** The credential id that scopes tool caches and limiters for a fingerprint (never the key). */
export const credentialIdOf = (fingerprint: string): string =>
  `pt_${fingerprint.slice(0, CREDENTIAL_ID_HEX)}`;

interface IdentityEntry {
  readonly accounts: readonly number[];
  readonly expiresAt: number;
}

/**
 * Reachable accounts per key fingerprint, for a short TTL and bounded (oldest first). Holds no key, no hash of the key
 * that works outside this app (the fingerprint is keyed), and no New Relic user details.
 */
export class IdentityCache {
  readonly #ttl: number;
  readonly #max: number;
  readonly #entries = new Map<string, IdentityEntry>();

  constructor(ttlMs: number, maxEntries: number) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 0 || ttlMs > MAX_PASSTHROUGH_IDENTITY_TTL_MS) {
      throw new RangeError(`passthrough.identityTtlMs must be 0-${MAX_PASSTHROUGH_IDENTITY_TTL_MS}`);
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('passthrough.identityCacheMaxEntries must be a positive integer');
    }
    this.#ttl = ttlMs;
    this.#max = maxEntries;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(fingerprint: string, now: number): readonly number[] | undefined {
    const e = this.#entries.get(fingerprint);
    if (e === undefined) return undefined;
    if (!(now < e.expiresAt)) {
      this.#entries.delete(fingerprint);
      return undefined;
    }
    return e.accounts;
  }

  set(fingerprint: string, accounts: readonly number[], now: number): void {
    if (this.#ttl === 0) return;
    this.#entries.delete(fingerprint);
    this.#entries.set(fingerprint, { accounts: Object.freeze([...accounts]), expiresAt: now + this.#ttl });
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}

/** Positive, unique, sorted account ids from a validator's answer. */
export function reachableAccounts(accounts: readonly { readonly id: number }[] | undefined): number[] {
  return [
    ...new Set((accounts ?? []).map((a) => a.id).filter((id) => Number.isSafeInteger(id) && id > 0)),
  ].sort((a, b) => a - b);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Whether a `Host` value (with or without port) names this machine. */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (typeof host !== 'string' || host === '') return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(`http://${host}`).hostname.toLowerCase());
  } catch {
    return false;
  }
}
