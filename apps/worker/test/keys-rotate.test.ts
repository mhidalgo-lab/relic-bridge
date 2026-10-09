// SPDX-License-Identifier: Apache-2.0
// Master-key rotation on the Worker against local D1 (P3-11): `POST /api/admin/v1/keys/rotate` in bounded batches,
// every row readable after each batch, resumable after an interruption, idempotent, admin-only, audited, and the
// compare-and-swap holds on D1.
import { env } from 'cloudflare:workers';
import type { D1Database } from '@cloudflare/workers-types';
import { generateMasterKey, Keyring, rotateCredentialKeysBatch } from '@relic-bridge/auth';
import type { Storage } from '@relic-bridge/storage';
import { createD1Storage } from '@relic-bridge/storage/d1';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env.ts';
import { createWorker } from '../src/worker.ts';
import { call, connect, fakeCtx, mockNerdGraph, NR_KEY, seed, wipeD1 } from './helpers.ts';

const K1 = env.RB_MASTER_KEY as string;
const ADMIN = env.RB_ADMIN_TOKEN as string;
const db = env.DB as D1Database;
const K2 = generateMasterKey(2);
const extraKey = (i: number): string => `NRAK-D1ROTATION${String(i).padStart(17, '0')}`;
const EXTRA = 5;

let storage: Storage;
let token: string;
let lines: string[];

beforeEach(async () => {
  await wipeD1(db);
  storage = await createD1Storage(db);
  ({ token } = await seed(K1, storage));
  const r1 = await Keyring.create({ current: K1 });
  for (let i = 0; i < EXTRA; i++) {
    const id = `cred_x${i}`;
    await storage.credentials.create({
      id,
      label: id,
      region: 'US',
      key: await r1.encryptCredentialKey(id, extraKey(i)),
    });
  }
  // The first boot on the old key registers its key check (as the deployed Worker did before the rotation).
  expect(
    (await call(createWorker({ logSink: () => {} }), env as WorkerEnv, fakeCtx(), '/health')).status,
  ).toBe(200);
  lines = [];
});

const rotatingEnv = (): WorkerEnv => ({
  ...(env as WorkerEnv),
  RB_MASTER_KEY: K2,
  RB_MASTER_KEY_PREVIOUS: K1,
});

async function rotate(
  worker: ReturnType<typeof createWorker>,
  workerEnv: WorkerEnv,
  body: Record<string, unknown>,
  auth: string | null = ADMIN,
) {
  const ctx = fakeCtx();
  const res = await call(worker, workerEnv, ctx, '/api/admin/v1/keys/rotate', {
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

async function versions(): Promise<number[]> {
  return (await storage.credentials.list()).map((c) => (c.key.kind === 'encrypted' ? c.key.keyVersion : 0));
}

async function plaintexts(ring: Keyring): Promise<string[]> {
  const out: string[] = [];
  for (const c of await storage.credentials.list()) {
    if (c.key.kind !== 'encrypted') throw new Error('unexpected');
    out.push((await ring.decryptCredentialKey(c.id, c.key)).reveal());
  }
  return out.sort();
}

const expected = [NR_KEY, ...Array.from({ length: EXTRA }, (_, i) => extraKey(i))].sort();

describe('master-key rotation on D1 (P3-11)', () => {
  it('rotates in batches; every row reads after each batch; an interrupted run resumes; a rerun is a no-op', async () => {
    const both = await Keyring.create({ current: K2, previous: K1 });
    const worker = createWorker({ logSink: (l) => lines.push(l) });
    const first = await rotate(worker, rotatingEnv(), { batchSize: 2 });
    expect(first.status).toBe(200);
    expect(first.json['data']).toMatchObject({ currentVersion: 2, total: EXTRA + 1, pending: EXTRA - 1 });
    expect(first.json['data'].reencrypted).toHaveLength(2);
    expect(first.json['data'].nextCursor).toEqual(expect.any(String));
    expect(await plaintexts(both)).toEqual(expected);

    // Interrupted: the client lost the cursor, and a new isolate serves the next call. Start over from the top.
    const fresh = createWorker({ logSink: (l) => lines.push(l) });
    let after: string | null = null;
    let calls = 0;
    for (; calls < 10; calls++) {
      const res = await rotate(fresh, rotatingEnv(), { batchSize: 2, after });
      expect(res.status).toBe(200);
      expect(await plaintexts(both)).toEqual(expected);
      after = res.json['data'].nextCursor;
      if (after === null) {
        expect(res.json['data']).toMatchObject({ pending: 0, versionsInUse: [2], failed: [] });
        break;
      }
    }
    expect(calls).toBe(1); // 4 rows left, 2 per call: the second call finishes
    expect(await versions()).toEqual(Array(EXTRA + 1).fill(2));

    const again = await rotate(fresh, rotatingEnv(), {});
    expect(again.json['data']).toMatchObject({
      reencrypted: [],
      alreadyCurrent: EXTRA + 1,
      nextCursor: null,
    });

    // Audited, one row per call, with no key material.
    const rows = await storage.auditLog.list({ kind: 'admin', action: 'keys.rotate' });
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.status === 'ok' && r.targetId === 'v2')).toBe(true);

    // The previous key can now be removed: a Worker with the new key alone boots and serves MCP with the stored key.
    const nerdGraph = mockNerdGraph();
    const only = createWorker({ logSink: (l) => lines.push(l), fetch: nerdGraph.fetch });
    const onlyEnv: WorkerEnv = { ...(env as WorkerEnv), RB_MASTER_KEY: K2 };
    const client = await connect(only, onlyEnv, fakeCtx(), token);
    await client.callTool({ name: 'whoami', arguments: {} });
    await client.close();
    expect(nerdGraph.keys).toContain(NR_KEY);

    const dump = `${first.text}\n${again.text}\n${JSON.stringify(rows)}\n${lines.join('\n')}`;
    for (const secret of [K1, K2, ADMIN, ...expected])
      expect(dump).not.toContain(secret.replace(/^v\d+:/, ''));
    expect(dump).not.toMatch(/ciphertext|"iv"/);
  });

  it('is admin-only: no token, an MCP token or a wrong token gets 401 and nothing changes', async () => {
    const worker = createWorker({ logSink: () => {} });
    for (const auth of [null, token, `${ADMIN}x`]) {
      const res = await rotate(worker, rotatingEnv(), {}, auth);
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: { code: 'unauthorized', message: 'admin authentication required' } });
    }
    expect(await versions()).toEqual(Array(EXTRA + 1).fill(1));
    expect(await storage.auditLog.list({ kind: 'admin', action: 'keys.rotate' })).toEqual([]);
  });

  it('a wrong previous key stops the Worker at boot (503) before any row is touched', async () => {
    const worker = createWorker({ logSink: (l) => lines.push(l) });
    const res = await rotate(worker, { ...rotatingEnv(), RB_MASTER_KEY_PREVIOUS: generateMasterKey(1) }, {});
    expect(res.status).toBe(503);
    expect(await versions()).toEqual(Array(EXTRA + 1).fill(1));
    expect(lines.join('\n')).toContain('key_mismatch');
  });

  it('never overwrites a key replaced while rotating (D1 compare-and-swap)', async () => {
    const both = await Keyring.create({ current: K2, previous: K1 });
    const replaced = await both.encryptCredentialKey('cred_x0', 'NRAK-REPLACEDWHILEROTATINGD1000');
    const racing: Storage = {
      ...storage,
      credentials: {
        ...storage.credentials,
        async update(id, patch) {
          if (id === 'cred_x0' && patch.ifKey !== undefined)
            await storage.credentials.update(id, { key: replaced });
          return storage.credentials.update(id, patch);
        },
      },
    };
    const report = await rotateCredentialKeysBatch(racing, both, { limit: 100 });
    expect(report.failed).toEqual([{ id: 'cred_x0', code: 'conflict' }]);
    expect(report.reencrypted).toHaveLength(EXTRA);
    const row = await storage.credentials.get('cred_x0');
    if (row?.key.kind !== 'encrypted') throw new Error('unexpected');
    expect((await both.decryptCredentialKey(row.id, row.key)).reveal()).toBe(
      'NRAK-REPLACEDWHILEROTATINGD1000',
    );
  });
});
