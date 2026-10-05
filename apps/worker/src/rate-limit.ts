// SPDX-License-Identifier: Apache-2.0
// The Workers `RateLimiter` (P3-04, T1/T20). Two layers, because the Rate Limiting binding cannot do what the
// `RateLimiter` interface asks of it:
//   - The binding has one fixed `limit`/`period` per binding (period 10 or 60 s, set in `wrangler.jsonc`), counts per
//     Cloudflare location, is eventually consistent and has no `peek`. Good as a shared backstop across isolates.
//   - A per-isolate token bucket (`MemoryRateLimiter`) enforces the exact rule given by the caller (a grant's own
//     `rateLimit`, the auth-failure throttle) and supplies `peek`.
// `take` asks the isolate bucket first (exact rule, no I/O), then, for shared key namespaces only, the binding.
// `peek` and keys outside the shared namespaces (`fail:`) use the isolate bucket alone: the auth-failure throttle is
// therefore per isolate (best effort) until the Durable Object limiter (P7-10). The same holds for `oauth:` and
// `signin:` (P5-10, P4-20): the abuse that matters on the OAuth endpoints (registrations, metadata-document fetches) has
// its own shared storage counters (`kv.increment`), so a per-isolate `oauth:` rule is only a flood damper. Web-standard only.
import type { RateLimit } from '@cloudflare/workers-types';
import {
  MemoryRateLimiter,
  type RateLimiter,
  type RateLimitResult,
  type RateLimitRule,
} from '@relic-bridge/http-app';

/** Key namespaces counted by the binding (per-IP flood, token, grant, pass-through key). `fail:` is not (needs peek). */
export const SHARED_KEY_PREFIXES: readonly string[] = Object.freeze(['ip:', 'token:', 'grant:', 'key:']);

export interface WorkersRateLimiterOptions {
  /** The Rate Limiting binding (`RATE_LIMITER`); `undefined` = isolate buckets only. */
  readonly binding?: RateLimit | undefined;
  /** Window of the binding in seconds (10 or 60; used for `Retry-After` when the binding refuses). Default 60. */
  readonly bindingPeriodSeconds?: number;
  readonly sharedPrefixes?: readonly string[];
  /** Isolate bucket store (tests inject a clock-driven one). */
  readonly local?: MemoryRateLimiter;
}

export class WorkersRateLimiter implements RateLimiter {
  readonly #local: MemoryRateLimiter;
  readonly #binding: RateLimit | undefined;
  readonly #periodMs: number;
  readonly #prefixes: readonly string[];

  constructor(options: WorkersRateLimiterOptions = {}) {
    this.#local = options.local ?? new MemoryRateLimiter();
    this.#binding = options.binding;
    this.#periodMs = (options.bindingPeriodSeconds ?? 60) * 1000;
    this.#prefixes = options.sharedPrefixes ?? SHARED_KEY_PREFIXES;
  }

  async take(key: string, rule: RateLimitRule, cost = 1): Promise<RateLimitResult> {
    const local = this.#local.take(key, rule, cost);
    if (!local.allowed || this.#binding === undefined || !this.#prefixes.some((p) => key.startsWith(p))) {
      return local;
    }
    // A binding error propagates: the hooks fail open and log it. The isolate bucket already applied.
    const { success } = await this.#binding.limit({ key });
    return success ? local : { allowed: false, retryAfterMs: this.#periodMs, remaining: 0 };
  }

  peek(key: string, rule: RateLimitRule): RateLimitResult {
    return this.#local.peek(key, rule);
  }
}
