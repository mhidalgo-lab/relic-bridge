// SPDX-License-Identifier: Apache-2.0
// Database file hygiene (THREAT_MODEL T7): the file and its WAL/SHM siblings must not be readable by other users.
// SQLite creates `-wal` and `-shm` with the permissions of the main file, so securing that one is enough.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StorageError } from '@relic-bridge/storage';

export const MEMORY_PATH = ':memory:';
const isWindows = process.platform === 'win32';

/** Create the parent directory (`0700`) and the file (`0600`) before SQLite touches it; tighten an existing file. */
export function prepareDatabaseFile(path: string): void {
  if (path === MEMORY_PATH) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    closeSync(openSync(path, 'wx', 0o600));
    return;
  }
  if (!isWindows && (statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
}

/**
 * Write a consistent snapshot of `db` to a new file (`VACUUM INTO`): safe while other connections write, includes the
 * WAL contents. Never overwrites; the copy is `0600`.
 */
export function snapshotInto(db: DatabaseSync, destination: string): void {
  if (destination === MEMORY_PATH || destination.trim() === '') {
    throw new StorageError('invalid', 'backup needs a file path');
  }
  if (existsSync(destination)) {
    throw new StorageError('conflict', 'backup destination already exists; refusing to overwrite it');
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  // VACUUM INTO accepts only a missing or empty file; create it ourselves so it is `0600` from the start.
  closeSync(openSync(destination, 'wx', 0o600));
  try {
    db.prepare('VACUUM INTO ?').run(destination);
  } catch (cause) {
    try {
      unlinkSync(destination);
    } catch {
      // best effort
    }
    throw new StorageError('invalid', 'backup failed', { cause });
  }
}

/**
 * Back up a database file without migrating or otherwise changing it (use it before an upgrade). Opens the source
 * read-only.
 */
export function backupDatabase(source: string, destination: string): void {
  if (!existsSync(source)) throw new StorageError('not_found', 'database file not found');
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    snapshotInto(db, destination);
  } finally {
    db.close();
  }
}
