// SPDX-License-Identifier: Apache-2.0
// The D1 adapter inside workerd against the local D1 simulator (`DB` from wrangler.jsonc): the shared storage
// contract, plus what only D1 can show (single-statement atomicity across concurrent calls, foreign keys without a
// PRAGMA, migrations run at boot by several isolates at once).
import { env } from 'cloudflare:workers';
import type { D1Database } from '@cloudflare/workers-types';
import { ConflictError, MIGRATIONS, type Migration, MigrationError, migrate } from '@relic-bridge/storage';
import {
  createD1Storage,
  type D1DatabaseLike,
  d1MigrationDriver,
  mapD1Error,
} from '@relic-bridge/storage/d1';
import { fakeEncryptedKey, runStorageContract } from '@relic-bridge/storage/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { runAccessEquivalence } from '../../../packages/auth/test/access-equivalence.ts';
import { wipeD1 } from './helpers.ts';

const db = env.DB as D1Database;
const wipe = (): Promise<void> => wipeD1(db);

runStorageContract({
  name: 'd1 (workerd, local D1)',
  accessRecords: true,
  create: async (clock) => {
    await wipe();
    return createD1Storage(db, { now: clock.now });
  },
});

describe('access resolution equivalence (d1)', () => {
  // P3-09: the one-batch path decides exactly like the repository path, on the real D1 engine. Fewer runs than on
  // Node: every run writes a fresh world through the local D1 simulator.
  runAccessEquivalence({
    name: 'd1',
    open: async () => {
      await wipe();
      return createD1Storage(db);
    },
    runs: 30,
    timeout: 120_000,
  });
});

describe('d1 adapter', () => {
  beforeEach(wipe);

  it('applies every migration once and is idempotent on reopen', async () => {
    await createD1Storage(db);
    await createD1Storage(db);
    const row = await db.prepare('SELECT count(*) AS n, max(version) AS v FROM schema_migrations').first();
    expect(row).toEqual({ n: MIGRATIONS.length, v: MIGRATIONS.length });
  });

  it('lets isolates that boot at once on an empty database all open it', async () => {
    const opened = await Promise.all([1, 2, 3, 4].map(() => createD1Storage(db)));
    expect(opened).toHaveLength(4);
    const row = await db.prepare('SELECT count(*) AS n FROM schema_migrations').first();
    expect(row).toEqual({ n: MIGRATIONS.length });
  });

  it('refuses a database migrated by a newer build, or an edited applied migration', async () => {
    await createD1Storage(db);
    await db
      .prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
      .bind(MIGRATIONS.length + 1, '9999_future', 'x', 0)
      .run();
    await expect(createD1Storage(db)).rejects.toBeInstanceOf(MigrationError);
    await wipe();
    await createD1Storage(db);
    await db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').bind('edited').run();
    await expect(createD1Storage(db)).rejects.toBeInstanceOf(MigrationError);
  });

  it('with migrate: false, opens a current database and refuses an empty or outdated one', async () => {
    await expect(createD1Storage(db, { migrate: false })).rejects.toBeInstanceOf(MigrationError);
    await createD1Storage(db);
    await expect(createD1Storage(db, { migrate: false })).resolves.toMatchObject({ kind: 'd1' });
    await db.prepare('DELETE FROM schema_migrations WHERE version = ?').bind(MIGRATIONS.length).run();
    await expect(createD1Storage(db, { migrate: false })).rejects.toBeInstanceOf(MigrationError);
  });

  it('rolls a failing migration back as a whole (D1 batch is atomic)', async () => {
    const broken: Migration[] = [
      { version: 1, name: '0000_t', checksum: 'a', statements: ['CREATE TABLE t1 (x integer)', 'NOT SQL'] },
    ];
    await expect(migrate(d1MigrationDriver(db), broken)).rejects.toBeInstanceOf(MigrationError);
    const t = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 't1'").first();
    expect(t).toBeNull();
    await db.prepare('DROP TABLE IF EXISTS t1').run();
  });

  it('skips PRAGMA foreign_keys in migrations (a no-op inside the D1 batch transaction)', async () => {
    const seen: string[] = [];
    const recording: D1DatabaseLike = {
      prepare: (sql) => {
        seen.push(sql);
        return (db as unknown as D1DatabaseLike).prepare(sql);
      },
      batch: (statements) => (db as unknown as D1DatabaseLike).batch(statements),
    };
    await createD1Storage(recording);
    expect(seen.some((q) => /PRAGMA/i.test(q))).toBe(false);
    expect(MIGRATIONS.some((m) => m.statements.some((q) => /^PRAGMA foreign_keys/i.test(q)))).toBe(true);
    const fk = await db.prepare('PRAGMA foreign_keys').first();
    expect(Object.values(fk ?? {})).toEqual([1]);
  });

  it('enforces foreign keys without a PRAGMA: unknown references, restrict and cascade', async () => {
    const s = await createD1Storage(db);
    await expect(s.grants.create({ id: 'g', projectId: 'ghost', label: 'x' })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await s.credentials.create({ id: 'c', label: 'k', region: 'US', key: fakeEncryptedKey() });
    await s.projects.create({
      id: 'p',
      slug: 'p',
      defaultAccountId: 1,
      allowedAccountIds: [1],
      defaultCredentialId: 'c',
    });
    await s.grants.create({ id: 'g', projectId: 'p', label: 'svc' });
    await s.accessTokens.create({
      id: 't',
      grantId: 'g',
      prefix: 'rb_x',
      tokenHash: 'a'.repeat(64),
      label: 'd',
    });
    await expect(s.credentials.delete('c')).rejects.toMatchObject({ code: 'conflict' });
    await s.projects.delete('p');
    expect(await s.grants.get('g')).toBeNull();
    expect(await s.accessTokens.get('t')).toBeNull();
  });

  it('setIfAbsent has exactly one winner across concurrent calls', async () => {
    const [a, b] = await Promise.all([createD1Storage(db), createD1Storage(db)]);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        ((i % 2 === 0 ? a : b) as typeof a).settings.setIfAbsent('kcv', i),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results.indexOf(true);
    expect(await a.settings.get('kcv')).toBe(winner);
  });

  it('applies exactly one of several racing key compare-and-swaps', async () => {
    const s = await createD1Storage(db);
    await s.credentials.create({ id: 'c', label: 'k', region: 'US', key: fakeEncryptedKey(1) });
    const outcomes = await Promise.allSettled(
      [2, 3, 4, 5].map((seed) =>
        s.credentials.update('c', { key: fakeEncryptedKey(seed, 2), ifKey: fakeEncryptedKey(1) }),
      ),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    for (const o of outcomes) {
      if (o.status === 'rejected') expect(o.reason).toMatchObject({ constraint: 'credentials.key' });
    }
  });

  it('patches only the given columns, so concurrent updates of different fields both stick', async () => {
    const s = await createD1Storage(db);
    await s.users.create({ id: 'u', email: 'u@example.com', role: 'member' });
    await Promise.all([
      s.users.update('u', { displayName: 'U' }),
      s.users.update('u', { role: 'admin' }),
      s.users.update('u', { disabledAt: 5 }),
    ]);
    expect(await s.users.get('u')).toMatchObject({ displayName: 'U', role: 'admin', disabledAt: 5 });
  });

  it('maps engine errors to storage errors without values in the message', async () => {
    const s = await createD1Storage(db);
    await s.users.create({ id: 'u', email: 'secret-ish@example.com', role: 'member' });
    const e = await s.users
      .create({ id: 'u2', email: 'secret-ish@example.com', role: 'member' })
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'conflict', constraint: 'users.email' });
    expect((e as Error).message).not.toContain('secret-ish');
    expect(mapD1Error(new Error('D1_ERROR: CHECK constraint failed: grants_principal_check'))).toMatchObject({
      code: 'invalid',
      field: 'grants.principal',
    });
    const other = new Error('network');
    expect(mapD1Error(other)).toBe(other);
  });
});
