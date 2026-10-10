// SPDX-License-Identifier: Apache-2.0
// Everything one request's access decision needs, in one storage call (P3-09). The SQL adapters run these statements
// together: one D1 `batch()` (one round trip, one read transaction) or one SQLite read transaction. The rows feed the
// same pure checks as the per-repository path (`verifyAccessToken` + `resolveAccess` in `@relic-bridge/auth`).
import type { AccessTokenRecord, CredentialRecord, GrantRecord, ProjectRecord, UserRecord } from './types.ts';

export interface AccessRecordsQuery {
  /** SHA-256 of the presented token, lowercase hex. */
  readonly tokenHash: string;
  /** The slug from the request URL; `null` when it is malformed (then no project is found). */
  readonly projectSlug: string | null;
}

/**
 * The rows behind one access decision. Contract (every adapter that implements `loadAccessRecords`):
 * - no token has this hash → every field is `null`;
 * - `project`: the project with this slug; `grant`: the token's grant;
 * - `user`, `credential` and `credentialOwner` are loaded **only** when the grant belongs to that project (THREAT_MODEL
 *   T2: nothing else of another project's grant is read), else `null`;
 * - `user`: the grant's user (`null` for a service grant); `credential`: `grant.credentialId ??
 *   project.defaultCredentialId`; `credentialOwner`: the credential's owner when it has one that is not the grant's
 *   user, else `null`.
 */
export interface AccessRecords {
  readonly token: AccessTokenRecord | null;
  readonly project: ProjectRecord | null;
  readonly grant: GrantRecord | null;
  readonly user: UserRecord | null;
  readonly credential: CredentialRecord | null;
  readonly credentialOwner: UserRecord | null;
}

/** The empty result (unknown token). */
export const NO_ACCESS_RECORDS: AccessRecords = Object.freeze({
  token: null,
  project: null,
  grant: null,
  user: null,
  credential: null,
  credentialOwner: null,
});

// Token → its grant → that grant's project, which must be the one the slug addresses (T2). Parameters: slug, hash.
const SCOPED_TO_PROJECT =
  'FROM access_tokens t JOIN grants g ON g.id = t.grant_id JOIN projects p ON p.id = g.project_id AND p.slug = ?';
const CREDENTIAL = 'JOIN credentials c ON c.id = coalesce(g.credential_id, p.default_credential_id)';

/**
 * The SQL behind `loadAccessRecords`, one statement per `AccessRecords` field in field order. Each returns at most one
 * row (token hash, slug and ids are unique). Parameters are bound, never interpolated: see `accessRecordsParams`.
 */
export const ACCESS_RECORDS_SQL: Readonly<Record<keyof AccessRecords, string>> = Object.freeze({
  token: 'SELECT * FROM access_tokens WHERE token_hash = ?',
  // The project only alongside a known token, so an unknown token yields nothing at all.
  project:
    'SELECT p.* FROM projects p WHERE p.slug = ? AND EXISTS (SELECT 1 FROM access_tokens WHERE token_hash = ?)',
  grant: 'SELECT g.* FROM access_tokens t JOIN grants g ON g.id = t.grant_id WHERE t.token_hash = ?',
  user: `SELECT u.* ${SCOPED_TO_PROJECT} JOIN users u ON u.id = g.user_id WHERE t.token_hash = ?`,
  credential: `SELECT c.* ${SCOPED_TO_PROJECT} ${CREDENTIAL} WHERE t.token_hash = ?`,
  credentialOwner: `SELECT o.* ${SCOPED_TO_PROJECT} ${CREDENTIAL} JOIN users o ON o.id = c.owner_user_id WHERE t.token_hash = ? AND (g.user_id IS NULL OR o.id <> g.user_id)`,
});

/** The fields in result order. */
export const ACCESS_RECORDS_FIELDS: readonly (keyof AccessRecords)[] = Object.freeze([
  'token',
  'project',
  'grant',
  'user',
  'credential',
  'credentialOwner',
] as const);

/** Bound parameters of each `ACCESS_RECORDS_SQL` statement for a query. */
export function accessRecordsParams(
  field: keyof AccessRecords,
  query: AccessRecordsQuery,
): readonly (string | null)[] {
  const { tokenHash, projectSlug } = query;
  switch (field) {
    case 'token':
    case 'grant':
      return [tokenHash];
    default:
      return [projectSlug, tokenHash];
  }
}
