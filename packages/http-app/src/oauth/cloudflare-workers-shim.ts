// SPDX-License-Identifier: Apache-2.0
// Node stand-in for the `cloudflare:workers` module (ADR-0009, spike P0-08). `@cloudflare/workers-oauth-provider`
// imports `WorkerEntrypoint` only for `instanceof` checks on class-based handlers; relic-bridge hands it plain
// `{ fetch }` objects, so this class is never instantiated. Bundlers and the Node test projects alias
// `cloudflare:workers` to this file; Workers use the real module.
export class WorkerEntrypoint<E = unknown> {
  protected env: E;
  protected ctx: unknown;
  constructor(ctx: unknown, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}
