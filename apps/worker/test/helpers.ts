// SPDX-License-Identifier: Apache-2.0
// Shared fixtures for the Worker tests: a seeded in-memory storage encrypted under the test master key, a fake
// execution context that records `waitUntil` work, a NerdGraph stand-in and an MCP client wired to the Worker.
import type { D1Database, ExecutionContext } from '@cloudflare/workers-types';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createCredential, createGrant, createProject, issueAccessToken, Keyring } from '@relic-bridge/auth';
import { createBuiltinTools, type FetchLike, type Identity, Secret } from '@relic-bridge/core';
import { createMemoryStorage, type Storage } from '@relic-bridge/storage';
import type { WorkerEnv } from '../src/env.ts';
import type { WorkerHandler } from '../src/worker.ts';

/** Shaped like a User key so redaction is exercised; obviously fake. */
export const NR_KEY = 'NRAK-WORKERTESTKEY0123456789ABCDE';
export const CATALOG: readonly string[] = createBuiltinTools().map((t) => t.name);

export interface Seeded {
  readonly storage: Storage;
  /** Device token with a full grant on project `prod`. */
  readonly token: string;
}

/**
 * Seeds one user, one credential (encrypted under `masterKey`), project `prod`, a grant and a token into `storage`
 * (default: a new in-memory storage).
 */
export async function seed(masterKey: string, storage: Storage = createMemoryStorage()): Promise<Seeded> {
  const now = Date.now();
  const keyring = await Keyring.create({ current: masterKey });
  await storage.users.create({ id: 'usr_a', email: 'a@example.com', role: 'owner' });
  const validate = async (): Promise<Identity> => ({
    user: { id: 7, email: 'a@example.com', name: 'A' },
    accounts: [{ id: 1, name: 'one' }],
  });
  const cred = await createCredential(
    { storage, keyring, validate },
    { label: 'main', region: 'US', apiKey: new Secret(NR_KEY), ownerUserId: 'usr_a' },
  );
  const project = await createProject(
    storage,
    { slug: 'prod', defaultAccountId: 1, allowedAccountIds: [1], defaultCredentialId: cred.id },
    CATALOG,
  );
  const { grant } = await createGrant(storage, { projectId: project.id, userId: 'usr_a' }, CATALOG, now);
  const issued = await issueAccessToken(storage, { grantId: grant.id, label: 'laptop' }, now);
  return { storage, token: issued.token.reveal() };
}

/** An execution context whose background tasks the test can await. */
export function fakeCtx(): ExecutionContext & {
  readonly tasks: Promise<unknown>[];
  settle(): Promise<void>;
} {
  const tasks: Promise<unknown>[] = [];
  return {
    tasks,
    waitUntil: (p: Promise<unknown>) => {
      tasks.push(p);
    },
    passThroughOnException: () => {},
    props: {},
    async settle() {
      await Promise.allSettled(tasks);
    },
  } as unknown as ExecutionContext & { readonly tasks: Promise<unknown>[]; settle(): Promise<void> };
}

/** NerdGraph stand-in: answers every query with the fake user's identity. Records the key header it saw. */
export function mockNerdGraph(): { fetch: FetchLike; keys: (string | null)[] } {
  const keys: (string | null)[] = [];
  const fetch: FetchLike = async (_url, init) => {
    keys.push(new Headers(init.headers).get('api-key'));
    return new Response(
      JSON.stringify({
        data: {
          actor: { user: { id: 7, name: 'A', email: 'a@example.com' }, accounts: [{ id: 1, name: 'one' }] },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetch, keys };
}

/** Calls the Worker in-process like the runtime would: request, env, execution context. */
export function call(
  worker: WorkerHandler,
  env: WorkerEnv,
  ctx: ExecutionContext,
  path: string,
  init: RequestInit & { readonly ip?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.ip !== undefined) headers.set('CF-Connecting-IP', init.ip);
  return worker.fetch(new Request(`https://rb.example.workers.dev${path}`, { ...init, headers }), env, ctx);
}

/** An MCP SDK client whose transport goes through the Worker's `fetch` (no network). */
export async function connect(
  worker: WorkerHandler,
  env: WorkerEnv,
  ctx: ExecutionContext,
  token: string,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('https://rb.example.workers.dev/p/prod/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': '198.51.100.20' } },
    fetch: (url, init) => worker.fetch(new Request(url, init), env, ctx),
  });
  const client = new Client({ name: 'worker-test', version: '0' });
  await client.connect(transport);
  return client;
}

/** Tables the migrations create, children before parents so dropping never trips a foreign key. */
const TABLES = [
  'access_tokens',
  'grant_usage',
  'grants',
  'projects',
  'credentials',
  'users',
  'audit_log',
  'settings',
  'kv',
  'schema_migrations',
];

/** Empty the local D1 database (every table dropped), so the next open migrates from scratch. */
export async function wipeD1(db: D1Database): Promise<void> {
  await db.batch(TABLES.map((t) => db.prepare(`DROP TABLE IF EXISTS \`${t}\``)));
}
