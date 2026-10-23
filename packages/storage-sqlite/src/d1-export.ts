// SPDX-License-Identifier: Apache-2.0
// `relic-bridge db export --format d1` (P8-80): the SQLite database of `relic-bridge serve` as a SQL file that
// `wrangler d1 execute <db> --remote --file <file>` imports into the Worker's D1 database.
//
// - Copies stored values as they are: credentials stay AES-GCM ciphertext, tokens stay SHA-256 hashes. Nothing is
//   decrypted and no master key is needed (THREAT_MODEL T7).
// - One read transaction on a read-only connection: a consistent snapshot, safe while `serve` writes.
// - The schema is the one this build's embedded migrations create (checked against the source, which must match), plus
//   the `schema_migrations` rows, so the Worker's boot migration check accepts the database and applies nothing.
// - D1 import rules (docs/RESEARCH.md §12): no BEGIN/COMMIT (D1 runs the file as one transaction and rolls a failed
//   remote import back), `PRAGMA defer_foreign_keys = true` instead of `foreign_keys = OFF`, statements of at most
//   100 KB, one row per statement.
// - The `kv` table is left out: sign-in sessions, login transactions, setup links, OAuth clients, OAuth grants, codes and
//   refresh tokens, remembered consents, task records and counters are short-lived or bound to the old public URL.
import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, migrate, StorageError } from '@relic-bridge/storage';
import { driverFor } from './driver.ts';
import { MEMORY_PATH } from './file.ts';

/** D1's maximum SQL statement length (bytes). */
export const MAX_D1_STATEMENT_BYTES = 100_000;

/** Tables whose rows are never exported (see the header). */
const EXCLUDED_TABLES: ReadonlySet<string> = new Set(['kv']);
/** Tables the import must find empty: a non-empty one means the target is a deployment in use, not a new one. */
const GUARDED_TABLES = ['users', 'credentials', 'projects', 'grants', 'access_tokens'] as const;
const GUARD_TABLE = '_rb_import_guard';
const KEY_CHECK_RE = /^crypto\.key_check\.v([1-9][0-9]{0,5})$/;
/** NUL, C0 controls (newline, tab, …) and DEL: never written raw into the file. */
export function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

export interface D1ExportOptions {
  /** Include the audit log (default `true`). */
  readonly includeAudit?: boolean;
  /** Replace an existing destination file (default `false`: refuse). */
  readonly force?: boolean;
  /** relic-bridge version written in the header. */
  readonly version?: string;
  /** Clock (epoch ms) for the header. */
  readonly now?: () => number;
}

export interface D1ExportSummary {
  /** Schema version (number of embedded migrations). */
  readonly schemaVersion: number;
  /** Exported rows per table (excluded tables absent). */
  readonly rows: Readonly<Record<string, number>>;
  /** Rows the import writes, counting one more per index entry (what D1 bills as rows written). An estimate. */
  readonly rowsWritten: number;
  /** Master key versions the credentials are encrypted under, ascending. */
  readonly credentialKeyVersions: readonly number[];
  /** The master key version the Worker must run with (highest key check or credential version), or null. */
  readonly masterKeyVersion: number | null;
  /** Tables left out. */
  readonly excluded: readonly string[];
  readonly bytes: number;
}

export interface D1Export {
  /** Whole file text. */
  readonly sql: string;
  /** The executable statements in order, without trailing `;` (for a `db.batch` in tests). */
  readonly statements: readonly string[];
  readonly summary: D1ExportSummary;
}

const quoteId = (name: string): string => `\`${name.replaceAll('`', '``')}\``;
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex').toUpperCase();

/**
 * A stored value as an SQLite literal. Text with a control character (NUL, newline, …) becomes `CAST(X'…' AS TEXT)`, so
 * every statement is one line of printable text whatever the data holds; BLOBs become `X'…'`; integers are read as
 * BigInt so none loses precision.
 */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new StorageError('invalid', 'cannot export a non-finite number');
    // A REAL must stay REAL: `1` would come back as INTEGER.
    return Number.isInteger(value) && Math.abs(value) < 1e21 ? `${value}.0` : String(value);
  }
  if (typeof value === 'string') {
    if (hasControlCharacter(value)) return `CAST(X'${hex(new TextEncoder().encode(value))}' AS TEXT)`;
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (value instanceof Uint8Array) return `X'${hex(value)}'`;
  throw new StorageError('invalid', `cannot export a value of type ${typeof value}`);
}

interface SchemaRow {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string;
}

const SCHEMA_QUERY =
  "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' " +
  "AND name NOT LIKE '_cf_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, rowid";

/** The schema this build creates: the embedded migrations applied to an empty in-memory database. */
async function referenceSchema(): Promise<{ rows: SchemaRow[]; db: DatabaseSync }> {
  const db = new DatabaseSync(MEMORY_PATH);
  await migrate(driverFor(db), MIGRATIONS, { now: () => 0 });
  return { rows: db.prepare(SCHEMA_QUERY).all() as unknown as SchemaRow[], db };
}

const comparable = (rows: readonly SchemaRow[]): string =>
  JSON.stringify(
    rows
      .map((r) => [r.type, r.name, r.tbl_name, r.sql])
      .sort((a, b) => `${a[0]}\u0000${a[1]}`.localeCompare(`${b[0]}\u0000${b[1]}`)),
  );

/** `CREATE TABLE x` → `CREATE TABLE IF NOT EXISTS x` (same for indexes), so a Worker that booted first is fine. */
function ifNotExists(sql: string): string {
  const out = sql.replace(/^CREATE (UNIQUE INDEX|INDEX|TABLE) /, 'CREATE $1 IF NOT EXISTS ');
  if (out === sql) throw new StorageError('invalid', 'unexpected schema statement in the reference schema');
  return out;
}

/** User tables, parents before children (foreign keys), ties by name. */
function tableOrder(db: DatabaseSync, names: readonly string[]): string[] {
  const parents = new Map(
    names.map((n) => [
      n,
      new Set(
        (db.prepare(`PRAGMA foreign_key_list(${quoteId(n)})`).all() as { table: string }[])
          .map((f) => f.table)
          .filter((p) => p !== n),
      ),
    ]),
  );
  const sorted = [...names].sort();
  const out: string[] = [];
  while (out.length < sorted.length) {
    const next = sorted.find(
      (n) =>
        !out.includes(n) && [...(parents.get(n) ?? [])].every((p) => out.includes(p) || !names.includes(p)),
    );
    if (next === undefined) throw new StorageError('invalid', 'foreign-key cycle between tables');
    out.push(next);
  }
  return out;
}

/** Throws unless the source's applied migrations are exactly this build's. */
function assertSameMigrations(source: DatabaseSync): void {
  const has = source
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  const applied = has
    ? (source.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as {
        version: bigint | number;
        name: string;
        checksum: string;
      }[])
    : [];
  const same =
    applied.length === MIGRATIONS.length &&
    applied.every((row, i) => {
      const m = MIGRATIONS[i];
      return (
        m !== undefined &&
        Number(row.version) === m.version &&
        row.name === m.name &&
        row.checksum === m.checksum
      );
    });
  if (!same) {
    throw new StorageError(
      'invalid',
      `the database schema (version ${applied.length}) does not match this build (version ${MIGRATIONS.length}): ` +
        (applied.length > MIGRATIONS.length
          ? 'export with the release the server runs (and deploy that release)'
          : 'start `relic-bridge serve` of this release once (it migrates), then export with the same release you deploy'),
    );
  }
}

/**
 * Build the D1 import from an open database. Reads inside one transaction (a consistent snapshot) and never writes to
 * `source`.
 */
export async function buildD1Export(source: DatabaseSync, options: D1ExportOptions = {}): Promise<D1Export> {
  const includeAudit = options.includeAudit ?? true;
  const ref = await referenceSchema();
  try {
    source.exec('BEGIN');
    try {
      assertSameMigrations(source);
      if (comparable(source.prepare(SCHEMA_QUERY).all() as unknown as SchemaRow[]) !== comparable(ref.rows)) {
        throw new StorageError(
          'invalid',
          'the database schema differs from the one its migrations create (edited by hand?); refusing to export it',
        );
      }
      return render(source, ref, includeAudit, options);
    } finally {
      source.exec('COMMIT');
    }
  } finally {
    ref.db.close();
  }
}

function render(
  source: DatabaseSync,
  ref: { rows: SchemaRow[]; db: DatabaseSync },
  includeAudit: boolean,
  options: D1ExportOptions,
): D1Export {
  const tables = ref.rows.filter((r) => r.type === 'table').map((r) => r.name);
  const indexCount = new Map<string, number>();
  for (const r of ref.rows) {
    if (r.type === 'index') indexCount.set(r.tbl_name, (indexCount.get(r.tbl_name) ?? 0) + 1);
  }
  const excluded = [...EXCLUDED_TABLES, ...(includeAudit ? [] : ['audit_log'])].filter((t) =>
    tables.includes(t),
  );
  const statements: string[] = ['PRAGMA defer_foreign_keys = true'];
  // Schema: tables first (creation order), then indexes.
  for (const r of ref.rows) statements.push(ifNotExists(r.sql).replace(/;\s*$/, ''));

  const migrations = source
    .prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')
    .all() as Record<string, unknown>[];
  for (const m of migrations) {
    statements.push(
      'INSERT OR REPLACE INTO `schema_migrations` (`version`, `name`, `checksum`, `applied_at`) VALUES (' +
        `${sqlLiteral(m['version'])}, ${sqlLiteral(m['name'])}, ${sqlLiteral(m['checksum'])}, ${sqlLiteral(m['applied_at'])})`,
    );
  }

  // Guard: the import fails (and D1 rolls it back) when the target already has data of its own.
  statements.push(
    `CREATE TABLE IF NOT EXISTS ${quoteId(GUARD_TABLE)} (\`n\` integer NOT NULL, ` +
      `CONSTRAINT "target_database_must_be_empty" CHECK (\`n\` = 0))`,
    `INSERT INTO ${quoteId(GUARD_TABLE)} (\`n\`) SELECT ${GUARDED_TABLES.map(
      (t) => `(SELECT count(*) FROM ${quoteId(t)})`,
    ).join(' + ')}`,
    `DROP TABLE ${quoteId(GUARD_TABLE)}`,
  );
  // Key check values the target registered for a master key of its own protect no credential (the guard proved it
  // has none); the server's values replace them so the Worker checks its key against the imported data.
  statements.push("DELETE FROM `settings` WHERE `key` LIKE 'crypto.key_check.v%'");

  const rows: Record<string, number> = {};
  let rowsWritten = migrations.length;
  const data = tables.filter((t) => t !== 'schema_migrations' && !excluded.includes(t));
  for (const table of tableOrder(ref.db, data)) {
    const info = ref.db.prepare(`PRAGMA table_info(${quoteId(table)})`).all() as {
      name: string;
      pk: number;
    }[];
    // The audit log's ids are not referenced anywhere: let the target number them, after its own rows.
    const cols = info.filter((c) => !(table === 'audit_log' && c.name === 'id'));
    const pk = info
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => quoteId(c.name));
    const list = cols.map((c) => quoteId(c.name)).join(', ');
    const verb = table === 'settings' ? 'INSERT OR REPLACE INTO' : 'INSERT INTO';
    const stmt = source.prepare(
      `SELECT ${list} FROM ${quoteId(table)} ORDER BY ${pk.length > 0 ? pk.join(', ') : 'rowid'}`,
    );
    stmt.setReadBigInts(true);
    let count = 0;
    for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
      count++;
      const values = cols.map((c) => sqlLiteral(row[c.name])).join(', ');
      const sql = `${verb} ${quoteId(table)} (${list}) VALUES (${values})`;
      const bytes = Buffer.byteLength(sql, 'utf8') + 1;
      if (bytes > MAX_D1_STATEMENT_BYTES) {
        throw new StorageError(
          'invalid',
          `row ${count} of table ${table} is too large for D1 (${bytes} bytes, the limit is ${MAX_D1_STATEMENT_BYTES})` +
            (table === 'audit_log' ? '; export with --no-audit, or purge old audit rows first' : ''),
        );
      }
      statements.push(sql);
    }
    rows[table] = count;
    rowsWritten += count * (1 + (indexCount.get(table) ?? 0));
  }

  const credentialKeyVersions = (
    source.prepare('SELECT DISTINCT key_version AS v FROM credentials ORDER BY v').all() as { v: number }[]
  ).map((r) => Number(r.v));
  const checkVersions = (source.prepare('SELECT key FROM settings').all() as { key: string }[])
    .map((r) => KEY_CHECK_RE.exec(r.key)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number);
  const all = [...credentialKeyVersions, ...checkVersions];
  const masterKeyVersion = all.length === 0 ? null : Math.max(...all);

  const now = new Date((options.now ?? Date.now)()).toISOString();
  const header = [
    `-- relic-bridge ${options.version ?? '(unknown version)'} D1 import, written ${now} (relic-bridge db export --format d1)`,
    `-- Schema version ${MIGRATIONS.length}. Master key version: ${masterKeyVersion === null ? 'none (no key stored)' : `v${masterKeyVersion}`}. Excluded: ${excluded.join(', ') || 'nothing'}.`,
    '-- Holds New Relic key CIPHERTEXT and token HASHES: keep it away from the master key, delete it after the import.',
    '-- Import into a NEW Worker set up with the same master key: wrangler d1 execute <database> --remote --file <this file>',
    '-- The import refuses a database that already has users, keys, projects, grants or tokens.',
    '',
  ].join('\n');
  const sql = `${header}${statements.map((s) => `${s};`).join('\n')}\n`;
  return {
    sql,
    statements,
    summary: {
      schemaVersion: MIGRATIONS.length,
      rows,
      rowsWritten,
      credentialKeyVersions,
      masterKeyVersion,
      excluded,
      bytes: Buffer.byteLength(sql, 'utf8'),
    },
  };
}

const sameFile = (a: string, b: string): boolean => resolve(a) === resolve(b);

/**
 * Export `source` (a database file) to `destination`, created `0600`. Refuses an existing destination unless
 * `force`, and never writes over the database itself or its WAL/SHM files. Opens the source read-only.
 */
export async function exportForD1(
  source: string,
  destination: string,
  options: D1ExportOptions = {},
): Promise<D1ExportSummary> {
  if (destination === MEMORY_PATH || destination.trim() === '') {
    throw new StorageError('invalid', 'export needs a file path');
  }
  if (!existsSync(source)) throw new StorageError('not_found', 'database file not found');
  if ([source, `${source}-wal`, `${source}-shm`, `${source}-journal`].some((p) => sameFile(p, destination))) {
    throw new StorageError('invalid', 'the export file cannot be the database or one of its files');
  }
  const db = new DatabaseSync(source, { readOnly: true });
  let built: D1Export;
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    built = await buildD1Export(db, options);
  } finally {
    db.close();
  }
  // Only now touch the destination: a refused export leaves an existing file as it was. No exists-then-open check:
  // `wx` creates atomically or fails, so nothing can be swapped in between.
  if (options.force ?? false) {
    try {
      unlinkSync(destination); // a new file (and inode), so an old mode or a symlink target is never reused
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new StorageError('invalid', 'cannot replace the export destination (a directory?)', { cause });
      }
    }
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(destination, 'wx', 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      // The age tells a stale export (an earlier run, never deleted) from one just made.
      let modified = '';
      try {
        modified = ` (last modified ${statSync(destination).mtime.toISOString()})`;
      } catch {
        // removed or unreadable since: say nothing rather than guess
      }
      throw new StorageError(
        'conflict',
        `export destination already exists${modified}; refusing to overwrite it (use --force)`,
        { cause },
      );
    }
    throw new StorageError('invalid', 'cannot create the export file', { cause });
  }
  try {
    writeSync(fd, built.sql);
  } catch (cause) {
    closeSync(fd);
    try {
      unlinkSync(destination);
    } catch {
      // best effort
    }
    throw new StorageError('invalid', 'could not write the export file', { cause });
  }
  closeSync(fd);
  return built.summary;
}
