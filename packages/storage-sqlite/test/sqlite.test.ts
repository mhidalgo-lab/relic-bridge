// SPDX-License-Identifier: Apache-2.0
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, MigrationError, StorageError } from '@relic-bridge/storage';
import { fakeEncryptedKey, runStorageContract } from '@relic-bridge/storage/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { prepareDatabaseFile, snapshotInto } from '../src/file.ts';
import { backupDatabase, openSqliteStorage } from '../src/index.ts';

const root = mkdtempSync(join(tmpdir(), 'rb-sqlite-'));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
let n = 0;
const file = (): string => join(root, `db-${n++}`, 'relic.db');
const posix = process.platform !== 'win32';

runStorageContract({
  name: 'sqlite (memory)',
  accessRecords: true,
  create: (clock) => openSqliteStorage({ path: ':memory:', now: clock.now }),
});
runStorageContract({
  name: 'sqlite (file)',
  accessRecords: true,
  create: (clock) => openSqliteStorage({ path: file(), now: clock.now }),
});

const pragma = (path: string, name: string): unknown => {
  const db = new DatabaseSync(path);
  try {
    return Object.values(db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];
  } finally {
    db.close();
  }
};

describe('audit log at scale (P4-05)', () => {
  it('pages 100k rows by keyset: every row once, deep pages stay a seek', { timeout: 60_000 }, async () => {
    const path = file();
    (await openSqliteStorage({ path })).close();
    const raw = new DatabaseSync(path);
    raw.exec('BEGIN');
    raw.exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
       INSERT INTO audit_log (ts, kind, action, status, project_id, duration_ms)
       SELECT i * 1000, 'tool_call', 'run_nrql', CASE WHEN i % 10 = 0 THEN 'error' ELSE 'ok' END,
              CASE WHEN i % 4 = 0 THEN 'p1' ELSE 'p2' END, i % 500 FROM n`,
    );
    raw.exec('COMMIT');
    raw.close();

    const s = await openSqliteStorage({ path });
    try {
      let seen = 0;
      let before: number | undefined;
      let prev = Number.POSITIVE_INFINITY;
      let slowestPage = 0;
      for (;;) {
        const t0 = performance.now();
        const rows = await s.auditLog.list({
          limit: 1000,
          ...(before === undefined ? {} : { beforeId: before }),
        });
        slowestPage = Math.max(slowestPage, performance.now() - t0);
        if (rows.length === 0) break;
        for (const r of rows) {
          expect(r.id).toBeLessThan(prev);
          prev = r.id;
        }
        seen += rows.length;
        before = rows.at(-1)?.id as number;
      }
      expect(seen).toBe(100_000);
      expect(slowestPage).toBeLessThan(1000);

      // A filtered, time-bounded page near the end of the table, and the aggregate over the whole window.
      const filtered = await s.auditLog.list({
        projectId: 'p1',
        status: 'error',
        since: 50_000_000,
        limit: 5,
      });
      expect(filtered).toHaveLength(5);
      const stats = await s.auditLog.stats({ groupBy: 'project', since: 0, until: 100_001_000 });
      expect(stats.map((r) => [r.key, r.calls, r.errors])).toEqual([
        ['p2', 75_000, 5_000],
        ['p1', 25_000, 5_000],
      ]);
      expect((await s.auditLog.list({ order: 'slowest', limit: 3 })).map((r) => r.durationMs)).toEqual([
        499, 499, 499,
      ]);
    } finally {
      await s.close();
    }

    // The plan for the unfiltered page is a primary-key seek: no scan with a sort. The statement is the one the
    // adapter itself prepares (captured), not a copy of it.
    const prepared: string[] = [];
    const realPrepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
      prepared.push(sql);
      return realPrepare.call(this, sql);
    };
    const s2 = await openSqliteStorage({ path });
    try {
      await s2.auditLog.list({ beforeId: 50_000, limit: 1000 });
    } finally {
      DatabaseSync.prototype.prepare = realPrepare;
      await s2.close();
    }
    const adapterSql = prepared.find((q) => q.startsWith('SELECT * FROM audit_log'));
    expect(adapterSql).toBeDefined();
    const check = new DatabaseSync(path);
    try {
      const plan = check
        .prepare(`EXPLAIN QUERY PLAN ${adapterSql}`)
        .all(50_000, 1000)
        .map((r) => String((r as { detail: string }).detail))
        .join(' | ');
      expect(plan).toMatch(/SEARCH audit_log USING INTEGER PRIMARY KEY/);
      expect(plan).not.toMatch(/TEMP B-TREE/);
    } finally {
      check.close();
    }
  });
});

describe('sqlite adapter', () => {
  it('creates the file 0600 in a 0700 directory, with WAL and foreign keys on', async () => {
    const path = file();
    const s = await openSqliteStorage({ path });
    try {
      await s.settings.set('k', 1);
      if (posix) {
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
        for (const sib of [`${path}-wal`, `${path}-shm`]) {
          if (existsSync(sib)) expect(statSync(sib).mode & 0o077).toBe(0);
        }
      }
      expect(pragma(path, 'journal_mode')).toBe('wal');
      // Foreign keys are per connection: the adapter's own connection must enforce them.
      await expect(s.grants.create({ id: 'g', projectId: 'ghost', label: 'x' })).rejects.toMatchObject({
        code: 'conflict',
      });
    } finally {
      await s.close();
    }
  });

  it('tightens the mode of an existing world-readable file', async () => {
    if (!posix) return;
    const path = file();
    const first = await openSqliteStorage({ path });
    await first.close();
    const { chmodSync } = await import('node:fs');
    chmodSync(path, 0o644);
    await (await openSqliteStorage({ path })).close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('applies migrations on open and keeps data across reopen', async () => {
    const path = file();
    const a = await openSqliteStorage({ path });
    await a.credentials.create({ id: 'c', label: 'x', region: 'US', key: fakeEncryptedKey() });
    await a.close();
    const b = await openSqliteStorage({ path });
    expect((await b.credentials.get('c'))?.label).toBe('x');
    await b.close();
    const db = new DatabaseSync(path);
    expect((db.prepare('SELECT max(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(
      MIGRATIONS.length,
    );
    db.close();
  });

  it('migrate:false refuses a missing, out-of-date or newer schema but opens a current one', async () => {
    const path = file();
    await expect(openSqliteStorage({ path, migrate: false })).rejects.toBeInstanceOf(MigrationError);
    await (await openSqliteStorage({ path })).close();
    await (await openSqliteStorage({ path, migrate: false })).close();
    const db = new DatabaseSync(path);
    db.exec("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (999, 'x', 'y', 0)");
    db.close();
    await expect(openSqliteStorage({ path, migrate: false })).rejects.toBeInstanceOf(MigrationError);
    await expect(openSqliteStorage({ path })).rejects.toBeInstanceOf(MigrationError);
  });

  it('readOnly opens without changing mode, journal mode or content, refuses writes and missing files (P8-74)', async () => {
    const path = file();
    await (await openSqliteStorage({ path })).close();
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA journal_mode = DELETE');
    raw.close();
    if (posix) chmodSync(path, 0o644);
    const before = readFileSync(path);
    const s = await openSqliteStorage({ path, readOnly: true });
    expect(s.readOnly).toBe(true);
    expect(await s.auditLog.list()).toEqual([]);
    await expect(
      s.auditLog.append({ ts: 1, kind: 'admin', action: 'x', status: 'ok' }),
    ).rejects.toBeInstanceOf(Error);
    await s.close();
    if (posix) expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(pragma(path, 'journal_mode')).toBe('delete');
    expect(readFileSync(path).equals(before)).toBe(true);

    const missing = join(root, 'ro-missing', 'relic.db');
    await expect(openSqliteStorage({ path: missing, readOnly: true })).rejects.toBeInstanceOf(StorageError);
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(join(root, 'ro-missing'))).toBe(false);

    const old = new DatabaseSync(path);
    old.exec('DELETE FROM schema_migrations WHERE version = (SELECT max(version) FROM schema_migrations)');
    old.close();
    await expect(openSqliteStorage({ path, readOnly: true, migrate: true })).rejects.toBeInstanceOf(
      MigrationError,
    );
  });

  it("waits for another connection's lock for the busy timeout, then fails", async () => {
    const path = file();
    const s = await openSqliteStorage({ path, busyTimeoutMs: 300 });
    const other = new DatabaseSync(path);
    other.exec('BEGIN IMMEDIATE');
    const started = Date.now();
    await expect(s.settings.set('k', 1)).rejects.toThrow(/locked/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    other.exec('ROLLBACK');
    other.close();
    await s.settings.set('k', 1);
    await s.close();
    await expect(openSqliteStorage({ path, busyTimeoutMs: -1 })).rejects.toThrow(RangeError);
  });

  it('rejects a corrupt file without leaking its content', async () => {
    const path = file();
    await (await openSqliteStorage({ path })).close();
    writeFileSync(path, 'this is not a database'.repeat(50));
    await expect(openSqliteStorage({ path })).rejects.toThrow();
  });

  it('backs up a consistent snapshot (0600, no overwrite, openable)', async () => {
    const path = file();
    const dest = join(root, 'backups', 'copy.db');
    const s = await openSqliteStorage({ path });
    await s.settings.set('hello', 'world');
    await s.backup(dest);
    await s.settings.set('later', true);
    if (posix) expect(statSync(dest).mode & 0o777).toBe(0o600);
    await expect(s.backup(dest)).rejects.toBeInstanceOf(StorageError);
    await s.close();
    const copy = await openSqliteStorage({ path: dest, migrate: false });
    expect(await copy.settings.list()).toEqual({ hello: 'world' });
    await copy.close();
  });

  it('backupDatabase copies a file without opening it for write', async () => {
    const path = file();
    const s = await openSqliteStorage({ path });
    await s.settings.set('a', 1);
    await s.close();
    const dest = join(root, 'backups', 'cold.db');
    backupDatabase(path, dest);
    const copy = await openSqliteStorage({ path: dest, migrate: false });
    expect(await copy.settings.get('a')).toBe(1);
    await copy.close();
    expect(() => backupDatabase(join(root, 'missing.db'), join(root, 'x.db'))).toThrow(/not found/);
  });

  it('never puts column values in error messages', async () => {
    const s = await openSqliteStorage({ path: ':memory:' });
    await s.users.create({ id: 'u1', email: 'secret@x.io', role: 'member' });
    const err = await s.users.create({ id: 'u2', email: 'secret@x.io', role: 'member' }).catch((e) => e);
    expect(String(err.message)).not.toContain('secret@x.io');
    await s.close();
  });
});

describe('database file preparation without check-then-use (P8-99)', () => {
  it.skipIf(!posix)('tightens an existing wide-open file through its own handle', () => {
    const path = file();
    prepareDatabaseFile(path);
    chmodSync(path, 0o666);
    prepareDatabaseFile(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!posix)('refuses a symlink planted at the path and leaves its target alone', () => {
    const dir = join(root, `link-${n++}`);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'target');
    writeFileSync(target, 'x', { mode: 0o644 });
    const link = join(dir, 'relic.db');
    symlinkSync(target, link);
    expect(() => prepareDatabaseFile(link)).toThrow();
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });

  it('the backup never overwrites an existing destination', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const dest = join(root, `bk-${n++}`, 'copy.db');
      snapshotInto(db, dest);
      expect(() => snapshotInto(db, dest)).toThrow(StorageError);
    } finally {
      db.close();
    }
  });
});
