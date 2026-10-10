// SPDX-License-Identifier: Apache-2.0
// Credential domain services (ADR-0008): add a New Relic User key (validated, then encrypted) and re-check stored keys
// so a key revoked in New Relic stops granting access (fail closed).
import {
  assertUserKey,
  type Clock,
  type Credential,
  createBudget,
  DEFAULT_LIMITS,
  ErrorCode,
  type FetchLike,
  type Identity,
  isRbError,
  type Logger,
  NerdGraphClient,
  type Region,
  Secret,
  silentLogger,
  systemClock,
  unboundedLimiter,
  validateKey,
} from '@relic-bridge/core';
import {
  ConflictError,
  type CredentialRecord,
  type CredentialValidation,
  checkRegion,
  newId,
  type Storage,
} from '@relic-bridge/storage';
import { CryptoError } from '../crypto/errors.ts';
import type { Keyring } from '../crypto/keyring.ts';
import { AccessError } from './errors.ts';

/** Asks New Relic who a key belongs to and which accounts it reaches (`actor.user` + `actor.accounts`). */
export type KeyValidator = (credential: Credential) => Promise<Identity>;

/** NerdGraph calls one validation may make (the query plus retries). */
const VALIDATION_BUDGET = 3;
/** Longest label accepted. */
export const MAX_CREDENTIAL_LABEL = 100;

/** The real validator: one `RbIdentity` NerdGraph query with its own small budget. */
export function nerdGraphKeyValidator(
  options: { readonly fetch?: FetchLike; readonly logger?: Logger; readonly clock?: Clock } = {},
): KeyValidator {
  return (credential) =>
    validateKey(
      new NerdGraphClient({
        credential,
        budget: createBudget(VALIDATION_BUDGET),
        limiter: unboundedLimiter,
        logger: options.logger ?? silentLogger,
        clock: options.clock ?? systemClock,
        maxResponseBytes: DEFAULT_LIMITS.maxResponseBytes,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
    );
}

/** Error codes that mean "this key does not work", as opposed to "New Relic could not be asked right now". */
const KEY_REJECTED: ReadonlySet<string> = new Set([
  ErrorCode.AuthInvalidKey,
  ErrorCode.AuthWrongRegion,
  ErrorCode.AuthForbidden,
]);

/** Whether an error from a validator means the key itself was refused (→ `invalid`, fail closed). */
export function isKeyRejection(error: unknown): boolean {
  return isRbError(error) && KEY_REJECTED.has(error.code);
}

function validationFrom(identity: Identity, now: number): CredentialValidation {
  const accounts = [
    ...new Set((identity.accounts ?? []).map((a) => a.id).filter((id) => Number.isSafeInteger(id) && id > 0)),
  ].sort((a, b) => a - b);
  return {
    validationStatus: 'valid',
    validationErrorCode: null,
    validatedAt: now,
    nrUserId: Number.isSafeInteger(identity.user?.id) ? identity.user.id : null,
    nrUserEmail: typeof identity.user?.email === 'string' ? identity.user.email.slice(0, 320) : null,
    reachableAccountIds: accounts,
  };
}

export interface CredentialServiceDeps {
  readonly storage: Pick<Storage, 'credentials' | 'users'>;
  readonly keyring: Keyring;
  readonly validate: KeyValidator;
  readonly clock?: Clock;
}

export interface CreateCredentialInput {
  readonly label: string;
  readonly region: Region;
  /** The NR User key. Taken as a `Secret` so it can't be logged on the way in. */
  readonly apiKey: Secret;
  readonly ownerUserId?: string | null;
}

/**
 * Add a credential: check the key's format, validate it against New Relic (a key New Relic refuses is not stored),
 * encrypt it under the current master key and store it with the reachable accounts.
 */
export async function createCredential(
  deps: CredentialServiceDeps,
  input: CreateCredentialInput,
): Promise<CredentialRecord> {
  const { storage, keyring } = deps;
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (label === '' || label.length > MAX_CREDENTIAL_LABEL) {
    throw new AccessError('invalid_input', `label must be 1-${MAX_CREDENTIAL_LABEL} characters`, 'label');
  }
  let region: Region;
  try {
    region = checkRegion(String(input.region).trim().toUpperCase());
  } catch {
    throw new AccessError('invalid_input', 'region must be US, EU or JP', 'region');
  }
  const ownerUserId = input.ownerUserId ?? null;
  if (ownerUserId !== null) {
    const owner = await storage.users.get(ownerUserId);
    if (owner === null || owner.disabledAt !== null) {
      throw new AccessError('not_found', `user ${ownerUserId} not found`, 'ownerUserId');
    }
  }
  assertUserKey(input.apiKey);
  const plaintext = input.apiKey.reveal().trim();
  const id = newId('cred');
  // Throws for a refused key (RB_AUTH_*) or an unreachable New Relic: nothing is stored either way.
  const identity = await deps.validate(Object.freeze({ id, region, apiKey: new Secret(plaintext) }));
  const now = (deps.clock ?? systemClock).now();
  const key = await keyring.encryptCredentialKey(id, plaintext);
  await storage.credentials.create({
    id,
    label,
    region,
    key,
    keyHint: plaintext.slice(-4),
    ownerUserId,
  });
  return storage.credentials.update(id, { validation: validationFrom(identity, now), ifKey: key });
}

export interface RotateCredentialKeyResult {
  readonly credential: CredentialRecord;
  /** `nr_user_changed`: the new key belongs to another New Relic user than the old one (allowed, but worth a look). */
  readonly warnings: readonly 'nr_user_changed'[];
}

/**
 * Replace a credential's NR key (the user rotated it in New Relic): validate the new key against New Relic first (a
 * refused key changes nothing), encrypt it under the current master key with the same credential id, and swap it in
 * only if the stored key is still the one read here (compare-and-swap). The region stays; reachable accounts are
 * refreshed from the new key.
 */
export async function rotateCredentialKey(
  deps: CredentialServiceDeps,
  id: string,
  apiKey: Secret,
): Promise<RotateCredentialKeyResult> {
  const { storage, keyring } = deps;
  const record = await storage.credentials.get(id);
  if (record === null || record.revokedAt !== null) {
    throw new AccessError('not_found', `credential ${String(id).slice(0, 64)} not found`, 'id');
  }
  const old = record.key;
  if (old.kind !== 'encrypted') {
    throw new AccessError('invalid_input', 'only stored (encrypted) credentials can be rotated', 'id');
  }
  assertUserKey(apiKey);
  const plaintext = apiKey.reveal().trim();
  const identity = await deps.validate(
    Object.freeze({ id, region: record.region, apiKey: new Secret(plaintext) }),
  );
  const now = (deps.clock ?? systemClock).now();
  const key = await keyring.encryptCredentialKey(id, plaintext);
  const validation = validationFrom(identity, now);
  let credential: CredentialRecord;
  try {
    credential = await storage.credentials.update(id, {
      key,
      ifKey: old,
      keyHint: plaintext.slice(-4),
      validation,
    });
  } catch (error) {
    if (error instanceof ConflictError) {
      throw new AccessError(
        'conflict',
        'the credential changed while its key was being replaced; retry',
        'id',
      );
    }
    throw error;
  }
  const warnings: 'nr_user_changed'[] = [];
  if (record.nrUserId !== null && validation.nrUserId !== null && record.nrUserId !== validation.nrUserId) {
    warnings.push('nr_user_changed');
  }
  return Object.freeze({ credential, warnings: Object.freeze(warnings) });
}

export type RevalidationOutcome =
  /** New Relic accepted the key; reachable accounts refreshed. */
  | 'valid'
  /** New Relic refused the key: marked `invalid`, so every grant using it now fails closed. */
  | 'invalid'
  /** Could not decide (network, rate limit, decryption, concurrent change): status left as it was. */
  | 'error'
  /** Revoked, or not stored encrypted (yaml references are checked at stdio startup instead). */
  | 'skipped';

export interface RevalidationResult {
  readonly id: string;
  readonly outcome: RevalidationOutcome;
  /** Error code for `invalid` / `error` / `skipped` (RB_*, crypto or storage code). Never a message with data. */
  readonly code: string | null;
  /** Accounts the key gained / lost since the last validation (`valid` only). */
  readonly accountsAdded: readonly number[];
  readonly accountsRemoved: readonly number[];
}

/**
 * Re-check one stored credential against New Relic. A rejected key is marked `invalid` (fail closed); a valid one
 * gets its reachable accounts refreshed, which also narrows access when the key lost an account. Transient failures
 * change nothing. Writes are compare-and-swapped on the key, so a key replaced meanwhile is never mislabelled.
 */
export async function revalidateCredential(
  deps: CredentialServiceDeps,
  id: string,
): Promise<RevalidationResult> {
  const result = (
    outcome: RevalidationOutcome,
    code: string | null,
    added: readonly number[] = [],
    removed: readonly number[] = [],
  ): RevalidationResult =>
    Object.freeze({ id, outcome, code, accountsAdded: added, accountsRemoved: removed });

  const record = await deps.storage.credentials.get(id);
  if (record === null) throw new AccessError('not_found', `credential ${id} not found`, 'id');
  if (record.revokedAt !== null) return result('skipped', 'revoked');
  const key = record.key;
  if (key.kind !== 'encrypted') return result('skipped', 'not_encrypted');

  let apiKey: Secret;
  try {
    apiKey = await deps.keyring.decryptCredentialKey(id, key);
  } catch (error) {
    if (error instanceof CryptoError) return result('error', error.code);
    throw error;
  }
  const now = (): number => (deps.clock ?? systemClock).now();
  let validation: CredentialValidation;
  try {
    assertUserKey(apiKey);
    validation = validationFrom(
      await deps.validate(Object.freeze({ id, region: record.region, apiKey })),
      now(),
    );
  } catch (error) {
    if (!isKeyRejection(error)) {
      if (isRbError(error)) return result('error', error.code);
      throw error;
    }
    validation = {
      validationStatus: 'invalid',
      validationErrorCode: isRbError(error) ? error.code : 'invalid',
      validatedAt: now(),
      reachableAccountIds: null,
    };
  }
  try {
    await deps.storage.credentials.update(id, { validation, ifKey: key });
  } catch (error) {
    if (error instanceof ConflictError) return result('error', 'key_changed');
    throw error;
  }
  if (validation.validationStatus === 'invalid')
    return result('invalid', validation.validationErrorCode ?? null);
  const before = record.reachableAccountIds ?? [];
  const after = validation.reachableAccountIds ?? [];
  return result(
    'valid',
    null,
    after.filter((a) => !before.includes(a)),
    before.filter((a) => !after.includes(a)),
  );
}

/** Re-check every stored, non-revoked credential (the `credential revalidate` command, or a scheduled job). */
export async function revalidateCredentials(
  deps: CredentialServiceDeps,
): Promise<readonly RevalidationResult[]> {
  const out: RevalidationResult[] = [];
  for (const c of await deps.storage.credentials.list()) {
    // One at a time: each call is a NerdGraph request and runs against the key's own concurrency budget.
    out.push(await revalidateCredential(deps, c.id));
  }
  return out;
}
