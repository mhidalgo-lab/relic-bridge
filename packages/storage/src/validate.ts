// SPDX-License-Identifier: Apache-2.0
// Row rules every adapter enforces. They mirror the CHECK constraints in `schema.ts`, so the in-memory adapter and
// the SQL adapters reject the same input (contract suite), and SQL adapters can fail early with a clear message.
import { InvalidInputError } from './errors.ts';
import { type EncryptedKey, NR_REGIONS, type NrRegion, USER_ROLES, type UserRole } from './types.ts';

/** AES-GCM 96-bit IV (ADR-0007). */
export const IV_BYTES = 12;
export const TOKEN_HASH_RE: RegExp = /^[0-9a-f]{64}$/;
export const MAX_TOKEN_PREFIX = 12;
export const MAX_KEY_HINT = 4;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function checkRole(role: string): UserRole {
  if (!(USER_ROLES as readonly string[]).includes(role)) throw new InvalidInputError('users.role');
  return role as UserRole;
}

export function checkRegion(region: string): NrRegion {
  if (!(NR_REGIONS as readonly string[]).includes(region)) throw new InvalidInputError('credentials.region');
  return region as NrRegion;
}

export function checkEncryptedKey(key: EncryptedKey): void {
  if (key.kind !== 'encrypted') throw new InvalidInputError('credentials.key');
  if (!(key.ciphertext instanceof Uint8Array) || key.ciphertext.byteLength === 0) {
    throw new InvalidInputError('credentials.key_ciphertext');
  }
  if (!(key.iv instanceof Uint8Array) || key.iv.byteLength !== IV_BYTES) {
    throw new InvalidInputError('credentials.key_iv');
  }
  if (!Number.isSafeInteger(key.keyVersion) || key.keyVersion < 1) {
    throw new InvalidInputError('credentials.key_version');
  }
}

export function checkKeyHint(hint: string | null | undefined): void {
  if (hint != null && hint.length > MAX_KEY_HINT) throw new InvalidInputError('credentials.key_hint');
}

export function checkTokenHash(hash: string): void {
  if (!TOKEN_HASH_RE.test(hash)) throw new InvalidInputError('access_tokens.token_hash');
}

export function checkTokenPrefix(prefix: string): void {
  if (prefix.length === 0 || prefix.length > MAX_TOKEN_PREFIX) {
    throw new InvalidInputError('access_tokens.prefix');
  }
}

/** A grant names a user, or is a service grant with a label. */
export function checkGrantPrincipal(userId: string | null, label: string | null): void {
  if (userId === null && label === null) throw new InvalidInputError('grants.principal');
}
