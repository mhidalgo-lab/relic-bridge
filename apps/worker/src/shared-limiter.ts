// SPDX-License-Identifier: Apache-2.0
// The shared limiter (P7-10): one Durable Object class, addressed by name, that gives every isolate of a deployment
// the same counters. Opt-in (`RB_SHARED_LIMITER`, `SHARED_LIMITER` binding); without it each isolate counts alone.
//
//   `concurrency:<credential id>`  NerdGraph calls in flight for one credential (New Relic limits concurrency per
//                                  user, RESEARCH §2). A FIFO semaphore whose slots are leases: a slot whose holder
//                                  crashed, was cancelled or lost its release call frees itself when the lease ends.
//                                  Leases live in memory only (no storage write per call); an evicted object forgets
//                                  them, which can only let more calls through (fails open), never block.
//   `<rate-limit key>`             one token bucket (`fail:<ip>`, `signin:<ip>`, `oauth:<ip>`, `write:<grant>`), the
//                                  same arithmetic as the isolate buckets (`tokenBucketStep`). Persisted, so eviction
//                                  does not refill it; an alarm deletes the stored bucket once it is full again.
//
//   `quota:<grant id>`             a grant's usage counters per UTC period (P7-12, `RB_SHARED_LIMITER=on`): the same
//                                  contract as the storage table (`reserve` refuses at the cap, atomically: one SQL
//                                  statement run synchronously inside the object), persisted, with an alarm that drops
//                                  periods that have ended. Saves a D1 write per NerdGraph call.
//
// Object names are credential ids (storage ids, or HMAC fingerprint ids for pass-through keys) and rate-limit keys:
// never a New Relic key or any request data (T21). The client side (`createSharedConcurrency`, `WorkersRateLimiter`)
// treats every failure to reach an object as "count in this isolate instead" and never blocks on it.
import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState, SqlStorage } from '@cloudflare/workers-types';
import { ErrorCode, type Limiter, type Logger, RbError } from '@relic-bridge/core';
import {
  isRateLimitRule,
  type QuotaStore,
  type RateLimitResult,
  type RateLimitRule,
  type TokenBucket,
  tokenBucketStep,
} from '@relic-bridge/http-app';
import {
  checkPeriod,
  periodResetsAt,
  QUOTA_OBJECT_ADD_SQL,
  QUOTA_OBJECT_CLEANUP_SQL,
  QUOTA_OBJECT_COUNTS_SQL,
  QUOTA_OBJECT_DDL,
  QUOTA_OBJECT_EXISTS_SQL,
  QUOTA_OBJECT_ONE_SQL,
  QUOTA_OBJECT_RELEASE_SQL,
  QUOTA_OBJECT_RESERVE_SQL,
  quotaObjectGetSql,
  type UsageByPeriod,
  type UsageCounters,
  usagePeriods,
} from '@relic-bridge/storage';

/** How long a slot is held at most when its release never arrives: twice the NerdGraph timeout (30 s). */
export const DEFAULT_LEASE_MS = 60_000;
export const MAX_LEASE_MS = 300_000;
/** How long a call waits in the queue for a slot before it gives up (`RB_LIMIT_RATE`). */
export const DEFAULT_WAIT_MS = 10_000;
export const MAX_WAIT_MS = 30_000;
/** Calls queued per object at most; more are refused at once (bounds the object's memory). */
export const MAX_WAITERS = 256;
/** Largest concurrency an object accepts (New Relic's documented per-user limit, RESEARCH §2). */
export const MAX_SLOTS = 25;

const BUCKET_KEY = 'bucket';
/** At most one "unreachable" warning per this interval per isolate and limiter. */
export const WARN_EVERY_MS = 60_000;
/** Name prefix of the concurrency objects; no rate-limit namespace starts with it. */
export const CONCURRENCY_PREFIX = 'concurrency:';
/** Name prefix of the quota objects (one per grant). */
export const QUOTA_PREFIX = 'quota:';

export type AcquireResult =
  | { readonly ok: true; readonly lease: string }
  | { readonly ok: false; readonly retryAfterMs: number };

/** The object's RPC surface, as the Worker sees it through a stub (every call is async over RPC). */
export interface SharedLimiterRpc {
  acquire(max: number, leaseMs: number, waitMs: number): Promise<AcquireResult>;
  release(lease: string): Promise<void>;
  take(rule: RateLimitRule, cost?: number): Promise<RateLimitResult>;
  peek(rule: RateLimitRule): Promise<RateLimitResult>;
  quotaReserve(period: string, maxQueries: number | null): Promise<UsageCounters | null>;
  quotaRelease(period: string): Promise<void>;
  quotaAdd(period: string, events: number): Promise<UsageCounters>;
  quotaGet(periods: readonly string[]): Promise<UsageByPeriod>;
}

/** The `SHARED_LIMITER` binding, reduced to what the Worker uses. */
export interface SharedLimiterNamespace {
  getByName(name: string): SharedLimiterRpc;
}

const REFUSED_FOR_GOOD: AcquireResult = Object.freeze({ ok: false, retryAfterMs: Number.POSITIVE_INFINITY });

interface Waiter {
  readonly max: number;
  readonly leaseMs: number;
  readonly resolve: (r: AcquireResult) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const intIn = (v: unknown, min: number, max: number): v is number =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;

export class SharedLimiter extends DurableObject<unknown> {
  /** lease id -> expiry (epoch ms). */
  readonly #leases = new Map<string, number>();
  readonly #waiters: Waiter[] = [];
  #wake: ReturnType<typeof setTimeout> | undefined;
  /** The stored bucket; `null` until read from storage. */
  #bucket: TokenBucket | undefined | null = null;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
  }

  // --- concurrency -------------------------------------------------------------------------------------------------

  /**
   * A slot of `max`, held until `release` or for `leaseMs`. Queues FIFO for up to `waitMs`; a call that gets no slot
   * in time (or finds the queue full) gets `ok: false` and the time until the earliest lease ends.
   */
  acquire(max: number, leaseMs: number, waitMs: number): Promise<AcquireResult> {
    // Never thrown across RPC: the client validates the same bounds, so this is unreachable short of a bug.
    if (!intIn(max, 1, MAX_SLOTS) || !intIn(leaseMs, 1, MAX_LEASE_MS) || !intIn(waitMs, 0, MAX_WAIT_MS)) {
      return Promise.resolve(REFUSED_FOR_GOOD);
    }
    // Expired leases first go to the calls already queued (their wake-up timer may not have fired yet).
    this.#pump();
    if (this.#waiters.length === 0 && this.#leases.size < max) {
      return Promise.resolve(this.#grant(leaseMs));
    }
    if (waitMs === 0 || this.#waiters.length >= MAX_WAITERS) {
      return Promise.resolve({ ok: false, retryAfterMs: this.#retryAfter() });
    }
    return new Promise<AcquireResult>((resolve) => {
      const waiter: Waiter = {
        max,
        leaseMs,
        resolve,
        timer: setTimeout(() => {
          const i = this.#waiters.indexOf(waiter);
          if (i !== -1) this.#waiters.splice(i, 1);
          resolve({ ok: false, retryAfterMs: this.#retryAfter() });
          // The next call in line may ask for more slots than the one that left.
          this.#pump();
        }, waitMs),
      };
      this.#waiters.push(waiter);
      this.#schedule();
    });
  }

  /** Frees a slot. Unknown or expired leases are ignored (a late release after expiry is normal). */
  release(lease: string): void {
    if (typeof lease !== 'string') return;
    if (this.#leases.delete(lease)) this.#pump();
  }

  #grant(leaseMs: number): AcquireResult {
    const lease = crypto.randomUUID();
    this.#leases.set(lease, Date.now() + leaseMs);
    return { ok: true, lease };
  }

  #expire(now: number): void {
    for (const [id, until] of this.#leases) if (until <= now) this.#leases.delete(id);
  }

  #retryAfter(): number {
    let earliest = Number.POSITIVE_INFINITY;
    for (const until of this.#leases.values()) earliest = Math.min(earliest, until);
    return Number.isFinite(earliest) ? Math.max(1, earliest - Date.now()) : 1_000;
  }

  /** Hands free slots to the queue in order, then re-arms the expiry timer. */
  #pump(): void {
    this.#expire(Date.now());
    while (this.#waiters.length > 0) {
      const head = this.#waiters[0] as Waiter;
      if (this.#leases.size >= head.max) break;
      this.#waiters.shift();
      clearTimeout(head.timer);
      head.resolve(this.#grant(head.leaseMs));
    }
    this.#schedule();
  }

  /** While calls wait, wake up when the earliest lease expires (its holder may be gone for good). */
  #schedule(): void {
    if (this.#wake !== undefined) clearTimeout(this.#wake);
    this.#wake = undefined;
    if (this.#waiters.length === 0 || this.#leases.size === 0) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const until of this.#leases.values()) earliest = Math.min(earliest, until);
    this.#wake = setTimeout(() => this.#pump(), Math.max(0, earliest - Date.now()) + 1);
  }

  // --- rate limit ----------------------------------------------------------------------------------------------------

  /** Takes `cost` tokens if all are available (the `RateLimiter.take` contract). */
  async take(rule: RateLimitRule, cost = 1): Promise<RateLimitResult> {
    return this.#step(rule, cost, true);
  }

  /** Would a `take` of 1 succeed? Consumes and stores nothing. */
  async peek(rule: RateLimitRule): Promise<RateLimitResult> {
    return this.#step(rule, 1, false);
  }

  async #step(rule: RateLimitRule, cost: number, consume: boolean): Promise<RateLimitResult> {
    // The isolate bucket refuses an invalid rule before any call gets here; refuse rather than throw across RPC.
    if (!isRateLimitRule(rule) || !Number.isFinite(cost) || cost <= 0) {
      return { allowed: false, retryAfterMs: Number.POSITIVE_INFINITY, remaining: 0 };
    }
    const storage = this.ctx.storage;
    if (this.#bucket === null) this.#bucket = await storage.get<TokenBucket>(BUCKET_KEY);
    const now = Date.now();
    const { result, next } = tokenBucketStep(this.#bucket, rule, cost, now, consume);
    // Only an allowed take changes what matters; a peek or a refusal would store an equivalent (refilled) state.
    if (consume && result.allowed && next !== undefined) {
      this.#bucket = next;
      await storage.put(BUCKET_KEY, next);
      if ((await storage.getAlarm()) === null) await storage.setAlarm(next.fullAt);
    }
    return result;
  }

  // --- quota counters (P7-12) ----------------------------------------------------------------------------------------
  // One row per period in the object's SQLite storage, changed by single statements run synchronously (no `await`
  // between the check and the write), so no other event can run in between: the cap cannot be overshot.

  #usageReady = false;

  #usage(): SqlStorage {
    const sql = this.ctx.storage.sql;
    if (!this.#usageReady) {
      sql.exec(QUOTA_OBJECT_DDL);
      this.#usageReady = true;
    }
    return sql;
  }

  /** Arms the cleanup alarm for the end of `period` (an hour later) unless one is set. */
  async #armCleanup(period: string): Promise<void> {
    const storage = this.ctx.storage;
    if ((await storage.getAlarm()) !== null) return;
    const name = period.startsWith('m') ? 'month' : 'day';
    await storage.setAlarm(periodResetsAt(name, Date.now()) + 3_600_000);
  }

  /** As `grant_usage`: adds one query unless the period already has `maxQueries`; `null` when refused. */
  async quotaReserve(period: string, maxQueries: number | null): Promise<UsageCounters | null> {
    try {
      checkPeriod(period);
    } catch {
      return null;
    }
    if (maxQueries !== null && !intIn(maxQueries, 1, Number.MAX_SAFE_INTEGER)) return null;
    const row = this.#usage()
      .exec<{ queries: number; inspected: number }>(QUOTA_OBJECT_RESERVE_SQL, period, maxQueries, maxQueries)
      .toArray()[0];
    if (row === undefined) return null;
    await this.#armCleanup(period);
    return { queries: row.queries, inspected: row.inspected };
  }

  async quotaRelease(period: string): Promise<void> {
    try {
      checkPeriod(period);
    } catch {
      return;
    }
    this.#usage().exec(QUOTA_OBJECT_RELEASE_SQL, period);
  }

  async quotaAdd(period: string, events: number): Promise<UsageCounters> {
    // Never thrown across RPC (the client validates the same rules): a bad argument changes nothing.
    try {
      checkPeriod(period);
    } catch {
      return { queries: 0, inspected: 0 };
    }
    if (!intIn(events, 0, Number.MAX_SAFE_INTEGER)) {
      const cur = this.#usage()
        .exec<{ queries: number; inspected: number }>(QUOTA_OBJECT_ONE_SQL, period)
        .toArray()[0];
      return cur === undefined
        ? { queries: 0, inspected: 0 }
        : { queries: cur.queries, inspected: cur.inspected };
    }
    const row = this.#usage()
      .exec<{ queries: number; inspected: number }>(QUOTA_OBJECT_ADD_SQL, period, events)
      .one();
    await this.#armCleanup(period);
    return { queries: row.queries, inspected: row.inspected };
  }

  async quotaGet(periods: readonly string[]): Promise<UsageByPeriod> {
    let sql: string;
    try {
      sql = quotaObjectGetSql(periods);
    } catch {
      return {};
    }
    const found: Record<string, UsageCounters> = {};
    for (const r of this.#usage().exec<{ period: string; queries: number; inspected: number }>(
      sql,
      ...periods,
    )) {
      found[r.period] = { queries: r.queries, inspected: r.inspected };
    }
    return found;
  }

  /** Drops the counters of periods that have ended; re-arms for the next period end while any remain. */
  async #quotaAlarm(): Promise<void> {
    const sql = this.#usage();
    const now = usagePeriods(Date.now());
    sql.exec(QUOTA_OBJECT_CLEANUP_SQL, now.day, now.month);
    const { n, days } = sql.exec<{ n: number; days: number }>(QUOTA_OBJECT_COUNTS_SQL).one();
    if (n === 0) return;
    await this.ctx.storage.setAlarm(periodResetsAt(days > 0 ? 'day' : 'month', Date.now()) + 3_600_000);
  }

  /** Deletes the bucket once it has refilled completely (indistinguishable from no bucket), else re-arms. */
  async alarm(): Promise<void> {
    const storage = this.ctx.storage;
    // A quota object (it created its `usage` table) cleans up its periods; every other object holds one bucket.
    if (this.ctx.storage.sql.exec(QUOTA_OBJECT_EXISTS_SQL).toArray().length > 0) return this.#quotaAlarm();
    const bucket = await storage.get<TokenBucket>(BUCKET_KEY);
    if (bucket === undefined) return;
    if (bucket.fullAt <= Date.now()) {
      await storage.deleteAll();
      this.#bucket = undefined;
    } else {
      await storage.setAlarm(bucket.fullAt);
    }
  }
}

export interface DurableQuotaStoreOptions {
  /** Counters used while an object cannot be reached (storage: exact on D1; the call is never made unlimited). */
  readonly fallback: QuotaStore;
  readonly logger?: Logger;
}

/**
 * Quota counters in the `quota:<grant id>` objects (P7-12). An object that cannot be reached answers from `fallback`
 * (the storage table) with a rate-capped warning, so a quota degrades to storage counters, never to "unlimited".
 */
export function createDurableQuotaStore(
  namespace: SharedLimiterNamespace,
  options: DurableQuotaStoreOptions,
): QuotaStore {
  const { fallback } = options;
  let warnedAt = Number.NEGATIVE_INFINITY;
  const guarded = async <T>(
    grantId: string,
    ask: (stub: SharedLimiterRpc) => Promise<T>,
    other: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await ask(namespace.getByName(`${QUOTA_PREFIX}${grantId}`));
    } catch (error) {
      if (Date.now() - warnedAt >= WARN_EVERY_MS) {
        warnedAt = Date.now();
        options.logger?.warn('shared limiter unavailable: quota counted in storage', {
          error: error instanceof Error ? error.name : typeof error,
        });
      }
      return other();
    }
  };
  return Object.freeze({
    reserve: (grantId, period, maxQueries) =>
      guarded(
        grantId,
        (o) => o.quotaReserve(period, maxQueries),
        () => fallback.reserve(grantId, period, maxQueries),
      ),
    release: (grantId, period) =>
      guarded(
        grantId,
        (o) => o.quotaRelease(period),
        () => fallback.release(grantId, period),
      ),
    addInspected: (grantId, period, events) =>
      guarded(
        grantId,
        (o) => o.quotaAdd(period, events),
        () => fallback.addInspected(grantId, period, events),
      ),
    get: (grantId, periods) =>
      guarded(
        grantId,
        (o) => o.quotaGet(periods),
        () => fallback.get(grantId, periods),
      ),
    getMany: async (grantIds, periods) => {
      const entries = await Promise.all(
        [...new Set(grantIds)].map(
          async (id) =>
            [
              id,
              await guarded(
                id,
                (o) => o.quotaGet(periods),
                () => fallback.get(id, periods),
              ),
            ] as const,
        ),
      );
      return Object.fromEntries(entries.filter(([, v]) => Object.keys(v).length > 0));
    },
  });
}

export interface SharedConcurrencyOptions {
  /** Slots per credential across the deployment (`RB_CONCURRENCY`). */
  readonly max: number;
  readonly leaseMs?: number;
  readonly waitMs?: number;
  readonly logger?: Logger;
}

/**
 * `sharedConcurrency` for `createHttpApp`: a limiter per credential id backed by its `concurrency:` object. An object
 * that cannot be reached runs the task anyway (the isolate's own semaphore still applies) and logs a warning; a queue
 * that frees no slot within the wait answers `RB_LIMIT_RATE` without calling NerdGraph.
 */
export function createSharedConcurrency(
  namespace: SharedLimiterNamespace,
  options: SharedConcurrencyOptions,
): (credentialId: string) => Limiter {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  if (
    !intIn(options.max, 1, MAX_SLOTS) ||
    !intIn(leaseMs, 1, MAX_LEASE_MS) ||
    !intIn(waitMs, 0, MAX_WAIT_MS)
  ) {
    throw new RangeError('invalid shared concurrency options');
  }
  const log = options.logger;
  // One warning per minute per isolate while the object is unreachable (Free daily limit: every call would log).
  let warnedAt = Number.NEGATIVE_INFINITY;
  return (credentialId) => {
    const name = `${CONCURRENCY_PREFIX}${credentialId}`;
    return Object.freeze({
      async run<T>(task: () => Promise<T>): Promise<T> {
        let stub: SharedLimiterRpc;
        let slot: AcquireResult;
        try {
          stub = namespace.getByName(name);
          slot = await stub.acquire(options.max, leaseMs, waitMs);
        } catch (error) {
          if (Date.now() - warnedAt >= WARN_EVERY_MS) {
            warnedAt = Date.now();
            log?.warn('shared limiter unavailable: NerdGraph concurrency counted per isolate', {
              error: error instanceof Error ? error.name : typeof error,
            });
          }
          return task();
        }
        if (!slot.ok) {
          throw new RbError(
            ErrorCode.LimitRate,
            'Too many New Relic calls are in flight for this key across the deployment.',
            {
              hint: 'Retry in a few seconds, or run fewer queries in parallel.',
              details: { retryAfterMs: Math.round(slot.retryAfterMs) },
            },
          );
        }
        try {
          return await task();
        } finally {
          try {
            await stub.release(slot.lease);
          } catch {
            // The lease expires on its own.
          }
        }
      },
    });
  };
}
