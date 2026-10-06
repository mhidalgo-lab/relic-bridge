// SPDX-License-Identifier: Apache-2.0
// NRQL query cache (P7-02, THREAT_MODEL T16). Web-standard APIs only (ADR-0004): Map, WebCrypto, the Cache API.
//
// Isolation is the point of this module. An entry id is an HMAC-SHA-256 over a length-prefixed, versioned encoding of
// everything that decides what a query may return to *this* caller: the cache scope (stdio / grant / pass-through),
// credential id, region, a SHA-256 fingerprint of the NR key, the effective accounts, the query limits, the stats flag,
// the normalised NRQL actually sent and the time bucket. Entries are never shared across any of these. Ids are opaque
// hex: no key, token or NRQL text appears in an id or a Cache API URL.
//
// The cache object belongs to the host runtime (process or isolate) and reaches tools only through
// `ToolContext.queryCache` (T21: no module-level request state). It holds query results under the isolation key above,
// never credentials.
import type { ToolContext } from '../context.ts';
import { tokenize } from '../nrql/tokenize.ts';

/** `CryptoKey`, spelled so it type-checks under both the webworker lib and `@types/node`. */
export type CacheCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export type QueryCacheStatus = 'hit' | 'miss' | 'bypass' | 'off';
export type QueryCacheStoreName = 'memory' | 'colo';

/** What the cache did for one query, reported in `_meta["relic-bridge/result"].cache`. */
export interface QueryCacheInfo {
  readonly status: QueryCacheStatus;
  /** Where a hit came from. */
  readonly store?: QueryCacheStoreName;
  /** Hit: how old the entry is. */
  readonly ageSeconds?: number;
  /** Hit: the entry's lifetime; miss / bypass: the lifetime of the entry just written. */
  readonly ttlSeconds?: number;
  /** Miss / bypass: whether the fresh result was stored (false: too large, or no store could take it). */
  readonly stored?: boolean;
}

/** One stored result: the serialised outcome and its validity window (epoch ms). */
export interface QueryCacheEntry {
  readonly body: string;
  readonly storedAt: number;
  readonly expiresAt: number;
}

/** A place to keep entries. Stores never throw for a miss; failures are reported as rejections and treated as misses. */
export interface QueryCacheStore {
  readonly name: QueryCacheStoreName;
  /** Each call is a platform subrequest (Workers Cache API) and spends the request budget. */
  readonly spendsBudget: boolean;
  get(id: string, now: number): Promise<QueryCacheEntry | undefined>;
  put(id: string, entry: QueryCacheEntry): Promise<void>;
}

/** Valid at `now`: stored no later than now (a clock that went back is a miss) and not yet expired. */
export const isFresh = (entry: Pick<QueryCacheEntry, 'storedAt' | 'expiresAt'>, now: number): boolean =>
  entry.storedAt <= now && now < entry.expiresAt;

const encoder = new TextEncoder();

export interface MemoryStoreOptions {
  /** Most entries kept (default 500). */
  readonly maxEntries?: number;
  /** Most UTF-16 bytes of bodies kept (default 16 MiB). */
  readonly maxBytes?: number;
}

export const DEFAULT_MEMORY_MAX_ENTRIES = 500;
export const DEFAULT_MEMORY_MAX_BYTES: number = 16 * 1024 * 1024;

/** Bounded LRU in memory (Node process or Workers isolate). Bodies are strings, parsed per hit: no shared objects. */
export class MemoryQueryCacheStore implements QueryCacheStore {
  readonly name = 'memory' as const;
  readonly spendsBudget = false;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly #entries = new Map<string, QueryCacheEntry>();
  #bytes = 0;

  constructor(options: MemoryStoreOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MEMORY_MAX_ENTRIES));
    this.maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_MEMORY_MAX_BYTES));
  }

  /** Entries and bytes held now (tests, diagnostics). */
  get size(): { entries: number; bytes: number } {
    return { entries: this.#entries.size, bytes: this.#bytes };
  }

  get(id: string, now: number): Promise<QueryCacheEntry | undefined> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return Promise.resolve(undefined);
    this.#remove(id, entry);
    if (!isFresh(entry, now)) return Promise.resolve(undefined);
    this.#entries.set(id, entry); // most recently used last
    this.#bytes += cost(entry);
    return Promise.resolve(entry);
  }

  put(id: string, entry: QueryCacheEntry): Promise<void> {
    const old = this.#entries.get(id);
    if (old !== undefined) this.#remove(id, old);
    if (cost(entry) > this.maxBytes) return Promise.resolve();
    this.#entries.set(id, entry);
    this.#bytes += cost(entry);
    for (const [key, value] of this.#entries) {
      if (this.#entries.size <= this.maxEntries && this.#bytes <= this.maxBytes) break;
      this.#remove(key, value);
    }
    return Promise.resolve();
  }

  #remove(id: string, entry: QueryCacheEntry): void {
    this.#entries.delete(id);
    this.#bytes -= cost(entry);
  }
}

/** Memory held by an entry: JS strings take up to two bytes per code unit. */
const cost = (entry: QueryCacheEntry): number => entry.body.length * 2;

/** The parts of the Workers Cache API this store uses (`caches.open(...)` or `caches.default`). */
export interface CacheApiLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/** Synthetic origin for Cache API keys: `.invalid` never resolves, so no real request can match or poison an entry. */
export const CACHE_API_ORIGIN = 'https://query-cache.relic-bridge.invalid';
const CACHE_API_AAD = 'relic-bridge/query-cache/v1:';
const IV_BYTES = 12;

export interface CacheApiStoreOptions {
  /** The Cache API instance, or a function that opens it (called once, lazily). */
  readonly cache: CacheApiLike | (() => Promise<CacheApiLike>);
  /** AES-256-GCM key (derived from the master key) that encrypts every body. */
  readonly aesKey: CacheCryptoKey;
}

/**
 * Per-colo Workers Cache API store. The Cache API is shared by every request in a data center, so bodies are AES-GCM
 * encrypted (AAD = the entry id: an entry copied under another id fails to open) and the validity window lives inside
 * the ciphertext, re-checked on read. Responses carry `Cache-Control: max-age` only (never `public`, no cookies), under
 * a synthetic `.invalid` URL that no client request can reach.
 */
export class CacheApiQueryCacheStore implements QueryCacheStore {
  readonly name = 'colo' as const;
  readonly spendsBudget = true;
  readonly #open: () => Promise<CacheApiLike>;
  readonly #aesKey: CacheCryptoKey;
  #cache: Promise<CacheApiLike> | undefined;

  constructor(options: CacheApiStoreOptions) {
    const source = options.cache;
    this.#open = typeof source === 'function' ? source : () => Promise.resolve(source);
    this.#aesKey = options.aesKey;
  }

  #store(): Promise<CacheApiLike> {
    this.#cache ??= this.#open().catch((error: unknown) => {
      this.#cache = undefined; // try again next time
      throw error;
    });
    return this.#cache;
  }

  async get(id: string, now: number): Promise<QueryCacheEntry | undefined> {
    const response = await (await this.#store()).match(new Request(`${CACHE_API_ORIGIN}/v1/${id}`));
    if (response === undefined) return undefined;
    const sealed = new Uint8Array(await response.arrayBuffer());
    if (sealed.byteLength <= IV_BYTES) return undefined;
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: sealed.slice(0, IV_BYTES),
          additionalData: encoder.encode(CACHE_API_AAD + id),
        },
        this.#aesKey,
        sealed.slice(IV_BYTES),
      );
    } catch {
      return undefined; // altered, copied from another id, or written under another master key
    }
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as { s?: unknown; e?: unknown; b?: unknown };
    if (typeof parsed.s !== 'number' || typeof parsed.e !== 'number' || typeof parsed.b !== 'string') {
      return undefined;
    }
    const entry = { body: parsed.b, storedAt: parsed.s, expiresAt: parsed.e };
    return isFresh(entry, now) ? entry : undefined;
  }

  async put(id: string, entry: QueryCacheEntry): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const plain = encoder.encode(JSON.stringify({ s: entry.storedAt, e: entry.expiresAt, b: entry.body }));
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(CACHE_API_AAD + id) },
        this.#aesKey,
        plain,
      ),
    );
    const body = new Uint8Array(IV_BYTES + sealed.byteLength);
    body.set(iv);
    body.set(sealed, IV_BYTES);
    const maxAge = Math.max(1, Math.ceil((entry.expiresAt - entry.storedAt) / 1000));
    await (await this.#store()).put(
      new Request(`${CACHE_API_ORIGIN}/v1/${id}`),
      new Response(body, {
        headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': `max-age=${maxAge}` },
      }),
    );
  }
}

export interface QueryCachePolicy {
  /** TTL of results whose window moves with the clock (relative SINCE, no UNTIL, calendar words, subqueries). */
  readonly relativeTtlMs: number;
  /** TTL of results over a fixed window that ended at least `settleMs` ago. */
  readonly absoluteTtlMs: number;
  /** How long after a fixed window ends late data may still arrive; until then it counts as relative. */
  readonly settleMs: number;
  /** Results whose serialised form (UTF-8) is larger are not stored. */
  readonly maxEntryBytes: number;
}

export const MAX_RELATIVE_TTL_MS = 300_000;
export const MAX_ABSOLUTE_TTL_MS = 3_600_000;
export const MAX_ENTRY_BYTES: number = 1024 * 1024;

export const DEFAULT_QUERY_CACHE_POLICY: QueryCachePolicy = Object.freeze({
  relativeTtlMs: 30_000,
  absoluteTtlMs: 600_000,
  settleMs: 900_000,
  maxEntryBytes: 256 * 1024,
});

export interface QueryCacheOptions {
  /** Lookup order; a hit in a later store is copied into the earlier ones. Default: one memory store. */
  readonly stores?: readonly QueryCacheStore[];
  /** HMAC-SHA-256 sign key for entry ids. Default: a random key per cache (fine for memory-only caches). */
  readonly macKey?: CacheCryptoKey;
  readonly policy?: Partial<QueryCachePolicy>;
}

/** What decides an entry's isolation. Every field goes into the keyed id; none of it is stored in clear. */
export interface QueryCacheKeyInput {
  /** The scope the result was produced under, e.g. `stdio`, `grant:<id>`, `passthrough`. */
  readonly scope: string;
  readonly nrql: string;
  readonly accounts: readonly number[];
  readonly stats: boolean;
  /** Time bucket (0 for settled fixed windows). */
  readonly bucket: number;
}

const clampMs = (value: number | undefined, fallback: number, max: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(0, Math.floor(value)));

/**
 * NRQL text for the key: runs of whitespace between tokens become one space; token text (strings, identifiers,
 * keyword case) is untouched, so two texts share a key only when they tokenise identically.
 */
export function normalizeNrqlForCache(text: string): string {
  const tokens = tokenize(text);
  let out = '';
  let last = 0;
  for (const t of tokens) {
    const gap = text.slice(last, t.start);
    if (out !== '') out += gap === '' ? '' : /^\s+$/.test(gap) ? ' ' : gap;
    out += text.slice(t.start, t.end);
    last = t.end;
  }
  return out;
}

/** `u32 length || bytes` for each part: an injective encoding, so no two inputs collide before the MAC. */
function encodeParts(parts: readonly string[]): Uint8Array<ArrayBuffer> {
  const chunks = parts.map((p) => encoder.encode(p));
  const out = new Uint8Array(chunks.reduce((n, c) => n + 4 + c.byteLength, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const c of chunks) {
    view.setUint32(at, c.byteLength);
    out.set(c, at + 4);
    at += 4 + c.byteLength;
  }
  return out;
}

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

/** Canonical form of the limits, in a fixed field order: any limit change gives a different key. */
function limitsFingerprint(ctx: ToolContext): string {
  const l = ctx.limits;
  return JSON.stringify([
    l.maxLimit,
    l.maxWindowDays,
    l.eventTypes.allow ?? null,
    l.eventTypes.deny ?? null,
    l.rawNrql,
    l.maxResponseBytes,
  ]);
}

const ID_VERSION = 'relic-bridge/query-cache/v1';

/** The query cache: keyed ids, TTL rules, size cap and lookup across stores. Shared by every request of a runtime. */
export class QueryCache {
  readonly policy: QueryCachePolicy;
  readonly stores: readonly QueryCacheStore[];
  readonly #macKey: Promise<CacheCryptoKey>;

  constructor(options: QueryCacheOptions = {}) {
    const p = options.policy ?? {};
    const d = DEFAULT_QUERY_CACHE_POLICY;
    this.policy = Object.freeze({
      relativeTtlMs: clampMs(p.relativeTtlMs, d.relativeTtlMs, MAX_RELATIVE_TTL_MS),
      absoluteTtlMs: clampMs(p.absoluteTtlMs, d.absoluteTtlMs, MAX_ABSOLUTE_TTL_MS),
      settleMs: clampMs(p.settleMs, d.settleMs, 24 * 3_600_000),
      maxEntryBytes: clampMs(p.maxEntryBytes, d.maxEntryBytes, MAX_ENTRY_BYTES),
    });
    this.stores = Object.freeze([...(options.stores ?? [new MemoryQueryCacheStore()])]);
    this.#macKey =
      options.macKey === undefined
        ? (crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, [
            'sign',
          ]) as Promise<CacheCryptoKey>)
        : Promise.resolve(options.macKey);
  }

  /**
   * TTL and time bucket for a query read at `now`. A fixed window that ended `settleMs` ago gets the long TTL and no
   * bucket; anything else the short TTL plus a bucket of that length, so an entry never outlives its bucket.
   * Returns null when the TTL is 0 (caching that class of query is off).
   */
  lifetime(fixedEndMs: number | undefined, now: number): { ttlMs: number; bucket: number } | null {
    if (fixedEndMs !== undefined && now - fixedEndMs >= this.policy.settleMs) {
      return this.policy.absoluteTtlMs > 0 ? { ttlMs: this.policy.absoluteTtlMs, bucket: 0 } : null;
    }
    const ttl = this.policy.relativeTtlMs;
    return ttl > 0 ? { ttlMs: ttl, bucket: Math.floor(now / ttl) + 1 } : null;
  }

  /** The keyed entry id (64 hex characters) for a query run with `ctx`'s credential and limits. */
  async idFor(ctx: ToolContext, input: QueryCacheKeyInput): Promise<string> {
    const keyHash = hex(
      await crypto.subtle.digest('SHA-256', encoder.encode(ctx.credential.apiKey.reveal())),
    );
    const material = encodeParts([
      ID_VERSION,
      input.scope,
      ctx.credential.id,
      ctx.credential.region,
      keyHash,
      input.accounts.join(','),
      limitsFingerprint(ctx),
      input.stats ? 'stats' : 'plain',
      String(input.bucket),
      normalizeNrqlForCache(input.nrql),
    ]);
    return hex(await crypto.subtle.sign('HMAC', await this.#macKey, material));
  }

  /** May this store be used now? Budgeted stores only while at least half the request budget remains. */
  #affordable(ctx: ToolContext, store: QueryCacheStore): boolean {
    if (!store.spendsBudget) return true;
    const b = ctx.budget;
    return b.canSpend(1) && b.remaining - 1 >= b.limit / 2;
  }

  /** Look `id` up in each store in order. Store failures are misses (logged), never errors. */
  async get(
    ctx: ToolContext,
    id: string,
  ): Promise<{ entry: QueryCacheEntry; store: QueryCacheStoreName } | undefined> {
    const now = ctx.clock.now();
    for (const [i, store] of this.stores.entries()) {
      if (!this.#affordable(ctx, store)) continue;
      if (store.spendsBudget) ctx.budget.spend(1, 'query cache lookup');
      let entry: QueryCacheEntry | undefined;
      try {
        entry = await store.get(id, now);
      } catch (error) {
        ctx.logger.warn('query cache lookup failed', { store: store.name, error: errorName(error) });
        continue;
      }
      if (entry === undefined || !isFresh(entry, now)) continue;
      // Copy into the cheaper stores in front (memory) so the next lookup in this runtime costs nothing.
      for (const earlier of this.stores.slice(0, i)) {
        if (!earlier.spendsBudget) await earlier.put(id, entry).catch(() => undefined);
      }
      return { entry, store: store.name };
    }
    return undefined;
  }

  /** Store `body` for `ttlMs`. Returns whether at least one store took it (false when too large). */
  async put(ctx: ToolContext, id: string, body: string, ttlMs: number): Promise<boolean> {
    // UTF-8 never takes fewer bytes than UTF-16 code units, so the length alone rules out most large bodies.
    const max = this.policy.maxEntryBytes;
    if (body.length > max || encoder.encode(body).byteLength > max) return false;
    const storedAt = ctx.clock.now();
    const entry: QueryCacheEntry = { body, storedAt, expiresAt: storedAt + ttlMs };
    let stored = false;
    for (const store of this.stores) {
      if (!this.#affordable(ctx, store)) continue;
      if (store.spendsBudget) ctx.budget.spend(1, 'query cache write');
      try {
        await store.put(id, entry);
        stored = true;
      } catch (error) {
        ctx.logger.warn('query cache write failed', { store: store.name, error: errorName(error) });
      }
    }
    return stored;
  }
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/** How a runtime hands its cache to tools: the cache plus the scope of this connection. */
export interface QueryCacheBinding {
  readonly cache: QueryCache;
  /** `stdio`, `grant:<grant id>` or `passthrough`: entries never cross scopes. */
  readonly scope: string;
}
