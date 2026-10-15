// SPDX-License-Identifier: Apache-2.0
// A D1 database created by each published minor upgrades to the current schema when the Worker opens it (P8-05).
// Same fixtures and checks as the SQLite test (packages/storage/test/upgrade.ts), on the local D1 engine in workerd.
import { env } from 'cloudflare:workers';
import type { D1Database } from '@cloudflare/workers-types';
import { MIGRATIONS, MigrationError } from '@relic-bridge/storage';
import { createD1Storage } from '@relic-bridge/storage/d1';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DB_FIXTURES,
  type DbFixture,
  expectSeededRows,
  expectWritable,
  SCHEMA_SQL,
} from '../../../packages/storage/test/upgrade.ts';
import { wipeD1 } from './helpers.ts';

const db = env.DB as D1Database;
const NOW = 1_800_000_000_000;

/** The database exactly as the release left it (one batch: all of it or nothing). */
async function restore(fixture: DbFixture): Promise<void> {
  await db.batch(fixture.dump.map((sql) => db.prepare(sql)));
}

const schema = async (): Promise<unknown[]> => (await db.prepare(SCHEMA_SQL).all()).results;

describe('upgrade from published releases (d1)', () => {
  beforeEach(() => wipeD1(db));

  for (const fixture of DB_FIXTURES) {
    it(`v${fixture.minor} (${fixture.tag}): reaches the current schema and keeps every row`, async () => {
      await createD1Storage(db);
      const fresh = await schema();
      await wipeD1(db);

      await restore(fixture);
      if (fixture.migrations.length < MIGRATIONS.length) {
        await expect(createD1Storage(db, { migrate: false })).rejects.toBeInstanceOf(MigrationError);
      }
      const storage = await createD1Storage(db, { now: () => NOW });
      await expectSeededRows(storage);
      await expectWritable(storage, NOW);

      const applied = (
        await db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all()
      ).results;
      expect(applied).toEqual(
        MIGRATIONS.map((m) => ({ version: m.version, name: m.name, checksum: m.checksum })),
      );
      expect(await schema()).toEqual(fresh);
    });
  }
});
