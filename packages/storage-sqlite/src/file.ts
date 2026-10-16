// SPDX-License-Identifier: Apache-2.0
// Database file hygiene (THREAT_MODEL T7): the file and its WAL/SHM siblings must not be readable by other users.
// SQLite creates `-wal` and `-shm` with the permissions of the main file, so securing that one is enough.
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StorageError } from '@relic-bridge/storage';

export const MEMORY_PATH = ':memory:';
const isWindows = process.platform === 'win32';

// `O_NOFOLLOW` (absent on Windows) refuses a symlink planted at the path, so we never chmod or open its target.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

/**
 * Create the parent directory (`0700`) and the file (`0600`) before SQLite touches it; tighten an existing file.
 *
 * No check-then-use: the file is created with `O_EXCL` (atomic, `0600` from the first byte) or, when it exists, opened
 * once (`O_NOFOLLOW`) and inspected and chmod-ed through that handle, so a swap between the check and the chmod cannot
 * redirect it to another file (CWE-367).
 */
export function prepareDatabaseFile(path: string): void {
  if (path === MEMORY_PATH) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600));
    return;
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error;
  }
  if (isWindows) return;
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (stat.isFile() && (stat.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

/**
 * Write a consistent snapshot of `db` to a new file (`VACUUM INTO`): safe while other connections write, includes the
 * WAL contents. Never overwrites; the copy is `0600`.
 */
export function snapshotInto(db: DatabaseSync, destination: string): void {
  if (destination === MEMORY_PATH || destination.trim() === '') {
    throw new StorageError('invalid', 'backup needs a file path');
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  // VACUUM INTO accepts only a missing or empty file; create it ourselves (`O_EXCL`: atomic, refuses an existing file
  // or a symlink, `0600` from the start) rather than checking first.
  try {
    closeSync(
      openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600),
    );
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      throw new StorageError('conflict', 'backup destination already exists; refusing to overwrite it');
    }
    throw error;
  }
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
