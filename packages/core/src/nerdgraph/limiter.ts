// SPDX-License-Identifier: Apache-2.0
import type { Limiter } from '../context.ts';

/** Default NerdGraph calls in flight per credential (ADR-0010; Workers allow 6 pending connections). */
export const DEFAULT_CONCURRENCY = 5;
/** New Relic guarantees 25 concurrent requests per user (RESEARCH §2). */
export const MAX_CONCURRENCY = 25;

/** FIFO counting semaphore. */
export function createSemaphoreLimiter(max: number = DEFAULT_CONCURRENCY): Limiter {
  if (!Number.isInteger(max) || max < 1 || max > MAX_CONCURRENCY) {
    throw new RangeError(`Concurrency must be an integer between 1 and ${MAX_CONCURRENCY}.`);
  }
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active < max) active++;
      else await new Promise<void>((resolve) => waiting.push(resolve));
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

/**
 * One limiter per credential id. The caller (CLI or http-app) owns the pool for the life of the process or isolate;
 * core keeps no module state (T21). It holds counters only, never request data.
 */
export class LimiterPool {
  readonly #limiters = new Map<string, Limiter>();
  readonly #max: number;

  constructor(max: number = DEFAULT_CONCURRENCY) {
    createSemaphoreLimiter(max); // validate early
    this.#max = max;
  }

  for(credentialId: string): Limiter {
    let limiter = this.#limiters.get(credentialId);
    if (!limiter) {
      limiter = createSemaphoreLimiter(this.#max);
      this.#limiters.set(credentialId, limiter);
    }
    return limiter;
  }
}
