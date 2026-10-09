// SPDX-License-Identifier: Apache-2.0
// The part of the workerd `cloudflare:workers` module the Worker source uses (the package's global types would clash
// with lib.webworker, see tsconfig.json). The tests declare the parts they use in test/cloudflare-workers.d.ts.
declare module 'cloudflare:workers' {
  import type { DurableObjectState } from '@cloudflare/workers-types';

  /** Base class of Durable Objects whose public methods are callable over RPC. */
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
