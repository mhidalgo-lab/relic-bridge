// SPDX-License-Identifier: Apache-2.0
// Adapter-agnostic storage errors. Messages carry entity names and ids only, never column values (which may be
// ciphertext, hashes or user data).

export type StorageErrorCode = 'not_found' | 'conflict' | 'invalid' | 'read_only' | 'migration';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  constructor(code: StorageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageError';
    this.code = code;
  }
}

/** Update/delete of a row that does not exist. Lookups return `null` instead. */
export class NotFoundError extends StorageError {
  constructor(entity: string, id: string | number) {
    super('not_found', `${entity} ${String(id)} not found`);
    this.name = 'NotFoundError';
  }
}

/** Unique or referential constraint violated (duplicate slug/email/hash, unknown or still-referenced row). */
export class ConflictError extends StorageError {
  readonly constraint: string;
  constructor(constraint: string, message: string, options?: { cause?: unknown }) {
    super('conflict', message, options);
    this.name = 'ConflictError';
    this.constraint = constraint;
  }
}

/** A value breaks a row rule (the schema's CHECK constraints, mirrored in `validate.ts`). */
export class InvalidInputError extends StorageError {
  readonly field: string;
  constructor(field: string) {
    super('invalid', `invalid value for ${field}`);
    this.name = 'InvalidInputError';
    this.field = field;
  }
}

/** Write attempted on a read-only adapter (`yaml`). */
export class ReadOnlyStorageError extends StorageError {
  constructor(kind: string) {
    super('read_only', `${kind} storage is read-only`);
    this.name = 'ReadOnlyStorageError';
  }
}

export class MigrationError extends StorageError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('migration', message, options);
    this.name = 'MigrationError';
  }
}

/** `CredentialPatch.ifKey` did not match: the stored key changed since it was read. */
export function keyChangedError(credentialId: string): ConflictError {
  return new ConflictError('credentials.key', `credential ${credentialId} key changed since it was read`);
}

/** `ConflictError.constraint` of an update that would leave no enabled owner (P4-16). */
export const LAST_OWNER_CONSTRAINT = 'users.last_owner';

/** The update would demote or disable the last enabled owner (P4-16). */
export function lastOwnerError(): ConflictError {
  return new ConflictError(LAST_OWNER_CONSTRAINT, 'the last enabled owner cannot be demoted or disabled');
}
