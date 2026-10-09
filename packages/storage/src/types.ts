// SPDX-License-Identifier: Apache-2.0
// The persistence contract (ADR-0006). Every adapter (yaml, memory, sqlite, d1) implements `Storage`; core, auth and
// http-app reach persistence only through it. Times are epoch milliseconds. Records are plain, frozen data.

/** New Relic data-center regions. Mirrors `REGIONS` in `@relic-bridge/core` (kept in sync by a CLI test). */
export const NR_REGIONS: readonly NrRegion[] = Object.freeze(['US', 'EU', 'JP'] as const);
export type NrRegion = 'US' | 'EU' | 'JP';

export const USER_ROLES: readonly UserRole[] = Object.freeze(['owner', 'admin', 'member'] as const);
export type UserRole = 'owner' | 'admin' | 'member';

// ---------------------------------------------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------------------------------------------

export interface UserRecord {
  readonly id: string;
  /** Lowercased; unique. */
  readonly email: string;
  readonly displayName: string | null;
  /** Identity provider (`google`, `github`, `cf-access`, `oidc:<name>`); null for users created by the CLI. */
  readonly idp: string | null;
  /** Subject at `idp`; (idp, idpSubject) is unique. */
  readonly idpSubject: string | null;
  readonly role: UserRole;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Disabled users fail closed everywhere. */
  readonly disabledAt: number | null;
}

export interface NewUser {
  readonly id: string;
  readonly email: string;
  readonly displayName?: string | null;
  readonly idp?: string | null;
  readonly idpSubject?: string | null;
  readonly role: UserRole;
}

export type UserPatch = Partial<
  Pick<UserRecord, 'email' | 'displayName' | 'idp' | 'idpSubject' | 'role' | 'disabledAt'>
>;

export interface UsersRepository {
  get(id: string): Promise<UserRecord | null>;
  getByEmail(email: string): Promise<UserRecord | null>;
  getByIdentity(idp: string, idpSubject: string): Promise<UserRecord | null>;
  list(): Promise<readonly UserRecord[]>;
  create(input: NewUser): Promise<UserRecord>;
  update(id: string, patch: UserPatch): Promise<UserRecord>;
}

// ---------------------------------------------------------------------------------------------------------------
// Credentials (NR User keys)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Where a credential's NR key lives. SQL adapters only ever hold `encrypted` (THREAT_MODEL T7): AES-256-GCM
 * ciphertext, its 96-bit IV and the master-key version; AAD is `credential id || key version` (ADR-0007, P2-03).
 * The read-only `yaml` adapter yields references instead: an environment variable name, or an inline literal from
 * the file (warned about), which is exposed only through `reveal()` and never serialised.
 */
export type CredentialKeyMaterial =
  | {
      readonly kind: 'encrypted';
      readonly ciphertext: Uint8Array;
      readonly iv: Uint8Array;
      readonly keyVersion: number;
    }
  | { readonly kind: 'env'; readonly variable: string }
  | { readonly kind: 'inline'; reveal(): string };

/** Encrypted key as written by SQL-backed adapters. */
export type EncryptedKey = Extract<CredentialKeyMaterial, { kind: 'encrypted' }>;

export type CredentialValidationStatus = 'unvalidated' | 'valid' | 'invalid';

export interface CredentialRecord {
  readonly id: string;
  readonly ownerUserId: string | null;
  readonly label: string;
  readonly region: NrRegion;
  readonly key: CredentialKeyMaterial;
  /** Last 4 characters of the key, for display (ADR-0007). Null when unknown (yaml references). */
  readonly keyHint: string | null;
  /** Result of the last `actor.user` / `actor.accounts` check (P2-04); `invalid` fails closed. */
  readonly validationStatus: CredentialValidationStatus;
  readonly validationErrorCode: string | null;
  readonly validatedAt: number | null;
  readonly nrUserId: number | null;
  readonly nrUserEmail: string | null;
  /** Account ids the key can reach; null until validated (unknown). */
  readonly reachableAccountIds: readonly number[] | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revokedAt: number | null;
}

export interface NewCredential {
  /** Caller-generated, because it is part of the encryption AAD. */
  readonly id: string;
  readonly ownerUserId?: string | null;
  readonly label: string;
  readonly region: NrRegion;
  readonly key: EncryptedKey;
  readonly keyHint?: string | null;
}

export interface CredentialValidation {
  readonly validationStatus: CredentialValidationStatus;
  readonly validationErrorCode?: string | null;
  readonly validatedAt: number;
  readonly nrUserId?: number | null;
  readonly nrUserEmail?: string | null;
  readonly reachableAccountIds?: readonly number[] | null;
}

export interface CredentialPatch {
  readonly label?: string;
  /** Re-encryption (master-key rotation, P2-03) or a replaced key. */
  readonly key?: EncryptedKey;
  /**
   * Compare-and-swap guard: apply the patch only if the stored key is still exactly this one (ciphertext, IV and
   * version); otherwise fail with `ConflictError` (`credentials.key`) and change nothing. Rotation (P2-03) uses it
   * so a key replaced while it re-encrypts is never overwritten with the old one.
   */
  readonly ifKey?: EncryptedKey;
  readonly keyHint?: string | null;
  readonly validation?: CredentialValidation;
  readonly revokedAt?: number | null;
}

export interface CredentialsRepository {
  get(id: string): Promise<CredentialRecord | null>;
  list(filter?: { readonly ownerUserId?: string }): Promise<readonly CredentialRecord[]>;
  create(input: NewCredential): Promise<CredentialRecord>;
  update(id: string, patch: CredentialPatch): Promise<CredentialRecord>;
  /** Fails with `ConflictError` while a project or grant references it (revoke instead). */
  delete(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------------------------

/** Query-limit overrides; absent fields fall back to the defaults (core `DEFAULT_LIMITS`). */
export interface StoredLimits {
  readonly maxLimit?: number;
  readonly maxWindowDays?: number;
  readonly rawNrql?: boolean;
  readonly maxResponseBytes?: number;
  readonly eventTypes?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] };
}

export interface ProjectRecord {
  readonly id: string;
  /** URL slug (`/p/{slug}/mcp`); unique. */
  readonly slug: string;
  readonly name: string | null;
  readonly defaultAccountId: number;
  readonly allowedAccountIds: readonly number[];
  /** Upper limit of tools; null = every built-in read-only tool. */
  readonly enabledTools: readonly string[] | null;
  readonly limits: StoredLimits;
  readonly defaultCredentialId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Disabled projects reject every request. */
  readonly disabledAt: number | null;
}

export interface NewProject {
  readonly id: string;
  readonly slug: string;
  readonly name?: string | null;
  readonly defaultAccountId: number;
  readonly allowedAccountIds: readonly number[];
  readonly enabledTools?: readonly string[] | null;
  readonly limits?: StoredLimits;
  readonly defaultCredentialId?: string | null;
}

export type ProjectPatch = Partial<
  Pick<
    ProjectRecord,
    | 'slug'
    | 'name'
    | 'defaultAccountId'
    | 'allowedAccountIds'
    | 'enabledTools'
    | 'limits'
    | 'defaultCredentialId'
    | 'disabledAt'
  >
>;

export interface ProjectsRepository {
  get(id: string): Promise<ProjectRecord | null>;
  getBySlug(slug: string): Promise<ProjectRecord | null>;
  list(): Promise<readonly ProjectRecord[]>;
  create(input: NewProject): Promise<ProjectRecord>;
  update(id: string, patch: ProjectPatch): Promise<ProjectRecord>;
  /** Deletes the project with its grants and their access tokens. Audit rows stay. */
  delete(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------------------------------------------

/** Per-grant rate limit (P2-07). */
export interface StoredRateLimit {
  readonly requests: number;
  readonly perSeconds: number;
}

export interface GrantRecord {
  readonly id: string;
  readonly projectId: string;
  /** Null for service grants. */
  readonly userId: string | null;
  /** Display name, required for service grants. */
  readonly label: string | null;
  /** Null → the project's default credential. */
  readonly credentialId: string | null;
  /** Tool allowlist; null = everything the project enables. Never widens the project. */
  readonly tools: readonly string[] | null;
  /** Account allowlist; null = every project account. Never widens the project. */
  readonly accountIds: readonly number[] | null;
  /** Tightens the project limits (P2-04). */
  readonly limits: StoredLimits;
  readonly rateLimit: StoredRateLimit | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
}

export interface NewGrant {
  readonly id: string;
  readonly projectId: string;
  readonly userId?: string | null;
  readonly label?: string | null;
  readonly credentialId?: string | null;
  readonly tools?: readonly string[] | null;
  readonly accountIds?: readonly number[] | null;
  readonly limits?: StoredLimits;
  readonly rateLimit?: StoredRateLimit | null;
  readonly expiresAt?: number | null;
}

export type GrantPatch = Partial<
  Pick<
    GrantRecord,
    'label' | 'credentialId' | 'tools' | 'accountIds' | 'limits' | 'rateLimit' | 'expiresAt' | 'revokedAt'
  >
>;

export interface GrantsRepository {
  get(id: string): Promise<GrantRecord | null>;
  list(filter?: { readonly projectId?: string; readonly userId?: string }): Promise<readonly GrantRecord[]>;
  create(input: NewGrant): Promise<GrantRecord>;
  update(id: string, patch: GrantPatch): Promise<GrantRecord>;
  /** Deletes the grant and its access tokens. */
  delete(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------
// Access tokens (per device, P2-05)
// ---------------------------------------------------------------------------------------------------------------

export interface AccessTokenRecord {
  readonly id: string;
  readonly grantId: string;
  /** Leading characters for display (`rb_…`); never enough to use the token. */
  readonly prefix: string;
  /** SHA-256 of the token, lowercase hex. The plaintext is never stored (ADR-0007). Unique. */
  readonly tokenHash: string;
  /** Device name. */
  readonly label: string;
  readonly createdAt: number;
  /** Null = never expires (allowed with a warning). */
  readonly expiresAt: number | null;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
}

export interface NewAccessToken {
  readonly id: string;
  readonly grantId: string;
  readonly prefix: string;
  readonly tokenHash: string;
  readonly label: string;
  readonly expiresAt?: number | null;
}

export interface AccessTokensRepository {
  get(id: string): Promise<AccessTokenRecord | null>;
  getByHash(tokenHash: string): Promise<AccessTokenRecord | null>;
  list(filter?: { readonly grantId?: string }): Promise<readonly AccessTokenRecord[]>;
  create(input: NewAccessToken): Promise<AccessTokenRecord>;
  /** Records use; callers throttle (P2-05). */
  markUsed(id: string, at: number): Promise<void>;
  revoke(id: string, at: number): Promise<AccessTokenRecord>;
}

// ---------------------------------------------------------------------------------------------------------------
// Audit log (append-only, THREAT_MODEL T17)
// ---------------------------------------------------------------------------------------------------------------

/** `auth`: a request refused before or at authentication or by a rate limit (no tool ran). */
export type AuditKind = 'tool_call' | 'admin' | 'auth';
export type AuditStatus = 'ok' | 'error' | 'denied';

/** One audit row. Never holds secret values (P2-08 masks NRQL literals before calling `append`). */
export interface AuditEntry {
  readonly ts: number;
  readonly kind: AuditKind;
  /** Tool name (`run_nrql`) or admin action (`token.create`). */
  readonly action: string;
  readonly status: AuditStatus;
  readonly requestId?: string | null;
  readonly userId?: string | null;
  readonly grantId?: string | null;
  readonly tokenId?: string | null;
  /** OAuth client id (Phase 5). */
  readonly clientId?: string | null;
  /** Pass-through key fingerprint id (`pt_` + 12 hex, P2-16): who, without the key. Null on grant-based rows. */
  readonly keyId?: string | null;
  readonly projectId?: string | null;
  readonly accountIds?: readonly number[] | null;
  /** Masked/hashed NRQL (P2-08). */
  readonly nrql?: string | null;
  readonly durationMs?: number | null;
  readonly inspectedCount?: number | null;
  readonly errorCode?: string | null;
  /** Admin target (`credential`, `token`, …) and its id. */
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  /** Small, non-secret extra data. */
  readonly details?: Readonly<Record<string, unknown>> | null;
}

export interface AuditRecord extends Required<AuditEntry> {
  /** Monotonic id, also the pagination cursor. */
  readonly id: number;
}

export interface AuditQuery {
  readonly projectId?: string;
  readonly userId?: string;
  readonly grantId?: string;
  readonly tokenId?: string;
  /** Exact pass-through key id. */
  readonly keyId?: string;
  /** `true`: only pass-through rows (any key id). */
  readonly passthrough?: boolean;
  readonly kind?: AuditKind;
  /** Exact action (`run_nrql`, `token.create`, `auth.denied`). */
  readonly action?: string;
  readonly status?: AuditStatus;
  /** Inclusive lower bound on `ts`. */
  readonly since?: number;
  /** Exclusive upper bound on `ts`. */
  readonly until?: number;
  /** Only rows with `id` below this (next page, newest first). */
  readonly beforeId?: number;
  /** Default 100, max 1000. */
  readonly limit?: number;
}

export interface AuditLogRepository {
  append(entry: AuditEntry): Promise<void>;
  /** Newest first. */
  list(query?: AuditQuery): Promise<readonly AuditRecord[]>;
  /**
   * Retention job only: deletes rows with `ts` < `before` (oldest first, at most `limit` when given, so a job with a
   * time or row budget can work in batches); returns the count.
   */
  purgeBefore(before: number, limit?: number): Promise<number>;
}

// ---------------------------------------------------------------------------------------------------------------
// Settings and KV
// ---------------------------------------------------------------------------------------------------------------

/** JSON-serialisable values. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [k: string]: JsonValue };

export interface SettingsRepository {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  /**
   * Atomic insert-if-absent: writes `value` only when `key` has no value yet. Resolves `true` when this call wrote
   * it, `false` when a value was already there (left untouched). Used for write-once values such as key check values.
   */
  setIfAbsent(key: string, value: JsonValue): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(): Promise<Readonly<Record<string, JsonValue>>>;
}

export interface KvPutOptions {
  /** Absolute expiry, epoch **seconds** (Workers KV semantics). */
  readonly expiration?: number;
  /** Relative expiry in seconds (≥ 60 on Workers KV; any positive value here). */
  readonly expirationTtl?: number;
}

export interface KvListResult {
  readonly keys: readonly { readonly name: string; readonly expiration?: number }[];
  readonly complete: boolean;
  /** Pass back to continue; present when `complete` is false. */
  readonly cursor?: string;
}

/** KV-compatible store (Workers KV semantics) for the OAuth provider on Node (ADR-0009). Expired keys are invisible. */
export interface KvRepository {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: KvPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys in lexicographic order. `limit` default and max 1000. */
  list(options?: {
    readonly prefix?: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<KvListResult>;
}

// ---------------------------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------------------------

export type StorageKind = 'yaml' | 'memory' | 'sqlite' | 'd1';

export interface Storage {
  readonly kind: StorageKind;
  /** Read-only adapters reject every write with `ReadOnlyStorageError`. */
  readonly readOnly: boolean;
  readonly users: UsersRepository;
  readonly credentials: CredentialsRepository;
  readonly projects: ProjectsRepository;
  readonly grants: GrantsRepository;
  readonly accessTokens: AccessTokensRepository;
  readonly auditLog: AuditLogRepository;
  readonly settings: SettingsRepository;
  readonly kv: KvRepository;
  close(): Promise<void>;
}
