// SPDX-License-Identifier: Apache-2.0
// The parts of the workerd `cloudflare:workers` module the tests use (the package's global types would clash with
// lib.webworker, see tsconfig.json).
declare module 'cloudflare:workers' {
  import type { WorkerEnv } from '../src/env.ts';

  /** The bindings from `wrangler.jsonc` plus the test secrets from `vitest.config.ts`. */
  export const env: WorkerEnv;
  /** The main module's exports as service bindings. */
  export const exports: {
    readonly default: { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
  };
}

// The Durable Object helpers of `@cloudflare/vitest-plugin` the shared-limiter tests use (P7-10).
declare module 'cloudflare:test' {
  import type { DurableObjectState } from '@cloudflare/workers-types';

  /** Runs `callback` inside the object behind `stub` (its instance and state). */
  export function runInDurableObject<O, R>(
    stub: unknown,
    callback: (instance: O, state: DurableObjectState) => R | Promise<R>,
  ): Promise<R>;
  /** Runs the object's scheduled alarm now, if any; `true` when one ran. */
  export function runDurableObjectAlarm(stub: unknown): Promise<boolean>;
  /** Tears the running object down (memory lost, storage kept). */
  export function evictDurableObject(stub: unknown): Promise<void>;
}
