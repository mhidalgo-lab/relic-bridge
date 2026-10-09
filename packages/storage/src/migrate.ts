// SPDX-License-Identifier: Apache-2.0
// Forward-only migration runner shared by the SQL adapters (sqlite on Node, d1 on Workers). Migrations are the
// drizzle-kit SQL files embedded in `migrations.generated.ts`; `schema_migrations` records what has been applied.
//
// - Idempotent: applied versions are skipped, so running it on every start is safe.
// - Forward-only: there are no down migrations; a database newer than this build is refused, and an applied
//   migration whose SQL changed afterwards (checksum mismatch) is refused.
// - Atomic: each migration and its `schema_migrations` row go through one `driver.batch` (a transaction on Node, a
//   D1 batch on Workers). Two runners racing on the same version: the loser's batch fails on the primary key.
import { MigrationError } from './errors.ts';

export interface Migration {
  /** 1, 2, 3, … contiguous. */
  readonly version: number;
  readonly name: string;
  /** SHA-256 (hex) of the statements; detects edits to an applied migration. */
  readonly checksum: string;
  readonly statements: readonly string[];
}

export interface SqlStatement {
  readonly sql: string;
  readonly params?: readonly unknown[];
}

/** The two operations the runner needs from a SQL driver. */
export interface MigrationDriver {
  all(sql: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  /** Runs all statements atomically: all of them or none. */
  batch(statements: readonly SqlStatement[]): Promise<void>;
}

export interface MigrateResult {
  /** Versions applied by this call, in order. */
  readonly applied: readonly number[];
  /** Schema version after the call. */
  readonly version: number;
}

export const SCHEMA_MIGRATIONS_DDL: string =
  'CREATE TABLE IF NOT EXISTS `schema_migrations` (' +
  '`version` integer PRIMARY KEY NOT NULL, ' +
  '`name` text NOT NULL, ' +
  '`checksum` text NOT NULL, ' +
  '`applied_at` integer NOT NULL)';

function validateList(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new MigrationError(`migration list is not contiguous at ${m.name}`);
  });
}

/** Current schema version (0 = empty database). */
export async function schemaVersion(driver: MigrationDriver): Promise<number> {
  await driver.batch([{ sql: SCHEMA_MIGRATIONS_DDL }]);
  const rows = await driver.all('SELECT max(`version`) AS v FROM `schema_migrations`');
  const v = rows[0]?.['v'];
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0;
}

export async function migrate(
  driver: MigrationDriver,
  migrations: readonly Migration[],
  options: { readonly now?: () => number } = {},
): Promise<MigrateResult> {
  validateList(migrations);
  const now = options.now ?? Date.now;
  await driver.batch([{ sql: SCHEMA_MIGRATIONS_DDL }]);
  const rows = await driver.all(
    'SELECT `version`, `name`, `checksum` FROM `schema_migrations` ORDER BY `version`',
  );
  const known = new Map(migrations.map((m) => [m.version, m]));
  const applied = new Set<number>();
  for (const row of rows) {
    const version = Number(row['version']);
    const m = known.get(version);
    if (m === undefined) {
      throw new MigrationError(
        `database schema version ${version} is newer than this build (${migrations.length}); ` +
          'upgrade relic-bridge — downgrades are not supported',
      );
    }
    if (row['checksum'] !== m.checksum) {
      throw new MigrationError(
        `applied migration ${m.name} differs from this build; migrations are forward-only, add a new one instead`,
      );
    }
    applied.add(version);
  }
  const done: number[] = [];
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    try {
      await driver.batch([
        ...m.statements.map((sql) => ({ sql })),
        {
          sql: 'INSERT INTO `schema_migrations` (`version`, `name`, `checksum`, `applied_at`) VALUES (?, ?, ?, ?)',
          params: [m.version, m.name, m.checksum, now()],
        },
      ]);
    } catch (cause) {
      throw new MigrationError(`migration ${m.name} failed`, { cause });
    }
    done.push(m.version);
  }
  return { applied: done, version: migrations.length };
}
