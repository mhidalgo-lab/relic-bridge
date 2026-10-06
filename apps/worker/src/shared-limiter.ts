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
// Object names are credential ids (storage ids, or HMAC fingerprint ids for pass-through keys) and rate-limit keys:
// never a New Relic key or any request data (T21). The client side (`createSharedConcurrency`, `WorkersRateLimiter`)
// treats every failure to reach an object as "count in this isolate instead" and never blocks on it.
import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import { ErrorCode, type Limiter, type Logger, RbError } from '@relic-bridge/core';
import {
  isRateLimitRule,
  type RateLimitResult,
  type RateLimitRule,
  type TokenBucket,
  tokenBucketStep,
} from '@relic-bridge/http-app';

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

export type AcquireResult =
  | { readonly ok: true; readonly lease: string }
  | { readonly ok: false; readonly retryAfterMs: number };

/** The object's RPC surface, as the Worker sees it through a stub (every call is async over RPC). */
export interface SharedLimiterRpc {
  acquire(max: number, leaseMs: number, waitMs: number): Promise<AcquireResult>;
  release(lease: string): Promise<void>;
  take(rule: RateLimitRule, cost?: number): Promise<RateLimitResult>;
  peek(rule: RateLimitRule): Promise<RateLimitResult>;
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

  /** Deletes the bucket once it has refilled completely (indistinguishable from no bucket), else re-arms. */
  async alarm(): Promise<void> {
    const storage = this.ctx.storage;
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
