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

const KEY_CHECK_RE = /^crypto\.key_check\.v([1-9][0-9]{0,5})$/;

/**
 * Compare each master key in `keyring` with the key check value stored for its version (constant time). Fails with
 * `key_mismatch` when a version is registered with a different key, so a wrong `RB_MASTER_KEY` is caught at boot
 * instead of failing on every credential.
 *
 * Also fails (security review of P2-03):
 * - `key_version_retired` when a higher version than the current one is registered or used by a row: running on a
 *   retired (possibly leaked) key after a rotation would encrypt new credentials under it;
 * - `key_mismatch` when a loaded key is already registered under another version: reusing an old key under a new
 *   number would defeat the rotation.
 *
 * A version with no stored value is registered only when it is provably right: rows already encrypted under it must
 * decrypt with it (up to three are tried, so one tampered row doesn't block), and with no such rows only the current
 * version is registered (it is the one that will write). A previous key is never registered on trust. Values are
 * written with an atomic insert-if-absent, so when another process registers a different key for the same version
 * first, its value stays and this call fails with `key_mismatch`.
 */
export async function verifyKeyChecks(
  storage: Pick<Storage, 'settings' | 'credentials'>,
  keyring: Keyring,
  options: { readonly register?: boolean } = {},
): Promise<VerifyKeyChecksResult> {
  const settings = await storage.settings.list();
  const stored = new Map<number, Uint8Array | null>();
  for (const [key, value] of Object.entries(settings)) {
    const m = KEY_CHECK_RE.exec(key);
    if (m) stored.set(Number(m[1]), typeof value === 'string' ? fromBase64(value) : null);
  }
  const rows = await storage.credentials.list();
  const current = keyring.currentVersion;
  const newest = Math.max(
    0,
    ...stored.keys(),
    ...rows.map((c) => (c.key.kind === 'encrypted' ? c.key.keyVersion : 0)),
  );
  if (newest > current) throw retired(current, newest);

  const registered: number[] = [];
  for (const version of keyring.versions) {
    const expected = keyring.keyCheckValue(version);
    for (const [other, bytes] of stored) {
      if (other !== version && bytes !== null && timingSafeEqual(bytes, expected)) {
        throw reused(version, other, keyring);
      }
    }
    if (stored.has(version)) {
      const bytes = stored.get(version) ?? null;
      if (bytes === null || !timingSafeEqual(bytes, expected)) throw mismatch(version, keyring);
      continue;
    }
    if (!(options.register ?? true)) continue;
    const sample = rows
      .filter((c) => c.key.kind === 'encrypted' && c.key.keyVersion === version)
      .slice(0, SAMPLE_ROWS);
    if (sample.length === 0 && version !== current) continue;
    if (sample.length > 0 && !(await anyDecrypts(keyring, sample))) throw mismatch(version, keyring);
    registered.push(version);
  }
  // Write only after every version checked out, so a bad key registers nothing. Insert-if-absent (atomic in every
  // adapter): when another process registered this version between our read and our write, its value stays and is
  // compared with ours, so two processes with different keys under one version can never both pass.
  for (const version of registered) {
    const expected = keyring.keyCheckValue(version);
    if (await storage.settings.setIfAbsent(keyCheckSettingKey(version), toBase64(expected))) continue;
    const back = await storage.settings.get(keyCheckSettingKey(version));
    const bytes = typeof back === 'string' ? fromBase64(back) : null;
    if (bytes === null || !timingSafeEqual(bytes, expected)) throw mismatch(version, keyring);
  }
  // Rows under a version the keyring does not hold can never be decrypted (an operator removed the previous key
  // before the rotation finished). Report them so boot can warn; counts only, never ids or key material (P3-15).
  const held = new Set(keyring.versions);
  const missing = new Map<number, number>();
  for (const c of rows) {
    if (c.key.kind === 'encrypted' && !held.has(c.key.keyVersion)) {
      missing.set(c.key.keyVersion, (missing.get(c.key.keyVersion) ?? 0) + 1);
    }
  }
  const unreadable = [...missing].sort((a, b) => a[0] - b[0]).map(([version, rows]) => ({ version, rows }));
  return { registered, unreadable };
}

export interface VerifyKeyChecksResult {
  readonly registered: readonly number[];
  /** Credentials stored under a key version the keyring lacks, per version (they cannot be read until it is back). */
  readonly unreadable: readonly { readonly version: number; readonly rows: number }[];
}

/** Boot warning text for `unreadable`, or `undefined` when every row is readable. */
export function describeUnreadableKeys(unreadable: VerifyKeyChecksResult['unreadable']): string | undefined {
  if (unreadable.length === 0) return undefined;
  const parts = unreadable.map((u) => `${u.rows} under version ${u.version}`).join(', ');
  return (
    `Stored credentials cannot be decrypted with the configured master keys (${parts}): the key they were ` +
    'encrypted with is missing. Restore it as RB_MASTER_KEY_PREVIOUS and run `relic-bridge keys rotate`, or ' +
    'replace those credentials (`credential rotate`).'
  );
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

function retired(current: number, newest: number): CryptoError {
  return new CryptoError(
    'key_version_retired',
    `master key version ${current} is older than version ${newest}, which this database already uses`,
    `Set RB_MASTER_KEY to the version ${newest} key (or a newer one). A retired key must not encrypt new credentials.`,
  );
}

function reused(version: number, other: number, keyring: Keyring): CryptoError {
  return new CryptoError(
    'key_mismatch',
    `the master key given for version ${version} is the key already registered for version ${other}`,
    version === keyring.currentVersion
      ? 'A new version needs a new key: `relic-bridge keys generate --key-version <N>`.'
      : 'Check RB_MASTER_KEY_PREVIOUS: it must be the key of the version it is labelled with.',
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
  storage: Pick<Storage, 'settings' | 'credentials'>,
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
    if (row.key.kind === 'encrypted' && row.key.keyVersion === current) alreadyCurrent++;
    else await rotateRow(storage, keyring, row, reencrypted, failed);
    done++;
    options.onProgress?.(done, rows.length);
  }
  const { versionsInUse } = await versionsAfter(storage, current);
  return {
    currentVersion: current,
    total: rows.length,
    reencrypted,
    alreadyCurrent,
    failed,
    versionsInUse,
  };
}

/** Largest batch {@link rotateCredentialKeysBatch} accepts. */
export const MAX_ROTATION_BATCH = 100;

export interface RotationBatchReport extends RotationReport {
  /** Pass as `after` to continue with the next batch; `null` once every row was visited. */
  readonly nextCursor: string | null;
  /** Rows (whole table) still not on the current version after this batch: failed or not yet visited. */
  readonly pending: number;
}

/**
 * One bounded step of a rotation, for hosts with per-invocation limits (a Worker on D1, P3-11): the same per-row
 * compare-and-swap as {@link rotateCredentialKeys}, over the rows whose id sorts after `after`, stopping after
 * `limit` rows that needed work. Rows already on the current version are skipped without I/O and don't count.
 *
 * Storage calls per batch: two reads for the key checks, one list, at most `limit` updates (one statement each, plus
 * one read when a compare-and-swap misses) and one final list. Calling it again with `nextCursor` until it is `null`
 * visits every row once; calling it again from the start (no `after`) after an interruption skips finished rows, so
 * the operation is resumable and idempotent. `alreadyCurrent` counts the skipped rows of the range this batch scanned.
 */
export async function rotateCredentialKeysBatch(
  storage: Pick<Storage, 'settings' | 'credentials'>,
  keyring: Keyring,
  options: { readonly after?: string | null; readonly limit: number },
): Promise<RotationBatchReport> {
  const { limit } = options;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROTATION_BATCH) {
    throw new CryptoError('invalid_input', `the batch size must be 1-${MAX_ROTATION_BATCH}`);
  }
  await verifyKeyChecks(storage, keyring);
  const current = keyring.currentVersion;
  const after = options.after ?? null;
  const rows = (await storage.credentials.list())
    .filter((c) => c.key.kind === 'encrypted')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const reencrypted: string[] = [];
  const failed: { id: string; code: RotationFailureCode }[] = [];
  let alreadyCurrent = 0;
  let worked = 0;
  let nextCursor: string | null = null;
  let lastVisited: string | null = null;
  for (const row of rows) {
    if (after !== null && row.id <= after) continue;
    if (worked === limit) {
      // More rows remain: resume after the last one this batch visited.
      nextCursor = lastVisited;
      break;
    }
    lastVisited = row.id;
    if (row.key.kind === 'encrypted' && row.key.keyVersion === current) {
      alreadyCurrent++;
      continue;
    }
    worked++;
    await rotateRow(storage, keyring, row, reencrypted, failed);
  }
  const { versionsInUse, pending } = await versionsAfter(storage, current);
  return {
    currentVersion: current,
    total: rows.length,
    reencrypted,
    alreadyCurrent,
    failed,
    versionsInUse,
    nextCursor,
    pending,
  };
}

/** Decrypt, re-encrypt and compare-and-swap one row; records the outcome in `reencrypted` or `failed`. */
async function rotateRow(
  storage: Pick<Storage, 'credentials'>,
  keyring: Keyring,
  row: CredentialRecord,
  reencrypted: string[],
  failed: { id: string; code: RotationFailureCode }[],
): Promise<void> {
  const old = row.key;
  if (old.kind !== 'encrypted') return;
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

async function versionsAfter(
  storage: Pick<Storage, 'credentials'>,
  current: number,
): Promise<{ versionsInUse: number[]; pending: number }> {
  const versions = new Set<number>();
  let pending = 0;
  for (const c of await storage.credentials.list()) {
    if (c.key.kind !== 'encrypted') continue;
    versions.add(c.key.keyVersion);
    if (c.key.keyVersion !== current) pending++;
  }
  return { versionsInUse: [...versions].sort((a, b) => a - b), pending };
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
