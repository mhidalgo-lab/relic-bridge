// SPDX-License-Identifier: Apache-2.0
// Node host for the same app: `pnpm dev:node` (port 8798). KV is SQLite. CIMD only with NODE_CIMD=1, which
// installs a strict-public fetch guard standing in for the Workers compatibility flag.
import { serve } from '@hono/node-server';
import { type Env, handle } from './app.ts';
import { SqliteKv } from './kv-sqlite.ts';
import { installStrictPublicFetch } from './ssrf-fetch.ts';

const port = Number(process.env.PORT ?? 8798);
const cimd = process.env.NODE_CIMD === '1';
if (cimd) installStrictPublicFetch();
const env = { OAUTH_KV: new SqliteKv(process.env.KV_PATH ?? ':memory:') } as unknown as Env;

function executionContext(): ExecutionContext {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) =>
      void pending.push(p.catch((e: unknown) => console.error('waitUntil', e))),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
}

serve({
  fetch: (request: Request) => handle(request, env, executionContext(), { cimd }),
  port,
  hostname: '127.0.0.1',
});
console.error(`spike-oauth (node) listening on http://127.0.0.1:${port}`);
