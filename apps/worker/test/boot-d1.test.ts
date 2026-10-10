// SPDX-License-Identifier: Apache-2.0
// The Worker boot against the local D1 database (P3-06): migrations on the first request, a master key that does not
// match the database refuses to serve, and the authorization suite really runs on the Worker host.
import { env } from 'cloudflare:workers';
import type { D1Database } from '@cloudflare/workers-types';
import { generateMasterKey } from '@relic-bridge/auth';
import { createD1Storage } from '@relic-bridge/storage/d1';
import { describe, expect, it } from 'vitest';
import { authzHostKind } from '../../../packages/http-app/test/authz/harness.ts';
import type { WorkerEnv } from '../src/env.ts';
import { createWorker } from '../src/worker.ts';
import { call, fakeCtx, seed, wipeD1 } from './helpers.ts';

const MASTER_KEY = env.RB_MASTER_KEY as string;
const db = env.DB as D1Database;

describe('Worker boot on D1', () => {
  it('runs as the host of the shared authorization suite', () => {
    expect(authzHostKind()).toBe('worker');
  });

  it('applies the migrations on the first request of a fresh database, once', async () => {
    await wipeD1(db);
    const lines: string[] = [];
    const worker = createWorker({ logSink: (l) => lines.push(l) });
    const ctx = fakeCtx();
    expect((await call(worker, env as WorkerEnv, ctx, '/health')).status).toBe(200);
    const applied = (await db.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .results;
    expect(applied.length).toBeGreaterThan(0);
    expect((await db.prepare('SELECT count(*) AS n FROM users').first<{ n: number }>())?.n).toBe(0);
    // A second isolate on the migrated database applies nothing more.
    const again = createWorker({ logSink: () => {} });
    expect((await call(again, env as WorkerEnv, ctx, '/health')).status).toBe(200);
    expect(
      (await db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).results,
    ).toEqual(applied);
  });

  it('answers 503 everywhere when RB_MASTER_KEY does not match the database, and names no secret', async () => {
    await wipeD1(db);
    const storage = await createD1Storage(db);
    const worker0 = createWorker({ logSink: () => {} });
    const { token } = await seed(MASTER_KEY, storage);
    // Registers the key checks of the right key.
    expect((await call(worker0, env as WorkerEnv, fakeCtx(), '/health')).status).toBe(200);

    const wrong = generateMasterKey(1);
    const lines: string[] = [];
    const worker = createWorker({ logSink: (l) => lines.push(l) });
    const wrongEnv: WorkerEnv = { ...(env as WorkerEnv), RB_MASTER_KEY: wrong };
    const ctx = fakeCtx();
    for (const path of ['/health', '/version', '/p/prod/mcp', '/api/admin/v1/users']) {
      const res = await call(worker, wrongEnv, ctx, path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(res.status, path).toBe(503);
      expect(await res.text()).toBe('{"error":"unavailable"}');
    }
    const dump = lines.join('\n');
    expect(dump).toContain('worker boot failed');
    for (const secret of [wrong, MASTER_KEY, token]) expect(dump).not.toContain(secret);
  });
});
