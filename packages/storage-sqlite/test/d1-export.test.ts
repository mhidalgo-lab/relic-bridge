// SPDX-License-Identifier: Apache-2.0
// `db export --format d1` (P8-80): the file a Worker's D1 database imports. The D1 side (import into workerd and a
// Worker serving the imported token) is apps/worker/test/d1-import.test.ts; here the same statements are replayed into
// SQLite, the engine D1 runs.
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { MIGRATIONS, StorageError } from '@relic-bridge/storage';
import { afterAll, describe, expect, it } from 'vitest';
import { hasControlCharacter } from '../src/d1-export.ts';
import {
  buildD1Export,
  exportForD1,
  MAX_D1_STATEMENT_BYTES,
  openSqliteStorage,
  sqlLiteral,
} from '../src/index.ts';

const root = mkdtempSync(join(tmpdir(), 'rb-d1-export-'));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
let n = 0;
const dir = (): string => join(root, `case-${n++}`);
const posix = process.platform !== 'win32';
const T = 1_790_812_800_000;

const NASTY = "O'Brien \u0000 nul\nnew line\r\ttab -- not a comment; DROP TABLE users; 'é漢字🙂";

/** A served database: real migrations, then one row of every kind (raw SQL, values as the adapter stores them). */
async function seeded(path: string): Promise<void> {
  await (await openSqliteStorage({ path, now: () => T })).close();
  const db = new DatabaseSync(path);
  const run = (sql: string, ...params: SQLInputValue[]): void => {
    db.prepare(sql).run(...params);
  };
  try {
    run(
      'INSERT INTO users (id, email, display_name, idp, idp_subject, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      'usr_owner',
      'owner@example.com',
      NASTY,
      'google',
      'sub-1',
      'owner',
      T,
      T,
    );
    run(
      'INSERT INTO credentials (id, owner_user_id, label, region, key_ciphertext, key_iv, key_version, key_hint, ' +
        'nr_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      'cred_a',
      'usr_owner',
      'main',
      'US',
      Uint8Array.from({ length: 48 }, (_, i) => (i * 37) % 256),
      Uint8Array.from({ length: 12 }, (_, i) => (i === 3 ? 0 : 255 - i)),
      2,
      'AB12',
      9_007_199_254_740_993n,
      T,
      T,
    );
    run(
      'INSERT INTO projects (id, slug, default_account_id, allowed_account_ids, limits, default_credential_id, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      'prj_a',
      'prod',
      1,
      '[1]',
      '{}',
      'cred_a',
      T,
      T,
    );
    run(
      'INSERT INTO grants (id, project_id, user_id, limits, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      'gr_a',
      'prj_a',
      'usr_owner',
      '{}',
      T,
      T,
    );
    run(
      'INSERT INTO access_tokens (id, grant_id, prefix, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      'tok_a',
      'gr_a',
      'rb_abcd',
      'c'.repeat(64),
      'laptop',
      T,
    );
    run(
      'INSERT INTO grant_usage (grant_id, period, queries, inspected, updated_at) VALUES (?, ?, ?, ?, ?)',
      'gr_a',
      'd2026-10-01',
      1,
      2,
      T,
    );
    run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', 'crypto.key_check.v2', '"abc="', T);
    run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', 'oauth.registration', 'true', T);
    run(
      'INSERT INTO audit_log (ts, kind, action, status, details) VALUES (?, ?, ?, ?, ?)',
      T,
      'admin',
      'token.create',
      'ok',
      NASTY,
    );
    run(
      'INSERT INTO audit_log (ts, kind, action, status) VALUES (?, ?, ?, ?)',
      T + 1,
      'tool_call',
      'whoami',
      'ok',
    );
    run(
      'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)',
      'sess:abc',
      '{"userId":"usr_owner"}',
      T * 2,
    );
    run('INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)', 'oauth:grant:x', 'sealed', null);
  } finally {
    db.close();
  }
}

/** Replays the export into a new SQLite database (statement by statement, like `wrangler d1 execute`). */
function importInto(target: DatabaseSync, statements: readonly string[]): void {
  target.exec('BEGIN');
  try {
    for (const s of statements) target.exec(s);
    target.exec('COMMIT');
  } catch (error) {
    target.exec('ROLLBACK');
    throw error;
  }
}

const rowsOf = (db: DatabaseSync, table: string, order: string): unknown[] => {
  const stmt = db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`);
  stmt.setReadBigInts(true);
  return stmt.all();
};

async function exported(options: Parameters<typeof buildD1Export>[1] = {}) {
  const path = join(dir(), 'relic.db');
  await seeded(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return { path, out: await buildD1Export(db, options) };
  } finally {
    db.close();
  }
}

describe('sqlLiteral', () => {
  it('escapes quotes, hex-encodes text with control characters and blobs, keeps big integers exact', () => {
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral("it's")).toBe("'it''s'");
    expect(sqlLiteral('a\u0000b')).toBe("CAST(X'610062' AS TEXT)");
    expect(sqlLiteral('line\nbreak')).toBe("CAST(X'6C696E650A627265616B' AS TEXT)");
    expect(sqlLiteral('é🙂')).toBe("'é🙂'");
    expect(sqlLiteral(Uint8Array.of(0, 1, 254, 255))).toBe("X'0001FEFF'");
    expect(sqlLiteral(9_007_199_254_740_993n)).toBe('9007199254740993');
    expect(sqlLiteral(1.5)).toBe('1.5');
    expect(sqlLiteral(2)).toBe('2.0');
    expect(() => sqlLiteral(Number.NaN)).toThrow(StorageError);
    expect(() => sqlLiteral({})).toThrow(StorageError);
  });

  it('round-trips every value through SQLite exactly', () => {
    const db = new DatabaseSync(':memory:');
    try {
      for (const v of [NASTY, '', "''", '\u0000', 'x'.repeat(1000), Uint8Array.of(0, 39, 92, 10)]) {
        const back = db.prepare(`SELECT ${sqlLiteral(v)} AS v, typeof(${sqlLiteral(v)}) AS t`).get() as {
          v: unknown;
          t: string;
        };
        expect(back.v).toEqual(v);
        expect(back.t).toBe(typeof v === 'string' ? 'text' : 'blob');
      }
    } finally {
      db.close();
    }
  });
});

describe('buildD1Export', () => {
  it('is the migrations schema, the migration rows and every row except kv, without transactions', async () => {
    const { out } = await exported();
    const s = out.statements;
    expect(s[0]).toBe('PRAGMA defer_foreign_keys = true');
    expect(s.some((x) => /^\s*(BEGIN|COMMIT|ROLLBACK|END)\b/i.test(x))).toBe(false);
    expect(s.some((x) => /PRAGMA\s+foreign_keys\b/i.test(x))).toBe(false);
    for (const x of s.filter((y) => y.startsWith('CREATE')))
      expect(x).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /);
    expect(s.filter((x) => x.startsWith('INSERT OR REPLACE INTO `schema_migrations`'))).toHaveLength(
      MIGRATIONS.length,
    );
    // The table is created (the Worker uses it), its rows are not copied.
    expect(s.some((x) => x.startsWith('CREATE TABLE IF NOT EXISTS `kv`'))).toBe(true);
    expect(s.some((x) => x.includes('INTO `kv`'))).toBe(false);
    expect(out.sql).not.toContain('sess:abc');
    expect(out.sql).not.toContain('oauth:grant');
    // Every row is one line of printable text (schema statements keep the migrations' layout); all within D1's limit.
    for (const x of s.filter((y) => !y.startsWith('CREATE'))) expect(hasControlCharacter(x)).toBe(false);
    for (const x of s) expect(Buffer.byteLength(x)).toBeLessThanOrEqual(MAX_D1_STATEMENT_BYTES);
    expect(out.sql.endsWith(`${s.at(-1)};\n`)).toBe(true);
    // A statement ends exactly where a line ends with `;` (the split apps/worker/test/d1-import.test.ts relies on).
    const split = out.sql
      .split('\n')
      .filter((l) => !l.startsWith('--'))
      .join('\n')
      .split(/;\n/)
      .map((x) => x.trim())
      .filter((x) => x !== '');
    expect(split).toEqual(s);
    expect(out.summary).toMatchObject({
      schemaVersion: MIGRATIONS.length,
      rows: {
        users: 1,
        credentials: 1,
        projects: 1,
        grants: 1,
        access_tokens: 1,
        grant_usage: 1,
        settings: 2,
        audit_log: 2,
      },
      credentialKeyVersions: [2],
      masterKeyVersion: 2,
      excluded: ['kv'],
    });
    expect(out.sql).toMatch(/^-- relic-bridge .*\n-- Schema version \d+\. Master key version: v2\./);
  });

  it('imports into an empty database as an exact copy (except kv and audit ids)', async () => {
    const { path, out } = await exported();
    const source = new DatabaseSync(path, { readOnly: true });
    const target = new DatabaseSync(':memory:');
    try {
      target.exec('PRAGMA foreign_keys = ON');
      importInto(target, out.statements);
      for (const [table, order] of [
        ['users', 'id'],
        ['credentials', 'id'],
        ['projects', 'id'],
        ['grants', 'id'],
        ['access_tokens', 'id'],
        ['grant_usage', 'grant_id, period'],
        ['settings', 'key'],
        ['schema_migrations', 'version'],
      ] as const) {
        expect(rowsOf(target, table, order), table).toEqual(rowsOf(source, table, order));
      }
      const audit = (db: DatabaseSync): unknown[] =>
        db.prepare('SELECT ts, kind, action, status, details FROM audit_log ORDER BY id').all();
      expect(audit(target)).toEqual(audit(source));
      expect(rowsOf(target, 'kv', 'key')).toEqual([]);
      expect((target.prepare('PRAGMA foreign_key_check').all() as unknown[]).length).toBe(0);
      const schema = (db: DatabaseSync): unknown[] =>
        db
          .prepare(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all();
      expect(schema(target)).toEqual(schema(source));
    } finally {
      source.close();
      target.close();
    }
  });

  it('imports over a database the Worker already migrated, replacing its key check values', async () => {
    const { out } = await exported();
    // A Worker that booted first: migrated, with a key check of its own (another key, another version).
    const targetPath = join(dir(), 'target.db');
    await (await openSqliteStorage({ path: targetPath })).close();
    const target = new DatabaseSync(targetPath);
    try {
      target.exec('PRAGMA foreign_keys = ON');
      target.exec(
        "INSERT INTO settings (key, value, updated_at) VALUES ('crypto.key_check.v1', '\"other\"', 1)",
      );
      importInto(target, out.statements);
      expect(
        target.prepare("SELECT key FROM settings WHERE key LIKE 'crypto.key_check.%' ORDER BY key").all(),
      ).toEqual([{ key: 'crypto.key_check.v2' }]);
    } finally {
      target.close();
    }
  });

  it('refuses to import into a database that already has data (the guard), changing nothing', async () => {
    const { out } = await exported();
    const target = new DatabaseSync(':memory:');
    try {
      importInto(target, out.statements);
      const before = target.prepare('SELECT count(*) AS n FROM audit_log').get();
      expect(() => importInto(target, out.statements)).toThrow(
        /target_database_must_be_empty|CHECK constraint/,
      );
      expect(target.prepare('SELECT count(*) AS n FROM audit_log').get()).toEqual(before);
    } finally {
      target.close();
    }
  });

  it('leaves the audit log out with includeAudit: false', async () => {
    const { out } = await exported({ includeAudit: false });
    expect(out.summary.excluded).toEqual(['kv', 'audit_log']);
    expect(out.summary.rows).not.toHaveProperty('audit_log');
    expect(out.statements.some((x) => x.startsWith('INSERT INTO `audit_log`'))).toBe(false);
    // The table is still created: the Worker writes to it.
    expect(
      out.statements.some(
        (x) => x.startsWith('CREATE TABLE IF NOT EXISTS `audit_log`') || x.includes('"audit_log"'),
      ),
    ).toBe(true);
  });

  it('refuses a row over the D1 statement limit, and names --no-audit for the audit log', async () => {
    const path = join(dir(), 'relic.db');
    await seeded(path);
    const w = new DatabaseSync(path);
    w.prepare('INSERT INTO audit_log (ts, kind, action, status, nrql) VALUES (?, ?, ?, ?, ?)').run(
      T,
      'tool_call',
      'run_nrql',
      'ok',
      `SELECT ${'x'.repeat(MAX_D1_STATEMENT_BYTES)}`,
    );
    w.close();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      await expect(buildD1Export(db)).rejects.toThrow(/audit_log is too large for D1.*--no-audit/);
      await expect(buildD1Export(db, { includeAudit: false })).resolves.toBeDefined();
    } finally {
      db.close();
    }
  });

  it('refuses a database whose migrations or schema differ from this build', async () => {
    const path = join(dir(), 'relic.db');
    await seeded(path);
    const w = new DatabaseSync(path);
    w.exec("UPDATE schema_migrations SET checksum = 'x' WHERE version = 1");
    w.close();
    const db = new DatabaseSync(path, { readOnly: true });
    await expect(buildD1Export(db)).rejects.toThrow(/does not match this build/);
    db.close();

    const path2 = join(dir(), 'relic.db');
    await seeded(path2);
    const w2 = new DatabaseSync(path2);
    w2.exec('CREATE INDEX extra_idx ON users (display_name)');
    w2.close();
    const db2 = new DatabaseSync(path2, { readOnly: true });
    await expect(buildD1Export(db2)).rejects.toThrow(/schema differs/);
    db2.close();

    const empty = new DatabaseSync(':memory:');
    await expect(buildD1Export(empty)).rejects.toThrow(/version 0/);
    empty.close();
  });
});

describe('exportForD1 (file)', () => {
  it('writes a new 0600 file, never overwrites without force, and never writes over the database', async () => {
    const d = dir();
    const path = join(d, 'relic.db');
    await seeded(path);
    const out = join(d, 'out', 'export.sql');
    const summary = await exportForD1(path, out, { version: '9.9.9', now: () => T });
    expect(summary.rows['users']).toBe(1);
    const text = readFileSync(out, 'utf8');
    expect(text.startsWith('-- relic-bridge 9.9.9 D1 import, written 2026-10-01T00:00:00.000Z')).toBe(true);
    if (posix) expect(statSync(out).mode & 0o777).toBe(0o600);

    writeFileSync(out, 'keep me');
    await expect(exportForD1(path, out)).rejects.toMatchObject({ code: 'conflict' });
    expect(readFileSync(out, 'utf8')).toBe('keep me');

    if (posix) chmodSync(out, 0o644);
    await exportForD1(path, out, { force: true });
    expect(readFileSync(out, 'utf8')).toContain('PRAGMA defer_foreign_keys = true;');
    if (posix) expect(statSync(out).mode & 0o777).toBe(0o600);

    for (const target of [path, `${path}-wal`]) {
      await expect(exportForD1(path, target, { force: true })).rejects.toThrow(/cannot be the database/);
    }
    expect(existsSync(path)).toBe(true);
    await expect(exportForD1(join(d, 'missing.db'), join(d, 'x.sql'))).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it.runIf(posix)('replaces a symlink with --force instead of writing through it', async () => {
    const d = dir();
    const path = join(d, 'relic.db');
    await seeded(path);
    const victim = join(d, 'victim.txt');
    writeFileSync(victim, 'untouched');
    const link = join(d, 'export.sql');
    symlinkSync(victim, link);
    await expect(exportForD1(path, link)).rejects.toMatchObject({ code: 'conflict' });
    await exportForD1(path, link, { force: true });
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expect(statSync(link).mode & 0o777).toBe(0o600);
  });

  it('leaves the source untouched (read-only open, no migration, no mode change)', async () => {
    const d = dir();
    const path = join(d, 'relic.db');
    await seeded(path);
    if (posix) chmodSync(path, 0o640);
    const before = readFileSync(path);
    await exportForD1(path, join(d, 'e.sql'));
    expect(readFileSync(path).equals(before)).toBe(true);
    if (posix) expect(statSync(path).mode & 0o777).toBe(0o640);
  });
});
