// SPDX-License-Identifier: Apache-2.0
// Config import on the Worker against local D1 (P7-06): a bundle exported from a Node-style database (in-memory here,
// another master key) imports through `POST /api/admin/v1/config/import`, keys sealed under a passphrase-derived wrap
// key are re-encrypted under the Worker's master key, and a second import changes nothing.
//
// The wrap key is derived by the CLI in Node (PBKDF2, 600 000 iterations); workerd caps PBKDF2 at 100 000, which is
// exactly why the server only ever receives the derived key. The server cannot tell a derived key from any other 32
// bytes, so this test uses fixed bytes with plausible KDF parameters.
import { env } from 'cloudflare:workers';
import type { D1Database } from '@cloudflare/workers-types';
import {
  createCredential,
  createGrant,
  createProject,
  exportConfig,
  generateMasterKey,
  Keyring,
} from '@relic-bridge/auth';
import { Secret } from '@relic-bridge/core';
import { createMemoryStorage } from '@relic-bridge/storage';
import { createD1Storage } from '@relic-bridge/storage/d1';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env.ts';
import { createWorker } from '../src/worker.ts';
import { CATALOG, call, fakeCtx, mockNerdGraph, NR_KEY, seed, wipeD1 } from './helpers.ts';

const db = env.DB as D1Database;
const ADMIN = env.RB_ADMIN_TOKEN as string;
const K1 = env.RB_MASTER_KEY as string;
const wrapBytes = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const WRAP_KEY = btoa(String.fromCharCode(...wrapBytes));
const SALT = btoa(String.fromCharCode(...Uint8Array.from({ length: 16 }, (_, i) => i + 1)));
const kdf = { name: 'pbkdf2-sha256', iterations: 600_000, salt: SALT } as const;

beforeEach(async () => {
  await wipeD1(db);
});

async function post(worker: ReturnType<typeof createWorker>, body: unknown, auth: string | null = ADMIN) {
  const ctx = fakeCtx();
  const res = await call(worker, env as WorkerEnv, ctx, '/api/admin/v1/config/import', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth === null ? {} : { Authorization: `Bearer ${auth}` }),
    },
    body: JSON.stringify(body),
    ip: '198.51.100.7',
  });
  await ctx.settle();
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: response JSON, asserted field by field
  return { status: res.status, text, json: JSON.parse(text) as Record<string, any> };
}

describe('config import on D1 (P7-06)', () => {
  it('round trip Node-style database -> Worker: keys re-encrypted under the Worker master key, idempotent', async () => {
    const nodeKey = generateMasterKey(1);
    const { storage: nodeStorage } = await seed(nodeKey, createMemoryStorage());
    // The seeded key is a personal one; the admin token exports shared keys, so add one and a project that uses it.
    const nodeRing = await Keyring.create({ current: nodeKey });
    const shared = await createCredential(
      {
        storage: nodeStorage,
        keyring: nodeRing,
        validate: async () => ({
          user: { id: 7, email: 'a@example.com', name: 'A' },
          accounts: [{ id: 1, name: 'one' }],
        }),
      },
      { label: 'shared', region: 'US', apiKey: new Secret(NR_KEY) },
    );
    const sharedProject = await createProject(
      nodeStorage,
      { slug: 'team', defaultAccountId: 1, allowedAccountIds: [1], defaultCredentialId: shared.id },
      CATALOG,
    );
    await createGrant(nodeStorage, { projectId: sharedProject.id, label: 'ci' }, CATALOG, Date.now());
    const { bundle } = await exportConfig(
      { storage: nodeStorage, keyring: nodeRing, clock: { now: Date.now } },
      { wrap: { key: wrapBytes, kdf } },
    );
    expect(JSON.stringify(bundle)).not.toContain(NR_KEY);

    const worker = createWorker({ fetch: mockNerdGraph().fetch, logSink: () => {} });
    const dry = await post(worker, { bundle, wrapKey: WRAP_KEY });
    expect(dry.status).toBe(200);
    expect(dry.json['data']).toMatchObject({ dryRun: true, failed: null });
    expect(dry.text).not.toContain(NR_KEY);

    const applied = await post(worker, { bundle, wrapKey: WRAP_KEY, apply: true });
    expect(applied.status).toBe(200);
    expect(applied.json['data'].failed).toBeNull();
    expect(applied.json['data'].summary).toMatchObject({ update: 0 });

    const d1 = await createD1Storage(db);
    const ring = await Keyring.create({ current: K1 });
    const [cred] = await d1.credentials.list();
    expect(cred?.key.kind).toBe('encrypted');
    expect((await ring.decryptCredentialKey(cred?.id as string, cred?.key as never)).reveal()).toBe(NR_KEY);
    expect(await d1.credentials.list()).toHaveLength(1);
    expect((await d1.projects.list()).map((p) => p.slug).sort()).toEqual(['prod', 'team']);
    // `prod` and its grant depend on the personal key that is never exported; `team` and its grant moved.
    expect(await d1.grants.list()).toHaveLength(1);

    const again = await post(worker, { bundle, wrapKey: WRAP_KEY, apply: true });
    expect(again.json['data'].summary).toMatchObject({ create: 0, update: 0 });
    expect(await d1.credentials.list()).toHaveLength(1);
  });

  it('needs the admin token', async () => {
    const worker = createWorker({ fetch: mockNerdGraph().fetch, logSink: () => {} });
    expect((await post(worker, { bundle: {} }, null)).status).toBe(401);
    expect((await post(worker, { bundle: {} }, 'x'.repeat(40))).status).toBe(401);
  });
});
