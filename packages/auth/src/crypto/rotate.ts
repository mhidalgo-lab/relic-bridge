// SPDX-License-Identifier: Apache-2.0
// Key check values and master-key rotation (ADR-0007). Storage-agnostic: SQLite from the CLI today, D1 later.
import {
  ConflictError,
  type CredentialKeyMaterial,
  type CredentialRecord,
  NotFoundError,
  type Storage,
} from '@relic-bridge/storage';
import { fromBase64, timingSafeEqual, toBase64 } from './bytes.ts';
import { CryptoError, type CryptoErrorCode } from './errors.ts';
import type { Keyring } from './keyring.ts';

/** `settings` key holding the key check value of master key version `version`. */
export const keyCheckSettingKey = (version: number): string => `crypto.key_check.v${version}`;

/** How many existing rows of a version are tried before registering its key check value. */
const SAMPLE_ROWS = 3;

/**
 * Compare each master key in `keyring` with the key check value stored for its version (constant time). Fails with
 * `key_mismatch` when a version is registered with a different key, so a wrong `RB_MASTER_KEY` is caught at boot
 * instead of failing on every credential.
 *
 * A version with no stored value is registered only when it is provably right: rows already encrypted under it must
 * decrypt with it (up to three are tried, so one tampered row doesn't block), and with no such rows only the current
 * version is registered (it is the one that will write). A previous key is never registered on trust.
 */
export async function verifyKeyChecks(
  storage: Pick<Storage, 'settings' | 'credentials'>,
  keyring: Keyring,
  options: { readonly register?: boolean } = {},
): Promise<{ readonly registered: readonly number[] }> {
  const registered: number[] = [];
  let rows: readonly CredentialRecord[] | undefined;
  for (const version of keyring.versions) {
    const expected = keyring.keyCheckValue(version);
    const stored = await storage.settings.get(keyCheckSettingKey(version));
    if (stored !== undefined) {
      const bytes = typeof stored === 'string' ? fromBase64(stored) : null;
      if (bytes === null || !timingSafeEqual(bytes, expected)) throw mismatch(version, keyring);
      continue;
    }
    if (!(options.register ?? true)) continue;
    rows ??= await storage.credentials.list();
    const sample = rows
      .filter((c) => c.key.kind === 'encrypted' && c.key.keyVersion === version)
      .slice(0, SAMPLE_ROWS);
    if (sample.length === 0 && version !== keyring.currentVersion) continue;
    if (sample.length > 0 && !(await anyDecrypts(keyring, sample))) throw mismatch(version, keyring);
    registered.push(version);
  }
  // Write only after every version checked out, so a bad key registers nothing.
  for (const version of registered) {
    await storage.settings.set(keyCheckSettingKey(version), toBase64(keyring.keyCheckValue(version)));
  }
  return { registered };
}

async function anyDecrypts(keyring: Keyring, rows: readonly CredentialRecord[]): Promise<boolean> {
  for (const row of rows) {
    if (row.key.kind !== 'encrypted') continue;
    try {
      await keyring.decryptCredentialKey(row.id, row.key);
      return true;
    } catch {
      // try the next row
    }
  }
  return false;
}

function mismatch(version: number, keyring: Keyring): CryptoError {
  return new CryptoError(
    'key_mismatch',
    `the master key given for version ${version} does not match the data in this database`,
    version === keyring.currentVersion
      ? 'Check RB_MASTER_KEY. A new key needs a new version number (`relic-bridge keys generate --key-version <N>`).'
      : 'Check RB_MASTER_KEY_PREVIOUS: it must be the key the existing rows were encrypted with.',
  );
}

export type RotationFailureCode = CryptoErrorCode | 'conflict';

export interface RotationReport {
  readonly currentVersion: number;
  /** Credentials with an encrypted key. */
  readonly total: number;
  /** Ids re-encrypted by this run. */
  readonly reencrypted: readonly string[];
  /** Already on the current version (skipped). */
  readonly alreadyCurrent: number;
  /** Rows left as they were. `conflict`: changed or deleted while rotating (run again). */
  readonly failed: readonly { readonly id: string; readonly code: RotationFailureCode }[];
  /** Versions still present after the run; `[currentVersion]` (or `[]`) means the previous key can be retired. */
  readonly versionsInUse: readonly number[];
}

/**
 * Re-encrypt every credential (revoked ones included) that is not on `keyring.currentVersion`.
 *
 * Crash-safe and resumable: each row is decrypted, re-encrypted and written as one compare-and-swap
 * (`CredentialPatch.ifKey`), so at every instant each row holds either its old or its new ciphertext, both
 * readable while the keyring has both versions. Running it again skips rows already done. A row whose key changed
 * meanwhile is reported as `conflict` and never overwritten; unknown versions and undecryptable rows are reported,
 * never dropped. Key check values are verified (and the current one registered) before any row is touched.
 */
export async function rotateCredentialKeys(
  storage: Storage,
  keyring: Keyring,
  options: { readonly onProgress?: (done: number, total: number) => void } = {},
): Promise<RotationReport> {
  await verifyKeyChecks(storage, keyring);
  const current = keyring.currentVersion;
  const rows = (await storage.credentials.list()).filter((c) => c.key.kind === 'encrypted');
  const reencrypted: string[] = [];
  const failed: { id: string; code: RotationFailureCode }[] = [];
  let alreadyCurrent = 0;
  let done = 0;
  for (const row of rows) {
    const old = row.key;
    if (old.kind !== 'encrypted') continue;
    if (old.keyVersion === current) {
      alreadyCurrent++;
    } else {
      try {
        const plaintext = await keyring.decryptCredentialKey(row.id, old);
        const next = await keyring.encryptCredentialKey(row.id, plaintext.reveal());
        const written = await storage.credentials.update(row.id, { key: next, ifKey: old });
        // Read-back check: the stored row must decrypt to the same key before we count it. If it doesn't (a bug or
        // a broken adapter), put the old ciphertext back, still as a compare-and-swap.
        if (!(await readsBack(keyring, row.id, written.key, plaintext.reveal()))) {
          if (written.key.kind === 'encrypted') {
            await storage.credentials.update(row.id, { key: old, ifKey: written.key });
          }
          throw new CryptoError('decrypt_failed', `credential ${row.id} did not read back after rotation`);
        }
        reencrypted.push(row.id);
      } catch (error) {
        if (error instanceof CryptoError) failed.push({ id: row.id, code: error.code });
        else if (error instanceof ConflictError || error instanceof NotFoundError)
          failed.push({ id: row.id, code: 'conflict' });
        else throw error;
      }
    }
    done++;
    options.onProgress?.(done, rows.length);
  }
  const versionsInUse = new Set<number>();
  for (const c of await storage.credentials.list()) {
    if (c.key.kind === 'encrypted') versionsInUse.add(c.key.keyVersion);
  }
  return {
    currentVersion: current,
    total: rows.length,
    reencrypted,
    alreadyCurrent,
    failed,
    versionsInUse: [...versionsInUse].sort((a, b) => a - b),
  };
}

async function readsBack(
  keyring: Keyring,
  credentialId: string,
  key: CredentialKeyMaterial,
  expected: string,
): Promise<boolean> {
  if (key.kind !== 'encrypted') return false;
  try {
    return (await keyring.decryptCredentialKey(credentialId, key)).reveal() === expected;
  } catch {
    return false;
  }
}
