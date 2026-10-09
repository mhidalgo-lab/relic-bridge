// SPDX-License-Identifier: Apache-2.0
// Cloudflare Worker entry (`wrangler.jsonc` `main`). workerd treats every named export of the main module as an
// entrypoint, so this file exports the handler only; the building blocks live in `worker.ts` and `settings.ts`.
// The handler is created once per isolate at module scope; its runtime (keyring, caches, app) is built lazily on the
// first request, which keeps that work out of the Worker's startup.
import { createWorker, type WorkerHandler } from './worker.ts';

const worker: WorkerHandler = createWorker();
export default worker;
