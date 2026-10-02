// SPDX-License-Identifier: Apache-2.0
// Node stand-in for the `cloudflare:workers` module. The provider imports `WorkerEntrypoint` only to
// detect class-based handlers (`instanceof`); plain `{ fetch }` handlers never touch it.
export class WorkerEntrypoint<E = unknown> {
  protected env: E;
  protected ctx: unknown;
  constructor(ctx: unknown, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}
