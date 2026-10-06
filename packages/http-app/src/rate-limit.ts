// SPDX-License-Identifier: Apache-2.0
// Pluggable rate limiting (P2-07, T1/T5/T20). `RateLimiter` is the seam: this file has the in-memory token bucket for
// a single process (Node); Workers (P3-04) and a Durable Object limiter (P7-10) implement the same interface.
// Web-standard only. The only state is inside a limiter instance, never at module level.
import { type Clock, systemClock } from '@relic-bridge/core';

/** `requests` per `perSeconds`: a token bucket of capacity `requests` refilled at `requests / perSeconds` per second. */
export interface RateLimitRule {
  readonly requests: number;
  readonly perSeconds: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  /** When refused: how long until the request would be allowed (0 when allowed). */
  readonly retryAfterMs: number;
  /** Whole tokens left after this call. */
  readonly remaining: number;
}

/**
 * Keys are opaque strings chosen by the caller, namespaced by the caller (`ip:`, `fail:`, `grant:`, `token:`).
 * Implementations may be async (Workers bindings, Durable Objects).
 */
export interface RateLimiter {
  /** Take `cost` (default 1) tokens if all are available; otherwise take nothing. */
  take(key: string, rule: RateLimitRule, cost?: number): RateLimitResult | Promise<RateLimitResult>;
  /** Would `take(key, rule, 1)` succeed? Consumes nothing (the auth-failure throttle needs this, T1). */
  peek(key: string, rule: RateLimitRule): RateLimitResult | Promise<RateLimitResult>;
}

export function isRateLimitRule(value: unknown): value is RateLimitRule {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(v['requests']) &&
    (v['requests'] as number) > 0 &&
    Number.isSafeInteger(v['perSeconds']) &&
    (v['perSeconds'] as number) > 0
  );
}

export const DEFAULT_RATE_LIMIT_MAX_KEYS = 10_000;
/** Idle buckets looked at (oldest first) to make room before the least recently used live one is evicted. */
const EVICT_SCAN = 32;

/** One token bucket's state. Plain data, so a store can persist it (the Workers Durable Object limiter, P7-10). */
export interface TokenBucket {
  readonly tokens: number;
  readonly updatedAt: number;
  /** Time at which the bucket is full again (an idle bucket is equivalent to no bucket). */
  readonly fullAt: number;
}

/**
 * One `take` (`consume`) or `peek` against `bucket` (absent = full) at `now`: the answer and the state to keep.
 * `next` is `undefined` when nothing needs storing (a peek or refusal on an absent bucket). Pure: no clock, no I/O.
 */
export function tokenBucketStep(
  bucket: TokenBucket | undefined,
  rule: RateLimitRule,
  cost: number,
  now: number,
  consume: boolean,
): { readonly result: RateLimitResult; readonly next: TokenBucket | undefined } {
  if (!isRateLimitRule(rule)) throw new RangeError('invalid rate limit rule');
  if (!Number.isFinite(cost) || cost <= 0) throw new RangeError('cost must be positive');
  const capacity = rule.requests;
  const perMs = rule.requests / (rule.perSeconds * 1000);
  // A clock that went backwards refills nothing (never negative elapsed time).
  const elapsed = bucket === undefined ? 0 : Math.max(0, now - bucket.updatedAt);
  // The rule may change between calls (a grant's limit was edited): the bucket is re-capped to the new capacity.
  let tokens = bucket === undefined ? capacity : Math.min(capacity, bucket.tokens + elapsed * perMs);
  const allowed = cost <= capacity && tokens >= cost;
  if (allowed && consume) tokens -= cost;
  const retryAfterMs = allowed
    ? 0
    : cost > capacity
      ? Number.POSITIVE_INFINITY
      : Math.ceil((cost - tokens) / perMs);
  const result = { allowed, retryAfterMs, remaining: Math.max(0, Math.floor(tokens)) };
  // A request that can never be served (cost above capacity) must not leave a bucket behind.
  if (bucket === undefined && !(allowed && consume)) return { result, next: undefined };
  return {
    result,
    next: { tokens, updatedAt: now, fullAt: now + Math.ceil((capacity - tokens) / perMs) },
  };
}

export interface MemoryRateLimiterOptions {
  /** Most buckets kept (default 10,000, roughly 2 MiB). */
  readonly maxKeys?: number;
  readonly clock?: Clock;
}

/**
 * Token buckets in a Map in least-recently-used order. Memory is bounded by `maxKeys`: when full, buckets that have
 * refilled completely (indistinguishable from absent) go first, then the least recently used. Single process only:
 * with several replicas each has its own buckets.
 */
export class MemoryRateLimiter implements RateLimiter {
  readonly #buckets = new Map<string, TokenBucket>();
  readonly #maxKeys: number;
  readonly #clock: Clock;

  constructor(options: MemoryRateLimiterOptions = {}) {
    const max = options.maxKeys ?? DEFAULT_RATE_LIMIT_MAX_KEYS;
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('maxKeys must be a positive integer');
    this.#maxKeys = max;
    this.#clock = options.clock ?? systemClock;
  }

  /** Buckets currently held (tests, metrics). */
  get size(): number {
    return this.#buckets.size;
  }

  take(key: string, rule: RateLimitRule, cost = 1): RateLimitResult {
    return this.#run(key, rule, cost, true);
  }

  peek(key: string, rule: RateLimitRule): RateLimitResult {
    return this.#run(key, rule, 1, false);
  }

  #run(key: string, rule: RateLimitRule, cost: number, consume: boolean): RateLimitResult {
    const now = this.#clock.now();
    const existing = this.#buckets.get(key);
    const { result, next } = tokenBucketStep(existing, rule, cost, now, consume);
    if (next !== undefined) {
      if (existing !== undefined)
        this.#buckets.delete(key); // re-insert: most recently used last
      else this.#makeRoom(now);
      this.#buckets.set(key, next);
    }
    return result;
  }

  #makeRoom(now: number): void {
    if (this.#buckets.size < this.#maxKeys) return;
    let scanned = 0;
    let victim: string | undefined;
    for (const [key, bucket] of this.#buckets) {
      victim ??= key; // least recently used
      if (bucket.fullAt <= now) {
        this.#buckets.delete(key);
        return;
      }
      if (++scanned >= EVICT_SCAN) break;
    }
    if (victim !== undefined) this.#buckets.delete(victim);
  }
}
