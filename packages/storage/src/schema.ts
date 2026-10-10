// SPDX-License-Identifier: Apache-2.0
// Drizzle schema, SQLite dialect (ADR-0006): the single source for the `sqlite` (Node) and `d1` (Workers) adapters.
// Change it, then run `pnpm --filter @relic-bridge/storage db:generate` and commit the new migration.
//
// Conventions: ids are caller-generated text; times are INTEGER epoch milliseconds; lists and objects are JSON text.
// Secrets: NR keys only as AES-256-GCM ciphertext + IV + key version (ADR-0007, THREAT_MODEL T7); access tokens only
// as SHA-256 hex (T1/T15). `schema_migrations` is owned by the migration runner (`migrate.ts`), not by this file.
import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { StoredLimits, StoredQuota, StoredRateLimit } from './types.ts';

/** BLOB as `Uint8Array` on every driver (node:sqlite, better-sqlite3 `Buffer`, D1 `ArrayBuffer` / number[]). */
const bytes = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'blob',
  toDriver: (value) => value,
  fromDriver: (value: unknown) => toBytes(value),
});

export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new TypeError('expected a BLOB value');
}

const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>();

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    idp: text('idp'),
    idpSubject: text('idp_subject'),
    role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    disabledAt: integer('disabled_at'),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(t.email),
    uniqueIndex('users_identity_unique').on(t.idp, t.idpSubject),
    check('users_role_check', sql`${t.role} IN ('owner', 'admin', 'member')`),
    check('users_email_lower_check', sql`${t.email} = lower(${t.email})`),
  ],
);

export const credentials = sqliteTable(
  'credentials',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'restrict' }),
    label: text('label').notNull(),
    region: text('region', { enum: ['US', 'EU', 'JP'] }).notNull(),
    keyCiphertext: bytes('key_ciphertext').notNull(),
    keyIv: bytes('key_iv').notNull(),
    keyVersion: integer('key_version').notNull(),
    keyHint: text('key_hint'),
    validationStatus: text('validation_status', { enum: ['unvalidated', 'valid', 'invalid'] })
      .notNull()
      .default('unvalidated'),
    validationErrorCode: text('validation_error_code'),
    validatedAt: integer('validated_at'),
    nrUserId: integer('nr_user_id'),
    nrUserEmail: text('nr_user_email'),
    reachableAccountIds: json<number[]>('reachable_account_ids'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [
    index('credentials_owner_idx').on(t.ownerUserId),
    check('credentials_region_check', sql`${t.region} IN ('US', 'EU', 'JP')`),
    check(
      'credentials_validation_status_check',
      sql`${t.validationStatus} IN ('unvalidated', 'valid', 'invalid')`,
    ),
    check('credentials_key_version_check', sql`${t.keyVersion} > 0`),
    check('credentials_key_iv_check', sql`length(${t.keyIv}) = 12`),
    check('credentials_key_hint_check', sql`${t.keyHint} IS NULL OR length(${t.keyHint}) <= 4`),
  ],
);

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name'),
    defaultAccountId: integer('default_account_id').notNull(),
    allowedAccountIds: json<number[]>('allowed_account_ids').notNull(),
    enabledTools: json<string[]>('enabled_tools'),
    limits: json<StoredLimits>('limits').notNull(),
    defaultCredentialId: text('default_credential_id').references(() => credentials.id, {
      onDelete: 'restrict',
    }),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    disabledAt: integer('disabled_at'),
  },
  (t) => [
    uniqueIndex('projects_slug_unique').on(t.slug),
    index('projects_default_credential_idx').on(t.defaultCredentialId),
  ],
);

export const grants = sqliteTable(
  'grants',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    label: text('label'),
    credentialId: text('credential_id').references(() => credentials.id, { onDelete: 'restrict' }),
    tools: json<string[]>('tools'),
    accountIds: json<number[]>('account_ids'),
    limits: json<StoredLimits>('limits').notNull(),
    rateLimit: json<StoredRateLimit>('rate_limit'),
    quota: json<StoredQuota>('quota'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    expiresAt: integer('expires_at'),
    revokedAt: integer('revoked_at'),
  },
  (t) => [
    index('grants_project_idx').on(t.projectId),
    index('grants_user_idx').on(t.userId),
    index('grants_credential_idx').on(t.credentialId),
    check('grants_principal_check', sql`${t.userId} IS NOT NULL OR ${t.label} IS NOT NULL`),
  ],
);

export const accessTokens = sqliteTable(
  'access_tokens',
  {
    id: text('id').primaryKey(),
    grantId: text('grant_id')
      .notNull()
      .references(() => grants.id, { onDelete: 'cascade' }),
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    label: text('label').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at'),
    lastUsedAt: integer('last_used_at'),
    revokedAt: integer('revoked_at'),
  },
  (t) => [
    uniqueIndex('access_tokens_hash_unique').on(t.tokenHash),
    index('access_tokens_grant_idx').on(t.grantId),
    check(
      'access_tokens_hash_check',
      sql`length(${t.tokenHash}) = 64 AND ${t.tokenHash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check('access_tokens_prefix_check', sql`length(${t.prefix}) <= 12`),
  ],
);

/** Usage counters per grant and UTC period (P7-12): `d2026-10-06` / `m2026-10`. Rows go with their grant. */
export const grantUsage = sqliteTable(
  'grant_usage',
  {
    grantId: text('grant_id')
      .notNull()
      .references(() => grants.id, { onDelete: 'cascade' }),
    period: text('period').notNull(),
    queries: integer('queries').notNull().default(0),
    inspected: integer('inspected').notNull().default(0),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.grantId, t.period] }),
    index('grant_usage_updated_idx').on(t.updatedAt),
    check('grant_usage_counts_check', sql`${t.queries} >= 0 AND ${t.inspected} >= 0`),
  ],
);

/** Append-only (THREAT_MODEL T17). No foreign keys: rows outlive the users, grants and projects they mention. */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    kind: text('kind', { enum: ['tool_call', 'admin', 'auth'] }).notNull(),
    action: text('action').notNull(),
    status: text('status', { enum: ['ok', 'error', 'denied'] }).notNull(),
    requestId: text('request_id'),
    userId: text('user_id'),
    grantId: text('grant_id'),
    tokenId: text('token_id'),
    clientId: text('client_id'),
    keyId: text('key_id'),
    projectId: text('project_id'),
    accountIds: json<number[]>('account_ids'),
    nrql: text('nrql'),
    durationMs: integer('duration_ms'),
    inspectedCount: integer('inspected_count'),
    errorCode: text('error_code'),
    targetType: text('target_type'),
    targetId: text('target_id'),
    details: json<Record<string, unknown>>('details'),
  },
  (t) => [
    index('audit_log_ts_idx').on(t.ts),
    index('audit_log_project_ts_idx').on(t.projectId, t.ts),
    index('audit_log_user_ts_idx').on(t.userId, t.ts),
    index('audit_log_key_ts_idx').on(t.keyId, t.ts),
    check('audit_log_kind_check', sql`${t.kind} IN ('tool_call', 'admin', 'auth')`),
    check('audit_log_status_check', sql`${t.status} IN ('ok', 'error', 'denied')`),
  ],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** KV-compatible table for the OAuth provider on Node (ADR-0009). `expires_at` is epoch milliseconds. */
export const kv = sqliteTable(
  'kv',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at'),
  },
  (t) => [index('kv_expires_idx').on(t.expiresAt)],
);

/** Every table the migrations create, for drift checks and adapters. */
export const tables = Object.freeze({
  users,
  credentials,
  projects,
  grants,
  accessTokens,
  grantUsage,
  auditLog,
  settings,
  kv,
});
