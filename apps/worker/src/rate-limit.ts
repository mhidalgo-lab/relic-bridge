// SPDX-License-Identifier: Apache-2.0
// The Workers `RateLimiter` (P3-04, T1/T20). Two layers, because the Rate Limiting binding cannot do what the
// `RateLimiter` interface asks of it:
//   - The binding has one fixed `limit`/`period` per binding (period 10 or 60 s, set in `wrangler.jsonc`), counts per
//     Cloudflare location, is eventually consistent and has no `peek`. Good as a shared backstop across isolates.
//   - A per-isolate token bucket (`MemoryRateLimiter`) enforces the exact rule given by the caller (a grant's own
//     `rateLimit`, the auth-failure throttle) and supplies `peek`.
//   - Optionally (P7-10, `RB_SHARED_LIMITER`), the Durable Object limiter (`shared-limiter.ts`): exact buckets shared
//     by every isolate, with `peek`, for the namespaces the binding cannot serve (`DURABLE_KEY_PREFIXES`).
// `take` asks the isolate bucket first (exact rule, no I/O; a refusal there is final, since this isolate's count never
// exceeds the deployment's), then the shared store of the key's namespace: the object for `fail:`, `signin:`, `oauth:`
// and `write:` when configured, the binding for `ip:`, `token:`, `grant:`, `key:`. Without the object the former are
// per isolate (best effort), as before P7-10: the abuse that matters on the OAuth endpoints (registrations,
// metadata-document fetches) has its own shared storage counters (`kv.increment`) anyway.
// An object that cannot be reached (outage, Free-plan daily limit) never fails a read-side check: the isolate bucket's
// answer stands, so the rule degrades to per isolate, never to "unlimited". `write:` keys are the exception (P7-24):
// writes are optional and rare, so when the object is bound and fails, the write is refused (fail closed) rather than
// counted per isolate, which would multiply the cap by the number of isolates. Web-standard only.
import type { RateLimit } from '@cloudflare/workers-types';
import type { Logger } from '@relic-bridge/core';
import {
  MemoryRateLimiter,
  type RateLimiter,
  type RateLimitResult,
  type RateLimitRule,
} from '@relic-bridge/http-app';

import { type SharedLimiterNamespace, WARN_EVERY_MS } from './shared-limiter.ts';

/** Key namespaces counted by the binding (per-IP flood, token, grant, pass-through key). `fail:` is not (needs peek). */
export const SHARED_KEY_PREFIXES: readonly string[] = Object.freeze(['ip:', 'token:', 'grant:', 'key:']);
/**
 * Key namespaces counted by the Durable Object limiter when configured (P7-10): the rules the binding cannot express
 * (auth failures need `peek`; sign-in, OAuth and write rules have their own limits and periods).
 */
export const DURABLE_KEY_PREFIXES: readonly string[] = Object.freeze([
  'fail:',
  'signin:',
  'oauth:',
  'write:',
]);

/** Key namespaces that fail closed when the object is bound but unreachable (P7-24, ADR-0015). */
export const FAIL_CLOSED_KEY_PREFIXES: readonly string[] = Object.freeze(['write:']);
/** `Retry-After` for a refusal caused by an unreachable object. */
const UNAVAILABLE_RETRY_MS = 60_000;

export interface WorkersRateLimiterOptions {
  /** The Rate Limiting binding (`RATE_LIMITER`); `undefined` = isolate buckets only. */
  readonly binding?: RateLimit | undefined;
  /** Window of the binding in seconds (10 or 60; used for `Retry-After` when the binding refuses). Default 60. */
  readonly bindingPeriodSeconds?: number;
  readonly sharedPrefixes?: readonly string[];
  /** Isolate bucket store (tests inject a clock-driven one). */
  readonly local?: MemoryRateLimiter;
  /** The Durable Object limiter (`SHARED_LIMITER`, P7-10); `undefined` = those namespaces stay per isolate. */
  readonly durable?: SharedLimiterNamespace | undefined;
  readonly durablePrefixes?: readonly string[];
  /** Where an unreachable object is reported (the check itself still answers, from the isolate bucket). */
  readonly logger?: Logger;
}

export class WorkersRateLimiter implements RateLimiter {
  readonly #local: MemoryRateLimiter;
  readonly #binding: RateLimit | undefined;
  readonly #periodMs: number;
  readonly #prefixes: readonly string[];
  readonly #durable: SharedLimiterNamespace | undefined;
  readonly #durablePrefixes: readonly string[];
  readonly #logger: Logger | undefined;
  #warnedAt = Number.NEGATIVE_INFINITY;

  constructor(options: WorkersRateLimiterOptions = {}) {
    this.#local = options.local ?? new MemoryRateLimiter();
    this.#binding = options.binding;
    this.#periodMs = (options.bindingPeriodSeconds ?? 60) * 1000;
    this.#prefixes = options.sharedPrefixes ?? SHARED_KEY_PREFIXES;
    this.#durable = options.durable;
    this.#durablePrefixes = options.durablePrefixes ?? DURABLE_KEY_PREFIXES;
    this.#logger = options.logger;
  }

  /** Whether `key` is counted by the Durable Object limiter. */
  #isDurable(key: string): boolean {
    return this.#durable !== undefined && this.#durablePrefixes.some((p) => key.startsWith(p));
  }

  /** Asks the key's object; on any failure, logs and answers with the isolate's result (`write:` keys: a refusal). */
  async #shared(
    key: string,
    ask: (ns: SharedLimiterNamespace) => Promise<RateLimitResult>,
    fallback: RateLimitResult,
  ): Promise<RateLimitResult> {
    try {
      return await ask(this.#durable as SharedLimiterNamespace);
    } catch (error) {
      if (Date.now() - this.#warnedAt >= WARN_EVERY_MS) {
        this.#warnedAt = Date.now();
        this.#logger?.warn('shared limiter unavailable: rule counted per isolate', {
          check: key.slice(0, key.indexOf(':') + 1),
          error: error instanceof Error ? error.name : typeof error,
        });
      }
      if (FAIL_CLOSED_KEY_PREFIXES.some((p) => key.startsWith(p))) {
        return { allowed: false, retryAfterMs: UNAVAILABLE_RETRY_MS, remaining: 0 };
      }
      return fallback;
    }
  }

  async take(key: string, rule: RateLimitRule, cost = 1): Promise<RateLimitResult> {
    const local = this.#local.take(key, rule, cost);
    if (!local.allowed) return local;
    if (this.#isDurable(key)) {
      return this.#shared(key, (ns) => ns.getByName(key).take(rule, cost), local);
    }
    if (this.#binding === undefined || !this.#prefixes.some((p) => key.startsWith(p))) {
      return local;
    }
    // A binding error propagates: the hooks fail open and log it. The isolate bucket already applied.
    const { success } = await this.#binding.limit({ key });
    return success ? local : { allowed: false, retryAfterMs: this.#periodMs, remaining: 0 };
  }

  peek(key: string, rule: RateLimitRule): RateLimitResult | Promise<RateLimitResult> {
    const local = this.#local.peek(key, rule);
    if (!local.allowed || !this.#isDurable(key)) return local;
    return this.#shared(key, (ns) => ns.getByName(key).peek(rule), local);
  }
}
