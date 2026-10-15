// SPDX-License-Identifier: Apache-2.0
// The migration runner's driver over one `node:sqlite` connection (shared by `openSqliteStorage` and `db export`).
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { MigrationDriver } from '@relic-bridge/storage';

export function driverFor(db: DatabaseSync): MigrationDriver {
  return {
    async all(sql, params = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as Record<string, unknown>[];
    },
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const s of statements) db.prepare(s.sql).run(...((s.params ?? []) as SQLInputValue[]));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
