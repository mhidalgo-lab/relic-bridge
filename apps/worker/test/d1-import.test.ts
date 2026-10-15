// SPDX-License-Identifier: Apache-2.0
// Migration from a self-hosted server (P8-80): the file `relic-bridge db export --format d1` wrote from a real SQLite
// database (built in Node by `test/node/d1-import-setup.ts`) is imported into D1 in workerd, and the Worker, started
// with the server's master key, serves the server's device token with the server's encrypted New Relic key.
import { env } from 'cloudflare:workers';
import type { D1Database } from '@cloudflare/workers-types';
import { generateMasterKey } from '@relic-bridge/auth';
import { createD1Storage } from '@relic-bridge/storage/d1';
import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SCHEMA_SQL } from '../../../packages/storage/test/upgrade.ts';
import type { WorkerEnv } from '../src/env.ts';
import { createWorker } from '../src/worker.ts';
import { call, connect, fakeCtx, mockNerdGraph, wipeD1 } from './helpers.ts';
import { D1_IMPORT_NR_KEY } from './node/d1-import-fixture.ts';

const db = env.DB as D1Database;
const fixture = inject('d1Import');
const serverEnv: WorkerEnv = { ...(env as WorkerEnv), RB_MASTER_KEY: fixture.masterKey };

/**
 * The file's statements: comment lines dropped, then split at a `;` that ends a line (rows are one line each, schema
 * statements end with `);`). The export's own unit test checks this split gives back exactly its statements.
 */
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.startsWith('--'))
    .join('\n')
    .split(/;\n/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** What `wrangler d1 execute --remote --file` does: the whole file, all of it or nothing. */
async function importFile(sql: string): Promise<void> {
  await db.batch(statements(sql).map((s) => db.prepare(s)));
}

const count = async (table: string): Promise<number> =>
  (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? -1;

const health = async (e: WorkerEnv): Promise<number> =>
  (await call(createWorker({ logSink: () => {} }), e, fakeCtx(), '/health')).status;

describe('import of a self-hosted database into D1 (P8-80)', () => {
  beforeEach(() => wipeD1(db));

  it('serves the server token with the server key, and keeps revoked tokens, audit rows and no sessions', async () => {
    await importFile(fixture.sql);

    const nerdgraph = mockNerdGraph();
    const worker = createWorker({ fetch: nerdgraph.fetch, logSink: () => {} });
    const ctx = fakeCtx();
    const client = await connect(worker, serverEnv, ctx, fixture.token);
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    expect(result.isError ?? false).toBe(false);
    // The credential imported as ciphertext decrypted under the server's key.
    expect(nerdgraph.keys).toEqual([D1_IMPORT_NR_KEY]);
    await client.close();
    await ctx.settle();

    const refused = await call(worker, serverEnv, fakeCtx(), '/p/prod/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.revokedToken}`, 'Content-Type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    expect(refused.status).toBe(401);

    expect(await count('kv')).toBe(0);
    const audit = (await db.prepare('SELECT kind, action, nrql FROM audit_log ORDER BY id').all()).results;
    expect(audit.slice(0, 2)).toEqual([
      {
        kind: 'tool_call',
        action: 'run_nrql',
        nrql: "SELECT count(*) FROM Transaction WHERE name = '?'\nSINCE 1 hour ago",
      },
      { kind: 'admin', action: 'token.create', nrql: null },
    ]);
    expect(audit.some((r) => (r as { action: string }).action === 'whoami')).toBe(true);
    expect((await db.prepare('SELECT display_name FROM users').first())?.['display_name']).toBe("O'Neil");
  });

  it('has the schema and migration rows a Worker creates itself, so boot applies nothing', async () => {
    await createD1Storage(db);
    const fresh = (await db.prepare(SCHEMA_SQL).all()).results;
    const migrations = (
      await db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all()
    ).results;
    await wipeD1(db);
    await importFile(fixture.sql);
    expect((await db.prepare(SCHEMA_SQL).all()).results).toEqual(fresh);
    expect(
      (await db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all())
        .results,
    ).toEqual(migrations);
    await expect(createD1Storage(db, { migrate: false })).resolves.toBeDefined();
  });

  it('works after the Worker booted with a key of its own: the server key serves, the generated one is refused', async () => {
    // The order the deploy report used: cf:setup generated a key, the Worker answered a first request with it.
    const generated: WorkerEnv = { ...(env as WorkerEnv), RB_MASTER_KEY: generateMasterKey(1) };
    expect(await health(generated)).toBe(200);
    expect(await count('settings')).toBeGreaterThan(0);

    await importFile(fixture.sql);
    expect(await health(serverEnv)).toBe(200);
    // The generated key's check value is gone: running on it now is a key mismatch, not a silent second key.
    expect(await health(generated)).toBe(503);
    const checks = (await db.prepare("SELECT key FROM settings WHERE key LIKE 'crypto.key_check.%'").all())
      .results;
    expect(checks).toEqual([{ key: 'crypto.key_check.v2' }]);
  });

  it('refuses a second import into a database that has data, changing nothing', async () => {
    await importFile(fixture.sql);
    const before = {
      users: await count('users'),
      tokens: await count('access_tokens'),
      audit: await count('audit_log'),
    };
    await expect(importFile(fixture.sql)).rejects.toThrow(/target_database_must_be_empty|CHECK constraint/);
    expect({
      users: await count('users'),
      tokens: await count('access_tokens'),
      audit: await count('audit_log'),
    }).toEqual(before);
  });
});
