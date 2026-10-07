// SPDX-License-Identifier: Apache-2.0
// Isolate-local cache of resolved access (THREAT_MODEL T15, T21). One instance per app, never module state. It holds
// the resolved access and the credential *record* (ciphertext only): keys are decrypted per request, so no plaintext
// New Relic key outlives the request that used it.
import type { EffectiveAccess } from '@relic-bridge/auth';
import type { CredentialRecord } from '@relic-bridge/storage';

/** The cache may never keep a decision longer than this (a revocation takes effect within it). */
export const MAX_ACCESS_CACHE_TTL_MS = 60_000;
export const DEFAULT_ACCESS_CACHE_TTL_MS = 30_000;
export const DEFAULT_ACCESS_CACHE_ENTRIES = 1000;

export interface CachedAccess {
  readonly tokenId: string;
  readonly access: EffectiveAccess;
  readonly credential: CredentialRecord;
  /** The OAuth client of an OAuth access token (P5-01); absent or null for device tokens. */
  readonly clientId?: string | null;
  /** Epoch ms after which the entry is ignored: min(now + ttl, token expiry, grant expiry). */
  readonly expiresAt: number;
}

export class AccessCache {
  readonly #ttl: number;
  readonly #max: number;
  readonly #entries = new Map<string, CachedAccess>();

  constructor(ttlMs: number, maxEntries: number = DEFAULT_ACCESS_CACHE_ENTRIES) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 0 || ttlMs > MAX_ACCESS_CACHE_TTL_MS) {
      throw new RangeError(`access cache TTL must be 0-${MAX_ACCESS_CACHE_TTL_MS} ms`);
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('access cache size must be a positive integer');
    }
    this.#ttl = ttlMs;
    this.#max = maxEntries;
  }

  get enabled(): boolean {
    return this.#ttl > 0;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string, now: number): CachedAccess | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (!(now < entry.expiresAt)) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /**
   * Stores a decision for at most the TTL, and never past `limits` (token and grant expiry, null = none).
   * Nothing is stored when the TTL is 0 or the entry would already be expired.
   */
  set(
    key: string,
    value: Omit<CachedAccess, 'expiresAt'>,
    now: number,
    limits: readonly (number | null)[],
  ): void {
    if (this.#ttl === 0) return;
    let expiresAt = now + this.#ttl;
    for (const limit of limits) if (limit !== null && limit < expiresAt) expiresAt = limit;
    if (!(now < expiresAt)) return;
    this.#entries.delete(key);
    // Bounded: drop the oldest insertion first (Map keeps insertion order).
    while (this.#entries.size >= this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    this.#entries.set(key, Object.freeze({ ...value, expiresAt }));
  }

  /** Drop one entry (its access was just refused on a fresh resolution). */
  delete(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }
}
