// SPDX-License-Identifier: Apache-2.0
// Migrations against a real SQLite engine (node:sqlite, test only; the package itself stays web-standard).
import { DatabaseSync } from 'node:sqlite';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { MigrationError } from '../../src/errors.ts';
import { type Migration, type MigrationDriver, migrate, schemaVersion } from '../../src/migrate.ts';
import { MIGRATIONS } from '../../src/migrations.generated.ts';
import { tables } from '../../src/schema.ts';

type Param = null | number | bigint | string | Uint8Array;

function open(): { db: DatabaseSync; driver: MigrationDriver } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const driver: MigrationDriver = {
    async all(sql, params = []) {
      return db.prepare(sql).all(...(params as Param[])) as Record<string, unknown>[];
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        for (const s of statements) db.prepare(s.sql).run(...((s.params ?? []) as Param[]));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return { db, driver };
}

const userTables = (db: DatabaseSync): string[] =>
  (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);

describe('migrate (node:sqlite)', () => {
  it('applies every migration once and is idempotent', async () => {
    const { db, driver } = open();
    expect(await schemaVersion(driver)).toBe(0);
    const first = await migrate(driver, MIGRATIONS, { now: () => 42 });
    expect(first).toEqual({ applied: MIGRATIONS.map((m) => m.version), version: MIGRATIONS.length });
    const second = await migrate(driver, MIGRATIONS);
    expect(second).toEqual({ applied: [], version: MIGRATIONS.length });
    expect(await schemaVersion(driver)).toBe(MIGRATIONS.length);
    const rows = db.prepare('SELECT version, name, applied_at FROM schema_migrations').all();
    expect(rows).toEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name, applied_at: 42 })));
  });

  it('0001 widens the audit kind check and keeps existing audit rows', async () => {
    const { db, driver } = open();
    await migrate(driver, MIGRATIONS.slice(0, 1));
    const insert = db.prepare("INSERT INTO audit_log (ts, kind, action, status) VALUES (?, ?, 'x', 'ok')");
    insert.run(1, 'tool_call');
    expect(() => insert.run(2, 'auth')).toThrow(/CHECK/);
    await migrate(driver, MIGRATIONS);
    insert.run(3, 'auth');
    expect(() => insert.run(4, 'bogus')).toThrow(/CHECK/);
    expect(db.prepare('SELECT id, ts, kind FROM audit_log ORDER BY id').all()).toEqual([
      { id: 1, ts: 1, kind: 'tool_call' },
      { id: 2, ts: 3, kind: 'auth' },
    ]);
  });

  it('matches the Drizzle schema (no drift)', async () => {
    const { db, driver } = open();
    await migrate(driver, MIGRATIONS);
    const expected = Object.values(tables).map((t) => getTableConfig(t).name);
    expect(userTables(db)).toEqual([...expected, 'schema_migrations'].sort());
    for (const table of Object.values(tables)) {
      const cfg = getTableConfig(table);
      const info = db.prepare(`PRAGMA table_info(\`${cfg.name}\`)`).all() as {
        name: string;
        notnull: number;
        pk: number;
      }[];
      expect(info.map((c) => c.name).sort(), cfg.name).toEqual(cfg.columns.map((c) => c.name).sort());
      for (const col of cfg.columns) {
        const got = info.find((c) => c.name === col.name);
        // A column of a composite primary key (`grant_usage`, P7-12) reports its position, not 1.
        const inPk = col.primary || cfg.primaryKeys.some((pk) => pk.columns.includes(col));
        expect((got?.pk ?? 0) > 0, `${cfg.name}.${col.name} pk`).toBe(inPk);
        expect(got?.notnull === 1 || col.primary, `${cfg.name}.${col.name} not null`).toBe(col.notNull);
      }
      const indexes = (
        db.prepare(`PRAGMA index_list(\`${cfg.name}\`)`).all() as {
          name: string;
          unique: number;
          origin: string;
        }[]
      ).filter((i) => i.origin === 'c');
      expect(indexes.map((i) => `${i.name}:${i.unique}`).sort(), `${cfg.name} indexes`).toEqual(
        cfg.indexes.map((i) => `${i.config.name}:${i.config.unique ? 1 : 0}`).sort(),
      );
      const fks = db.prepare(`PRAGMA foreign_key_list(\`${cfg.name}\`)`).all() as {
        table: string;
        from: string;
        on_delete: string;
      }[];
      expect(fks.map((f) => `${f.from}->${f.table}:${f.on_delete}`).sort(), `${cfg.name} fks`).toEqual(
        cfg.foreignKeys
          .map((fk) => {
            const ref = fk.reference();
            return `${ref.columns[0]?.name}->${getTableConfig(ref.foreignTable).name}:${(fk.onDelete ?? 'no action').toUpperCase()}`;
          })
          .sort(),
      );
    }
  });

  it('enforces the CHECK and foreign-key rules in SQL', async () => {
    const { db, driver } = open();
    await migrate(driver, MIGRATIONS);
    const insertToken = db.prepare(
      'INSERT INTO access_tokens (id, grant_id, prefix, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?, 0)',
    );
    expect(() => insertToken.run('t', 'ghost', 'rb_x', 'f'.repeat(64), 'd')).toThrow(/FOREIGN KEY/);
    db.prepare(
      "INSERT INTO projects (id, slug, default_account_id, allowed_account_ids, limits, created_at, updated_at) VALUES ('p', 'p', 1, '[1]', '{}', 0, 0)",
    ).run();
    db.prepare(
      "INSERT INTO grants (id, project_id, label, limits, created_at, updated_at) VALUES ('g', 'p', 'svc', '{}', 0, 0)",
    ).run();
    expect(() => insertToken.run('t', 'g', 'rb_x', 'rb_plaintext', 'd')).toThrow(/CHECK/);
    expect(() => insertToken.run('t', 'g', 'rb_x', 'F'.repeat(64), 'd')).toThrow(/CHECK/);
    insertToken.run('t', 'g', 'rb_x', 'f'.repeat(64), 'd');
    expect(() =>
      db
        .prepare(
          "INSERT INTO grants (id, project_id, limits, created_at, updated_at) VALUES ('g2', 'p', '{}', 0, 0)",
        )
        .run(),
    ).toThrow(/CHECK/);
    const insertCred = db.prepare(
      "INSERT INTO credentials (id, label, region, key_ciphertext, key_iv, key_version, created_at, updated_at) VALUES (?, 'x', ?, ?, ?, ?, 0, 0)",
    );
    expect(() => insertCred.run('c', 'US', new Uint8Array(8), new Uint8Array(16), 1)).toThrow(/CHECK/);
    expect(() => insertCred.run('c', 'APAC', new Uint8Array(8), new Uint8Array(12), 1)).toThrow(/CHECK/);
    expect(() => insertCred.run('c', 'US', new Uint8Array(8), new Uint8Array(12), 0)).toThrow(/CHECK/);
    insertCred.run('c', 'US', new Uint8Array(8), new Uint8Array(12), 1);
    db.prepare("UPDATE projects SET default_credential_id = 'c' WHERE id = 'p'").run();
    expect(() => db.prepare("DELETE FROM credentials WHERE id = 'c'").run()).toThrow(/FOREIGN KEY/);
    db.prepare("DELETE FROM projects WHERE id = 'p'").run();
    expect(db.prepare('SELECT count(*) AS n FROM access_tokens').get()).toEqual({ n: 0 });
    expect(() =>
      db
        .prepare(
          "INSERT INTO users (id, email, role, created_at, updated_at) VALUES ('u', 'A@b.c', 'owner', 0, 0)",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('refuses a database newer than this build', async () => {
    const { driver } = open();
    await migrate(driver, MIGRATIONS);
    await expect(migrate(driver, MIGRATIONS.slice(0, -1))).rejects.toThrow(/newer than this build/);
  });

  it('refuses an applied migration whose SQL changed (forward-only)', async () => {
    const { driver } = open();
    await migrate(driver, MIGRATIONS);
    const edited = MIGRATIONS.map((m, i) => (i === 0 ? { ...m, checksum: '0'.repeat(64) } : m));
    await expect(migrate(driver, edited)).rejects.toBeInstanceOf(MigrationError);
  });

  it('leaves no partial state when a migration fails, then applies it once fixed', async () => {
    const { db, driver } = open();
    await migrate(driver, MIGRATIONS);
    const broken: Migration = {
      version: MIGRATIONS.length + 1,
      name: '9999_broken',
      checksum: 'a'.repeat(64),
      statements: ['CREATE TABLE `extra` (`id` text PRIMARY KEY NOT NULL)', 'THIS IS NOT SQL'],
    };
    await expect(migrate(driver, [...MIGRATIONS, broken])).rejects.toThrow(/9999_broken failed/);
    expect(userTables(db)).not.toContain('extra');
    expect(await schemaVersion(driver)).toBe(MIGRATIONS.length);
    const fixed = { ...broken, statements: [broken.statements[0] as string] };
    expect((await migrate(driver, [...MIGRATIONS, fixed])).applied).toEqual([fixed.version]);
    expect(userTables(db)).toContain('extra');
  });

  it('refuses a non-contiguous migration list', async () => {
    const { driver } = open();
    const gap = [{ ...(MIGRATIONS[0] as Migration), version: 2 }];
    await expect(migrate(driver, gap)).rejects.toThrow(/not contiguous/);
  });
});
