// SPDX-License-Identifier: Apache-2.0
// Map SQLite engine errors to the adapter-agnostic storage errors. Messages carry constraint names only, never values.
import { ConflictError, InvalidInputError, StorageError } from '@relic-bridge/storage';

const UNIQUE = /UNIQUE constraint failed: ([\w.]+)/;
const CHECK = /CHECK constraint failed: (\w+)/;

export function mapSqliteError(error: unknown): unknown {
  if (error instanceof StorageError) return error;
  const message = error instanceof Error ? error.message : '';
  const unique = UNIQUE.exec(message);
  if (unique)
    return new ConflictError(unique[1] as string, 'a row with this unique value already exists', {
      cause: error,
    });
  if (message.includes('FOREIGN KEY constraint failed')) {
    return new ConflictError('foreign_key', 'a referenced row is missing, or the row is still referenced', {
      cause: error,
    });
  }
  const check = CHECK.exec(message);
  if (check) return new InvalidInputError(check[1] as string);
  if (message.includes('NOT NULL constraint failed')) return new InvalidInputError('not_null');
  return error;
}
