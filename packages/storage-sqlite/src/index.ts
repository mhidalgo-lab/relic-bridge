// SPDX-License-Identifier: Apache-2.0
// `@relic-bridge/storage-sqlite`: the `sqlite` adapter for Node (ADR-0006), on the built-in `node:sqlite`.
// Node only; the runtime-agnostic packages never import it (ADR-0004).
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, MigrationError, migrate, type Storage } from '@relic-bridge/storage';
import {
  buildD1Export,
  type D1Export,
  type D1ExportOptions,
  type D1ExportSummary,
  exportForD1,
  MAX_D1_STATEMENT_BYTES,
  sqlLiteral,
} from './d1-export.ts';
import { driverFor } from './driver.ts';
import { mapSqliteError } from './errors.ts';
import { backupDatabase, MEMORY_PATH, prepareDatabaseFile, snapshotInto } from './file.ts';
import { createRepositories } from './repos.ts';

export {
  backupDatabase,
  buildD1Export,
  type D1Export,
  type D1ExportOptions,
  type D1ExportSummary,
  exportForD1,
  MAX_D1_STATEMENT_BYTES,
  sqlLiteral,
};

export interface SqliteStorageOptions {
  /** Database file, or `:memory:`. Created (`0600`, parent `0700`) when missing. */
  readonly path: string;
  /** Clock in epoch milliseconds (tests). */
  readonly now?: () => number;
  /**
   * Apply pending migrations on open (default `true`). When `false`, an out-of-date or newer database is refused
   * instead; migrate it with a build that has the flag on.
   */
  readonly migrate?: boolean;
  /** How long a writer waits for another connection's lock (default 5000). */
  readonly busyTimeoutMs?: number;
}

export interface SqliteStorage extends Storage {
  readonly kind: 'sqlite';
  readonly path: string;
  /** Consistent snapshot into a new file (`0600`); never overwrites. Safe while serving. */
  backup(destination: string): Promise<void>;
}

/** Throws unless every embedded migration is applied (and nothing newer is). Read-only. */
function assertCurrent(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  const row = table
    ? (db.prepare('SELECT max(version) AS v FROM schema_migrations').get() as { v: number | null })
    : undefined;
  const version = row?.v ?? 0;
  if (version !== MIGRATIONS.length) {
    throw new MigrationError(
      `database schema version is ${version}, this build needs ${MIGRATIONS.length}; start once with migrations enabled`,
    );
  }
}

/** Open (creating if needed) the SQLite database and return the `Storage`. */
export async function openSqliteStorage(options: SqliteStorageOptions): Promise<SqliteStorage> {
  const { path } = options;
  const now = options.now ?? Date.now;
  const busy = Math.trunc(options.busyTimeoutMs ?? 5000);
  if (!Number.isInteger(busy) || busy < 0)
    throw new RangeError('busyTimeoutMs must be a non-negative integer');
  prepareDatabaseFile(path);
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${busy}`);
    db.exec('PRAGMA foreign_keys = ON');
    if (path !== MEMORY_PATH) {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
    }
    if (options.migrate ?? true) await migrate(driverFor(db), MIGRATIONS, { now });
    else assertCurrent(db);
  } catch (error) {
    db.close();
    throw mapSqliteError(error);
  }
  let closed = false;
  return Object.freeze({
    kind: 'sqlite' as const,
    readOnly: false,
    path,
    ...createRepositories(db, now),
    async backup(destination: string) {
      snapshotInto(db, destination);
    },
    async close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  });
}
