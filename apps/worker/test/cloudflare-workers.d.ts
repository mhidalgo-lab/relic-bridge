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
