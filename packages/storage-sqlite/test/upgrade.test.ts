// SPDX-License-Identifier: Apache-2.0
// A database created by each published minor upgrades to the current schema on open (P8-05, versioning policy).
// Fixtures: packages/storage/test/fixtures/db, generated from the release tags by scripts/gen-db-fixtures.ts.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS, MigrationError } from '@relic-bridge/storage';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DB_FIXTURES,
  type DbFixture,
  expectSeededRows,
  expectWritable,
  SCHEMA_SQL,
} from '../../storage/test/upgrade.ts';
import { openSqliteStorage } from '../src/index.ts';

const NOW = 1_800_000_000_000;
const root = mkdtempSync(join(tmpdir(), 'rb-upgrade-'));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
let n = 0;

/** A database file exactly as the release left it. */
function restore(fixture: DbFixture): string {
  const path = join(root, `v${fixture.minor}-${n++}.db`);
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN');
    for (const sql of fixture.dump) db.exec(sql);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  return path;
}

function schemaOf(path: string): unknown[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(SCHEMA_SQL).all();
  } finally {
    db.close();
  }
}

async function freshSchema(): Promise<unknown[]> {
  const path = join(root, `fresh-${n++}.db`);
  await (await openSqliteStorage({ path })).close();
  return schemaOf(path);
}

describe('upgrade from published releases (sqlite)', () => {
  it('has a fixture for every file in fixtures/db', () => {
    const dir = fileURLToPath(new URL('../../storage/test/fixtures/db/', import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(DB_FIXTURES.map((f) => `v${f.minor}.json`).sort()).toEqual(files.sort());
  });

  for (const fixture of DB_FIXTURES) {
    describe(`v${fixture.minor} (${fixture.tag}, schema ${fixture.migrations.length})`, () => {
      it('opens with migrations, reaches the current schema and keeps every row', async () => {
        const path = restore(fixture);
        const storage = await openSqliteStorage({ path, now: () => NOW });
        try {
          await expectSeededRows(storage);
          await expectWritable(storage, NOW);
        } finally {
          await storage.close();
        }
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          const applied = db
            .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
            .all();
          expect(applied).toEqual(
            MIGRATIONS.map((m) => ({ version: m.version, name: m.name, checksum: m.checksum })),
          );
          expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
          expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
        } finally {
          db.close();
        }
        expect(schemaOf(path)).toEqual(await freshSchema());
      });

      it('with migrate: false, is refused while it is behind this build and opens once current', async () => {
        const path = restore(fixture);
        if (fixture.migrations.length < MIGRATIONS.length) {
          await expect(openSqliteStorage({ path, migrate: false })).rejects.toBeInstanceOf(MigrationError);
          await (await openSqliteStorage({ path })).close();
        }
        const storage = await openSqliteStorage({ path, migrate: false });
        await expectSeededRows(storage);
        await storage.close();
      });
    });
  }
});
