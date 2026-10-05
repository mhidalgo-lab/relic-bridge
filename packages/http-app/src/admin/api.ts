// SPDX-License-Identifier: Apache-2.0
// The admin REST API (P2-09): `/api/admin/v1/*`, API-first management of users, credentials, projects, grants, access
// tokens and the audit log. Web-standard only (ADR-0004); mounted by `createHttpApp` when an admin token is set.
//
// Security rules (THREAT_MODEL T8/T13/T14/T23):
// - the bootstrap admin token (`Authorization: Bearer`, counts as `owner`) or an admin session cookie (P4-02). A
//   request with an `Authorization` header is judged by it alone and its cookies are ignored, so a browser can never
//   lend its session to a bearer request; never query-string credentials. One uniform 401, failures throttled and
//   audited through the same hooks as the MCP routes;
// - cookie sessions: `Sec-Fetch-Site` must be same-origin (or `none` for reads), unsafe methods need `Origin` =
//   `RB_PUBLIC_URL` and the session's CSRF token in `X-CSRF-Token`, and every route checks the user's role (`403`);
// - New Relic keys are accepted in request bodies only and never returned: credentials come back as masked metadata;
//   token hashes are never returned and a new token's plaintext appears once, in the create response;
// - every change is written to the audit log and clears the in-process access cache.
import { createRoute, OpenAPIHono, type RouteConfig, type z } from '@hono/zod-openapi';
import {
  type CreateGrantInput,
  type CreateProjectInput,
  createCredential,
  createGrant,
  createProject,
  createSetupLink,
  issueAccessToken,
  type Keyring,
  type KeyValidator,
  revalidateCredential,
  revokeAccessToken,
  revokeUserSessions,
  rotateCredentialKey,
  rotateCredentialKeysBatch,
  type toTokenSummary,
  type UpdateProjectInput,
  updateProject,
} from '@relic-bridge/auth';
import { type Clock, type Logger, redact, Secret } from '@relic-bridge/core';
import {
  type AccessTokenRecord,
  type AuditQuery,
  type AuditRecord,
  ConflictError,
  type CredentialRecord,
  type GrantRecord,
  type KvRepository,
  newId,
  normalizeEmail,
  type ProjectRecord,
  type Storage,
  type UserPatch,
  type UserRecord,
} from '@relic-bridge/storage';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { AdminAuditEvent } from '../audit.ts';
import {
  type AdminPrincipal,
  CSRF_HEADER,
  isUnsafeMethod,
  ROLE_RANK,
  type SessionManager,
} from '../session.ts';
import {
  ADMIN_RETRY_AFTER_SECONDS,
  AdminApiError,
  adminErrorBody,
  adminErrorResponse,
  toAdminApiError,
} from './errors.ts';
import * as S from './schemas.ts';
import { type AdminTokenVerifier, adminBearer } from './token.ts';

export const ADMIN_API_BASE: '/api/admin/v1' = '/api/admin/v1';
/** Largest admin request body (a project with 1000 accounts and every limit is a few KiB). */
export const DEFAULT_ADMIN_MAX_BODY_BYTES: number = 64 * 1024;
const DEFAULT_PAGE = 50;
const ADMIN_REALM = 'Bearer realm="relic-bridge-admin"';
/** Recorded (`details.via`) for changes made with the bootstrap admin token. */
export const ADMIN_TOKEN_ACTOR: 'admin_token' = 'admin_token';
/** Recorded (`details.via`) for changes made in an admin session (the row's `userId` names the user). */
export const SESSION_ACTOR: 'session' = 'session';

export type StorageForAdmin = Pick<
  Storage,
  'users' | 'credentials' | 'projects' | 'grants' | 'accessTokens' | 'auditLog' | 'settings'
>;

type Vars = {
  requestId: string;
  started: number;
  log: Record<string, unknown>;
  principal?: AdminPrincipal;
};
export type AdminEnv = { Variables: Vars };

/** What `createHttpApp` hands the admin API (everything request-scoped stays in the handler). */
export interface AdminApiDeps {
  readonly storage: StorageForAdmin;
  readonly keyring: Keyring;
  /** The bootstrap admin token; absent when only sessions are configured. */
  readonly verifier?: AdminTokenVerifier;
  /** Admin sessions (P4-02); absent when sign-in is not configured. */
  readonly sessions?: SessionManager;
  /**
   * Where sessions live when `sessions` is absent (the CLI on the database): a role change or disable made here still
   * ends the user's sessions.
   */
  readonly sessionKv?: Pick<KvRepository, 'get' | 'put' | 'delete' | 'list' | 'deletePrefix'>;
  readonly validateKey: KeyValidator;
  readonly catalog: readonly string[];
  readonly clock: Clock;
  readonly logger: Logger;
  readonly maxBodyBytes: number;
  /** Ceiling for `keys/rotate` `batchSize`; a larger request is clamped to it (the caller loops on `nextCursor`). */
  readonly maxRotationBatch?: number;
  /** Records an admin change; never rejects. */
  readonly audit?: (event: AdminAuditEvent) => Promise<void>;
  /** Pre-authentication hook (rate limits). A returned Response stops the request. */
  readonly beforeAuth?: (
    c: Context,
    requestId: string,
  ) => Promise<Response | undefined> | Response | undefined;
  readonly onAuthFailure?: (c: Context, reason: string) => void;
  /** After a failed admin authentication: a returned Response (429) replaces the 401 (P3-13). */
  readonly refuseAuthFailure?: (
    c: Context,
    reason: string,
  ) => Promise<Response | undefined> | Response | undefined;
  readonly onRejected?: (c: Context, status: number) => void;
  /** Background work (`waitUntil` on Workers). */
  readonly runInBackground: (c: Context, task: Promise<unknown>, what: string) => void;
  /** After every successful change (clears the access cache and the session user cache). */
  readonly onChange?: () => void;
  /** First-owner setup links (P4-01); absent when sign-in is not configured. */
  readonly setupLinks?: {
    readonly publicUrl: string;
    readonly kv: Pick<KvRepository, 'get' | 'put' | 'take'>;
    readonly providers: readonly { readonly id: string; readonly kind: 'redirect' | 'header' }[];
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Views: what leaves the API. Built field by field so nothing is returned by accident (key material, hashes).
// ---------------------------------------------------------------------------------------------------------------

function userView(u: UserRecord): z.infer<typeof S.UserSchema> {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    idp: u.idp,
    role: u.role,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    disabledAt: u.disabledAt,
  };
}

function credentialView(r: CredentialRecord): z.infer<typeof S.CredentialSchema> {
  return {
    id: r.id,
    label: r.label,
    region: r.region,
    ownerUserId: r.ownerUserId,
    keyHint: r.keyHint,
    keyStorage: r.key.kind,
    keyVersion: r.key.kind === 'encrypted' ? r.key.keyVersion : null,
    validationStatus: r.validationStatus,
    validationErrorCode: r.validationErrorCode,
    validatedAt: r.validatedAt,
    nrUserId: r.nrUserId,
    nrUserEmail: r.nrUserEmail,
    reachableAccountIds: r.reachableAccountIds === null ? null : [...r.reachableAccountIds],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    revokedAt: r.revokedAt,
  };
}

type LimitsView = z.infer<typeof S.ProjectSchema>['limits'];

function limitsView(l: ProjectRecord['limits']): LimitsView {
  return JSON.parse(JSON.stringify(l)) as LimitsView;
}

function projectView(p: ProjectRecord): z.infer<typeof S.ProjectSchema> {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    defaultAccountId: p.defaultAccountId,
    allowedAccountIds: [...p.allowedAccountIds],
    enabledTools: p.enabledTools === null ? null : [...p.enabledTools],
    limits: limitsView(p.limits),
    defaultCredentialId: p.defaultCredentialId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    disabledAt: p.disabledAt,
  };
}

function grantView(g: GrantRecord): z.infer<typeof S.GrantSchema> {
  return {
    id: g.id,
    projectId: g.projectId,
    userId: g.userId,
    label: g.label,
    credentialId: g.credentialId,
    tools: g.tools === null ? null : [...g.tools],
    accountIds: g.accountIds === null ? null : [...g.accountIds],
    limits: limitsView(g.limits),
    rateLimit:
      g.rateLimit === null ? null : { requests: g.rateLimit.requests, perSeconds: g.rateLimit.perSeconds },
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    expiresAt: g.expiresAt,
    revokedAt: g.revokedAt,
  };
}

function tokenView(t: AccessTokenRecord | ReturnType<typeof toTokenSummary>): z.infer<typeof S.TokenSchema> {
  return {
    id: t.id,
    grantId: t.grantId,
    prefix: t.prefix,
    label: t.label,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
    revokedAt: t.revokedAt,
  };
}

function auditView(r: AuditRecord): z.infer<typeof S.AuditSchema> {
  return {
    id: r.id,
    ts: r.ts,
    kind: r.kind,
    action: r.action,
    status: r.status,
    requestId: r.requestId,
    userId: r.userId,
    grantId: r.grantId,
    tokenId: r.tokenId,
    clientId: r.clientId,
    keyId: r.keyId,
    projectId: r.projectId,
    accountIds: r.accountIds === null ? null : [...r.accountIds],
    nrql: r.nrql,
    durationMs: r.durationMs,
    inspectedCount: r.inspectedCount,
    errorCode: r.errorCode,
    targetType: r.targetType,
    targetId: r.targetId,
    details: r.details === null ? null : (JSON.parse(JSON.stringify(r.details)) as Record<string, unknown>),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Pagination: stable order (createdAt, id); the cursor is opaque (base64url of the last item's position).
// ---------------------------------------------------------------------------------------------------------------

function b64urlEncode(text: string): string {
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function b64urlDecode(text: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(text)) return null;
  try {
    return atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  } catch {
    return null;
  }
}

const cleanId = (id: string | null | undefined): string | null =>
  id === undefined || id === null ? null : redact(id).slice(0, 64);

const badCursor = (): AdminApiError =>
  new AdminApiError('invalid_request', 'cursor is not a cursor from this list', { field: 'cursor' });

export function paginate<T extends { readonly id: string; readonly createdAt: number }>(
  items: readonly T[],
  limit: number | undefined,
  cursor: string | undefined,
): { readonly page: T[]; readonly nextCursor: string | null } {
  const size = limit ?? DEFAULT_PAGE;
  const sorted = [...items].sort((a, b) =>
    a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  let start = 0;
  if (cursor !== undefined) {
    const m = /^c:(\d{1,16}):(.{1,64})$/.exec(b64urlDecode(cursor) ?? '');
    if (m === null) throw badCursor();
    const at = Number(m[1]);
    const id = m[2] as string;
    start = sorted.findIndex((x) => x.createdAt > at || (x.createdAt === at && x.id > id));
    if (start === -1) start = sorted.length;
  }
  const page = sorted.slice(start, start + size);
  const last = page.at(-1);
  const more = start + size < sorted.length;
  return { page, nextCursor: more && last ? b64urlEncode(`c:${last.createdAt}:${last.id}`) : null };
}

type Compact<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Drop absent fields (`exactOptionalPropertyTypes`: an absent field and `undefined` differ). */
function compact<T extends object>(value: T): Compact<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Compact<T>;
}

function parseTime(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = /^\d{1,15}$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isSafeInteger(ms)) {
    throw new AdminApiError('invalid_request', `${field} must be epoch ms or an ISO 8601 date-time`, {
      field,
    });
  }
  return ms;
}

// ---------------------------------------------------------------------------------------------------------------
// OpenAPI route helpers
// ---------------------------------------------------------------------------------------------------------------

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});

const ERROR_DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: 'Invalid request (`invalid_request`): unknown field, wrong type, rule broken',
  401: 'Missing or wrong admin token, or no live session (`unauthorized`)',
  403: 'Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`)',
  404: 'No such resource (`not_found`)',
  409: 'Conflicts with existing data (`conflict`, `read_only`)',
  413: 'Body too large (`payload_too_large`)',
  415: 'Body is not JSON (`unsupported_media_type`)',
  422: 'Refused by a rule (`not_permitted`) or New Relic refused the key (`key_rejected`)',
  429: 'Too many requests or failed attempts (`rate_limited`)',
  502: 'New Relic could not be asked (`upstream_unavailable`)',
  503: 'Storage or encryption unavailable (`unavailable`)',
};

function errors(...codes: number[]) {
  const all = [400, 401, 403, 429, 503, ...codes];
  return Object.fromEntries(
    all.map((code) => [code, json(S.ErrorSchema, ERROR_DESCRIPTIONS[code] ?? 'Error')]),
  ) as Record<number, ReturnType<typeof json<typeof S.ErrorSchema>>>;
}

const BODY = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } }, required: true },
});

/** Either the admin token, or the session cookie with the CSRF header (unsafe methods). */
const SECURITY = [{ adminToken: [] }, { sessionCookie: [], csrfToken: [] }];

function route<const R extends RouteConfig>(config: R): R {
  return createRoute({ ...config, security: SECURITY }) as R;
}

// ---------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------

const routes = {
  listUsers: route({
    method: 'get',
    path: '/users',
    tags: ['users'],
    summary: 'List users',
    request: { query: S.PageQuery },
    responses: { 200: json(S.UserPage, 'Users'), ...errors() },
  }),
  createUser: route({
    method: 'post',
    path: '/users',
    tags: ['users'],
    summary: 'Create a user',
    description:
      'Users own personal credentials and receive user grants. Login identities arrive in Phase 4.',
    request: BODY(S.CreateUserBody),
    responses: { 201: json(S.UserOne, 'Created'), ...errors(409, 413, 415) },
  }),
  getUser: route({
    method: 'get',
    path: '/users/{id}',
    tags: ['users'],
    summary: 'Get a user',
    request: { params: S.IdParam },
    responses: { 200: json(S.UserOne, 'The user'), ...errors(404) },
  }),
  updateUser: route({
    method: 'patch',
    path: '/users/{id}',
    tags: ['users'],
    summary: 'Update or disable a user',
    description:
      'Demoting or disabling the last enabled owner is refused with `409 conflict`, `detail: last_owner` (P4-16).',
    request: { params: S.IdParam, ...BODY(S.UpdateUserBody) },
    responses: { 200: json(S.UserOne, 'Updated'), ...errors(404, 409, 413, 415) },
  }),

  unbindUser: route({
    method: 'post',
    path: '/users/{id}/unbind',
    tags: ['users'],
    summary: "Clear a user's sign-in identity so they can sign in with another provider",
    description:
      'Owners only (the admin token counts as owner). Clears the provider and subject the user is bound to and signs ' +
      'them out everywhere. The next verified sign-in whose email matches binds the user again, to whichever provider ' +
      'it came from, so anyone who controls that email at a configured provider can take the account: confirm the ' +
      "move with the user first. `confirm` must repeat the user's email address. Audited as `user.unbind`.",
    request: { params: S.IdParam, ...BODY(S.UnbindUserBody) },
    responses: { 200: json(S.UserOne, 'Unbound'), ...errors(404, 409, 413, 415) },
  }),

  revokeUserSessions: route({
    method: 'post',
    path: '/users/{id}/sessions/revoke',
    tags: ['sessions'],
    summary: 'Sign a user out everywhere',
    description:
      'Ends every admin session of the user at once (all devices). Members may do this for themselves only; admins ' +
      'for anyone but an owner. A role change or disabling a user does this automatically.',
    request: { params: S.IdParam },
    responses: { 200: json(S.SessionsRevokedOne, 'Sessions ended'), ...errors(404) },
  }),

  getSession: route({
    method: 'get',
    path: '/session',
    tags: ['sessions'],
    summary: 'Who is calling: role, user and the CSRF token',
    description:
      'Any role. With a session cookie it returns the CSRF token to send as `X-CSRF-Token` on changes. Sign out with ' +
      '`POST /auth/logout` (form field `_csrf`, `everywhere=1` for every device).',
    responses: { 200: json(S.SessionOne, 'The caller'), ...errors() },
  }),

  listCredentials: route({
    method: 'get',
    path: '/credentials',
    tags: ['credentials'],
    summary: 'List credentials (masked)',
    request: { query: S.CredentialQuery },
    responses: { 200: json(S.CredentialPage, 'Credentials, without key material'), ...errors() },
  }),
  createCredential: route({
    method: 'post',
    path: '/credentials',
    tags: ['credentials'],
    summary: 'Add a New Relic User key',
    description:
      'Validates the key against NerdGraph (`actor.user`, `actor.accounts`) and stores it encrypted. A key New Relic ' +
      'refuses is not stored. The key is never returned.',
    request: BODY(S.CreateCredentialBody),
    responses: { 201: json(S.CredentialOne, 'Created (masked)'), ...errors(404, 409, 413, 415, 422, 502) },
  }),
  getCredential: route({
    method: 'get',
    path: '/credentials/{id}',
    tags: ['credentials'],
    summary: 'Get a credential (masked)',
    request: { params: S.IdParam },
    responses: { 200: json(S.CredentialOne, 'The credential, without key material'), ...errors(404) },
  }),
  updateCredential: route({
    method: 'patch',
    path: '/credentials/{id}',
    tags: ['credentials'],
    summary: 'Rename a credential',
    request: { params: S.IdParam, ...BODY(S.UpdateCredentialBody) },
    responses: { 200: json(S.CredentialOne, 'Updated'), ...errors(404, 409, 413, 415) },
  }),
  deleteCredential: route({
    method: 'delete',
    path: '/credentials/{id}',
    tags: ['credentials'],
    summary: 'Delete a credential',
    description: 'Refused (`409`) while a project or grant uses it.',
    request: { params: S.IdParam },
    responses: { 204: { description: 'Deleted' }, ...errors(404, 409) },
  }),
  rotateCredential: route({
    method: 'post',
    path: '/credentials/{id}/rotate',
    tags: ['credentials'],
    summary: 'Replace the key',
    description:
      'Validates the new key, re-encrypts it under the current master key and swaps it in (compare-and-swap). ' +
      'Warns `nr_user_changed` when the new key belongs to another New Relic user.',
    request: { params: S.IdParam, ...BODY(S.RotateCredentialBody) },
    responses: { 200: json(S.CredentialOne, 'Rotated (masked)'), ...errors(404, 409, 413, 415, 422, 502) },
  }),
  revalidateCredential: route({
    method: 'post',
    path: '/credentials/{id}/revalidate',
    tags: ['credentials'],
    summary: 'Re-check the key against New Relic',
    description:
      'A refused key is marked `invalid` (every grant using it fails closed); a valid key gets its reachable accounts ' +
      'refreshed; network trouble changes nothing (`outcome: error`).',
    request: { params: S.IdParam },
    responses: { 200: json(S.RevalidationOne, 'Outcome'), ...errors(404) },
  }),

  listProjects: route({
    method: 'get',
    path: '/projects',
    tags: ['projects'],
    summary: 'List projects',
    request: { query: S.ProjectQuery },
    responses: { 200: json(S.ProjectPage, 'Projects'), ...errors() },
  }),
  createProject: route({
    method: 'post',
    path: '/projects',
    tags: ['projects'],
    summary: 'Create a project',
    request: BODY(S.CreateProjectBody),
    responses: { 201: json(S.ProjectOne, 'Created'), ...errors(404, 409, 413, 415) },
  }),
  getProject: route({
    method: 'get',
    path: '/projects/{id}',
    tags: ['projects'],
    summary: 'Get a project',
    request: { params: S.IdParam },
    responses: { 200: json(S.ProjectOne, 'The project'), ...errors(404) },
  }),
  updateProject: route({
    method: 'patch',
    path: '/projects/{id}',
    tags: ['projects'],
    summary: 'Update, disable or enable a project',
    description: 'Narrowing a project narrows every grant on it at once (access is the intersection).',
    request: { params: S.IdParam, ...BODY(S.UpdateProjectBody) },
    responses: { 200: json(S.ProjectOne, 'Updated'), ...errors(404, 409, 413, 415) },
  }),
  deleteProject: route({
    method: 'delete',
    path: '/projects/{id}',
    tags: ['projects'],
    summary: 'Delete a project with its grants and tokens',
    request: { params: S.IdParam },
    responses: { 204: { description: 'Deleted' }, ...errors(404) },
  }),

  listGrants: route({
    method: 'get',
    path: '/grants',
    tags: ['grants'],
    summary: 'List grants',
    request: { query: S.GrantQuery },
    responses: { 200: json(S.GrantPage, 'Grants'), ...errors() },
  }),
  createGrant: route({
    method: 'post',
    path: '/grants',
    tags: ['grants'],
    summary: 'Create a grant',
    description:
      'A grant may use the project default credential, a shared one, or its own user’s. Parts the project does not ' +
      'allow are stored but have no effect (listed in `warnings`).',
    request: BODY(S.CreateGrantBody),
    responses: { 201: json(S.GrantOne, 'Created'), ...errors(404, 409, 413, 415, 422) },
  }),
  getGrant: route({
    method: 'get',
    path: '/grants/{id}',
    tags: ['grants'],
    summary: 'Get a grant',
    request: { params: S.IdParam },
    responses: { 200: json(S.GrantOne, 'The grant'), ...errors(404) },
  }),
  revokeGrant: route({
    method: 'post',
    path: '/grants/{id}/revoke',
    tags: ['grants'],
    summary: 'Revoke a grant (all its tokens stop working)',
    request: { params: S.IdParam },
    responses: { 200: json(S.GrantOne, 'Revoked'), ...errors(404) },
  }),
  deleteGrant: route({
    method: 'delete',
    path: '/grants/{id}',
    tags: ['grants'],
    summary: 'Delete a grant with its tokens',
    request: { params: S.IdParam },
    responses: { 204: { description: 'Deleted' }, ...errors(404) },
  }),

  listTokens: route({
    method: 'get',
    path: '/tokens',
    tags: ['tokens'],
    summary: 'List access tokens',
    request: { query: S.TokenQuery },
    responses: { 200: json(S.TokenPage, 'Tokens, without hashes'), ...errors() },
  }),
  createToken: route({
    method: 'post',
    path: '/tokens',
    tags: ['tokens'],
    summary: 'Issue a device token',
    description: 'The response carries the token once. Only its hash is stored; it cannot be shown again.',
    request: BODY(S.CreateTokenBody),
    responses: { 201: json(S.TokenCreated, 'Issued'), ...errors(404, 409, 413, 415) },
  }),
  getToken: route({
    method: 'get',
    path: '/tokens/{id}',
    tags: ['tokens'],
    summary: 'Get an access token',
    request: { params: S.IdParam },
    responses: { 200: json(S.TokenOne, 'The token, without its hash'), ...errors(404) },
  }),
  revokeToken: route({
    method: 'post',
    path: '/tokens/{id}/revoke',
    tags: ['tokens'],
    summary: 'Revoke an access token',
    request: { params: S.IdParam },
    responses: { 200: json(S.TokenOne, 'Revoked'), ...errors(404) },
  }),

  rotateKeys: route({
    method: 'post',
    path: '/keys/rotate',
    tags: ['keys'],
    summary: 'Re-encrypt stored keys under the current master key (one batch)',
    description:
      'Master-key rotation for hosts without local database access (a Worker on D1). Start the server with the new ' +
      'key as `RB_MASTER_KEY` and the old one as `RB_MASTER_KEY_PREVIOUS`, then call this until `nextCursor` is ' +
      '`null` (`relic-bridge keys rotate --remote` does). Each row is re-encrypted with a compare-and-swap, so every ' +
      'row stays readable, an interrupted run resumes, and a repeated run changes nothing. A wrong or retired master ' +
      'key answers `503 unavailable` (`detail`: `key_mismatch`, `key_version_retired`) before any row is touched. ' +
      'The previous key can be removed once `pending` is 0. A server may cap `batchSize` (Free-plan Workers: 40). ' +
      'Never returns key material.',
    request: BODY(S.RotateKeysBody),
    responses: { 200: json(S.KeyRotationOne, 'What this batch did'), ...errors(413, 415) },
  }),

  createSetupLink: route({
    method: 'post',
    path: '/setup-links',
    tags: ['identity'],
    summary: 'Issue a single-use owner setup link',
    description:
      'First-owner bootstrap (P4-01): the identity that signs in through this link becomes `owner` (the sign-in ' +
      'allowlist does not apply; email verification and identity conflicts still do). Single use; expires after ' +
      '`ttlMinutes` (default 60). The link is shown once, only its hash is stored. Needs sign-in to be configured ' +
      '(`RB_PUBLIC_URL` and an identity provider), else `422 not_permitted`.',
    request: BODY(S.CreateSetupLinkBody),
    responses: { 201: json(S.SetupLinkOne, 'Issued'), ...errors(413, 415, 422) },
  }),

  // ---- Member self-service (P4-10): the caller's own rows; any signed-in role (the admin token has no "own").
  myCredentials: route({
    method: 'get',
    path: '/me/credentials',
    tags: ['me'],
    summary: 'List my New Relic keys (masked)',
    description: 'Only keys owned by the signed-in user. Needs a session (the admin token owns nothing).',
    request: { query: S.MyCredentialQuery },
    responses: { 200: json(S.CredentialPage, 'Your keys, without key material'), ...errors() },
  }),
  addMyCredential: route({
    method: 'post',
    path: '/me/credentials',
    tags: ['me'],
    summary: 'Add my own New Relic User key',
    description:
      'Validates the key and stores it encrypted, owned by you (it cannot be shared or given to someone else). ' +
      'At most 10 per user. The key is never returned.',
    request: BODY(S.CreateMyCredentialBody),
    responses: { 201: json(S.CredentialOne, 'Created (masked)'), ...errors(409, 413, 415, 422, 502) },
  }),
  renameMyCredential: route({
    method: 'patch',
    path: '/me/credentials/{id}',
    tags: ['me'],
    summary: 'Rename my key',
    request: { params: S.IdParam, ...BODY(S.UpdateCredentialBody) },
    responses: { 200: json(S.CredentialOne, 'Updated'), ...errors(404, 413, 415) },
  }),
  deleteMyCredential: route({
    method: 'delete',
    path: '/me/credentials/{id}',
    tags: ['me'],
    summary: 'Delete my key',
    description: 'Refused (`409`) while one of your grants uses it: point the grant elsewhere first.',
    request: { params: S.IdParam },
    responses: { 204: { description: 'Deleted' }, ...errors(404, 409) },
  }),
  rotateMyCredential: route({
    method: 'post',
    path: '/me/credentials/{id}/rotate',
    tags: ['me'],
    summary: 'Replace my key',
    request: { params: S.IdParam, ...BODY(S.RotateCredentialBody) },
    responses: { 200: json(S.CredentialOne, 'Rotated (masked)'), ...errors(404, 409, 413, 415, 422, 502) },
  }),
  revalidateMyCredential: route({
    method: 'post',
    path: '/me/credentials/{id}/revalidate',
    tags: ['me'],
    summary: 'Re-check my key against New Relic',
    request: { params: S.IdParam },
    responses: { 200: json(S.RevalidationOne, 'Outcome'), ...errors(404) },
  }),
  myGrants: route({
    method: 'get',
    path: '/me/grants',
    tags: ['me'],
    summary: 'List my grants',
    description: 'Grants assigned to you (an administrator creates them), with the project to connect to.',
    request: { query: S.PageQuery },
    responses: { 200: json(S.MyGrantPage, 'Your grants'), ...errors() },
  }),
  setMyGrantCredential: route({
    method: 'patch',
    path: '/me/grants/{id}',
    tags: ['me'],
    summary: 'Use one of my keys for my grant',
    description:
      'Points one of your live grants at one of your own keys, or back at the project default (`null`). The key must be ' +
      "yours and valid; the grant's scope (tools, accounts, limits) does not change.",
    request: { params: S.IdParam, ...BODY(S.SetMyGrantCredentialBody) },
    responses: { 200: json(S.MyGrantOne, 'Updated'), ...errors(404, 409, 413, 415, 422) },
  }),
  myTokens: route({
    method: 'get',
    path: '/me/tokens',
    tags: ['me'],
    summary: 'List the device tokens of my grants',
    request: { query: S.TokenQuery },
    responses: { 200: json(S.TokenPage, 'Token metadata, never the token'), ...errors(404) },
  }),
  createMyToken: route({
    method: 'post',
    path: '/me/tokens',
    tags: ['me'],
    summary: 'Issue a device token for one of my grants',
    description: 'Shown once. At most 20 live tokens per grant.',
    request: BODY(S.CreateTokenBody),
    responses: {
      201: json(S.TokenCreated, 'Created; the token is in the body, once'),
      ...errors(404, 409, 413, 415),
    },
  }),
  revokeMyToken: route({
    method: 'post',
    path: '/me/tokens/{id}/revoke',
    tags: ['me'],
    summary: 'Revoke one of my device tokens',
    request: { params: S.IdParam },
    responses: { 200: json(S.TokenOne, 'Revoked'), ...errors(404) },
  }),

  listAudit: route({
    method: 'get',
    path: '/audit',
    tags: ['audit'],
    summary: 'Query the audit log (newest first)',
    description:
      'Admins and owners read every row. A member (session) reads only rows whose `userId` is their own: the filter ' +
      'is forced, and asking for another `userId` is `403`.',
    request: { query: S.AuditQuerySchema },
    responses: { 200: json(S.AuditPage, 'Audit rows'), ...errors() },
  }),

  auditStats: route({
    method: 'get',
    path: '/audit/stats',
    tags: ['audit'],
    summary: 'Tool-call statistics over a time window',
    description:
      'One bounded aggregate over `tool_call` rows in `[since, until)` (at most 90 days, default the last 7): calls, ' +
      'errors, denied, durations and inspected events per tool, project, grant, device token or day. Admins and owners only.',
    request: { query: S.AuditStatsQuerySchema },
    responses: { 200: json(S.AuditStatsResponse, 'Statistics'), ...errors() },
  }),
};

/** Actions that take no request body (`POST …/revoke`, `POST …/revalidate`). */
const BODYLESS_ACTION = /\/(?:revoke|revalidate)\/?$/;

/** Mutating routes whose schema-refused requests are audited: [method, path under the base, action, target type]. */
const REFUSAL_ROUTES: readonly (readonly [string, RegExp, string, string])[] = [
  ['POST', /^\/users$/, 'user.create', 'user'],
  ['PATCH', /^\/users\/([^/]+)$/, 'user.update', 'user'],
  ['POST', /^\/users\/([^/]+)\/unbind$/, 'user.unbind', 'user'],
  ['POST', /^\/credentials$/, 'credential.create', 'credential'],
  ['PATCH', /^\/credentials\/([^/]+)$/, 'credential.update', 'credential'],
  ['POST', /^\/credentials\/([^/]+)\/rotate$/, 'credential.rotate', 'credential'],
  ['POST', /^\/me\/credentials$/, 'credential.create', 'credential'],
  ['PATCH', /^\/me\/credentials\/([^/]+)$/, 'credential.update', 'credential'],
  ['POST', /^\/me\/credentials\/([^/]+)\/rotate$/, 'credential.rotate', 'credential'],
  ['PATCH', /^\/me\/grants\/([^/]+)$/, 'grant.set_credential', 'grant'],
  ['POST', /^\/me\/tokens$/, 'token.create', 'token'],
  ['POST', /^\/projects$/, 'project.create', 'project'],
  ['PATCH', /^\/projects\/([^/]+)$/, 'project.update', 'project'],
  ['POST', /^\/grants$/, 'grant.create', 'grant'],
  ['POST', /^\/tokens$/, 'token.create', 'token'],
  ['POST', /^\/keys\/rotate$/, 'keys.rotate', 'master_key'],
  ['POST', /^\/setup-links$/, 'setup_link.create', 'setup_link'],
];

function validationError(error: z.ZodError): AdminApiError {
  const issue = error.issues[0];
  if (issue === undefined) return new AdminApiError('invalid_request', 'invalid request');
  const keys = issue.code === 'unrecognized_keys' ? issue.keys.map((k) => String(k).slice(0, 64)) : [];
  const path = [...issue.path.map(String), ...(keys.length === 1 ? keys : [])].join('.');
  const message =
    issue.code === 'unrecognized_keys'
      ? `unknown field${keys.length === 1 ? '' : 's'}: ${keys.join(', ')}`
      : `${path === '' ? 'request' : path}: ${issue.message}`;
  return new AdminApiError('invalid_request', message, path === '' ? {} : { field: path });
}

/** A hook's refusal in the admin API's error shape: a 429 becomes `rate_limited` with its `Retry-After`. */
function asAdminRefusal(stop: Response): Response {
  if (stop.status !== 429) return stop;
  const retry = stop.headers.get('retry-after');
  return adminErrorResponse(
    new AdminApiError('rate_limited', 'too many requests; retry later'),
    retry === null ? {} : { 'Retry-After': retry },
  );
}

/** The path under {@link ADMIN_API_BASE} (`/users/usr_1`). */
function relPath(c: Context): string {
  const at = c.req.path.indexOf(ADMIN_API_BASE);
  return at === -1 ? c.req.path : c.req.path.slice(at + ADMIN_API_BASE.length);
}

const viaOf = (principal: AdminPrincipal | undefined): string =>
  principal?.kind === 'session' ? SESSION_ACTOR : ADMIN_TOKEN_ACTOR;

/** Bounds for self-service (a member cannot fill storage or fan out New Relic validations). */
const MAX_OWN_CREDENTIALS = 10;
const MAX_LIVE_TOKENS_PER_GRANT = 20;

const SELF_SESSIONS = /^\/users\/[^/]+\/sessions\/revoke$/;
const UNBIND = /^\/users\/[^/]+\/unbind$/;

/**
 * The least role a cookie session needs for a route (P4-02). Owner-only: master-key rotation and owner setup links.
 * Any role: `GET /session`, `GET /audit` (the handler limits members to their own rows) and revoking sessions (the
 * handler limits members to themselves). Everything else, unknown
 * paths included: `admin`.
 */
export function requiredRole(method: string, rel: string): 'owner' | 'admin' | 'member' {
  if (method === 'GET' && (rel === '/session' || rel === '/audit')) return 'member';
  if (method === 'POST' && SELF_SESSIONS.test(rel)) return 'member';
  // Self-service (P4-10): every handler works on the caller's own rows only (and refuses the admin token).
  if (rel === '/me' || rel.startsWith('/me/')) return 'member';
  if (method === 'POST' && (rel === '/keys/rotate' || rel === '/setup-links' || UNBIND.test(rel)))
    return 'owner';
  return 'admin';
}

const FORBIDDEN_MESSAGES: Readonly<Record<string, string>> = {
  role: 'your role does not allow this',
  csrf: 'missing or invalid CSRF token: send the token from GET /session as X-CSRF-Token',
  cross_site: 'cross-site request refused',
  origin_mismatch: 'cross-origin request refused',
  origin_missing: 'request origin unknown: send the Origin header',
  self: 'you cannot change your own role or disable yourself; ask another owner',
  no_user: 'this route is for signed-in users: the admin token has no keys, grants or tokens of its own',
  owner:
    "only an owner can create, change or sign out an owner, or act on an owner's keys, grants and tokens",
};

/** Build the admin sub-app (mounted at {@link ADMIN_API_BASE}). */
export function createAdminApi(deps: AdminApiDeps): OpenAPIHono<AdminEnv> {
  const { storage, clock, logger, catalog } = deps;
  /** The acting user (sessions) for audit rows; the admin token names nobody. */
  const actor = (c: Context) => {
    const principal = c.get('principal') as AdminPrincipal | undefined;
    return {
      requestId: c.get('requestId') as string,
      ...(principal?.kind === 'session' ? { userId: principal.user.id } : {}),
    };
  };
  /**
   * Audit a request refused before its handler ran (schema validation, malformed JSON) on a mutating route, so every
   * refused change leaves a row. Nothing the caller submitted goes into the row except the id in the path (redacted),
   * and the write is capped like other refusal rows.
   */
  const recordRefusal = (c: Context, errorCode: string): void => {
    if (!deps.audit) return;
    const rel = relPath(c);
    for (const [method, pattern, action, targetType] of REFUSAL_ROUTES) {
      if (method !== c.req.method) continue;
      const match = pattern.exec(rel);
      if (match === null) continue;
      deps.runInBackground(
        c,
        deps.audit({
          actor: { requestId: c.get('requestId') as string },
          action,
          targetType,
          targetId: cleanId(match[1] ?? null),
          status: 'error',
          errorCode,
          refusal: true,
          details: { via: viaOf(c.get('principal') as AdminPrincipal | undefined) },
        }),
        'admin_audit',
      );
      return;
    }
  };
  /**
   * Who is calling. A request with an `Authorization` header is judged by the bearer token alone (its cookies are
   * ignored, so a browser's session can't be lent to it); without one, the session cookie (when sessions are on).
   */
  const authenticate = async (
    c: Context,
  ): Promise<{ ok: true; principal: AdminPrincipal } | { ok: false; reason: string }> => {
    const header = c.req.header('authorization');
    if (header === undefined && deps.sessions) {
      const session = await deps.sessions.authenticate(c);
      if (session.ok) return { ok: true, principal: session.principal };
      return { ok: false, reason: session.reason === 'none' ? 'admin_missing_token' : session.reason };
    }
    const presented = adminBearer(header);
    const ok = presented !== null && deps.verifier !== undefined && (await deps.verifier.verify(presented));
    if (ok) return { ok: true, principal: { kind: 'admin_token', role: 'owner' } };
    return {
      ok: false,
      reason:
        header === undefined
          ? 'admin_missing_token'
          : presented === null
            ? 'admin_malformed_header'
            : 'admin_bad_token',
    };
  };

  /** A session refused by CSRF, fetch-metadata, Origin or role checks: one audited `403`, nothing changes. */
  const forbidden = (c: Context, reason: string): Response => {
    const log = c.get('log') as Record<string, unknown>;
    log['deny'] = reason;
    const principal = c.get('principal') as AdminPrincipal | undefined;
    if (deps.audit) {
      deps.runInBackground(
        c,
        deps.audit({
          actor: actor(c),
          action: 'admin.forbidden',
          targetType: 'admin_route',
          targetId: null,
          status: 'denied',
          errorCode: 'forbidden',
          refusal: true,
          details: {
            via: viaOf(principal),
            reason,
            method: c.req.method,
            route: redact(relPath(c)).slice(0, 100),
            ...(principal ? { role: principal.role } : {}),
          },
        }),
        'admin_audit',
      );
    }
    return adminErrorResponse(
      new AdminApiError('forbidden', FORBIDDEN_MESSAGES[reason] ?? 'not allowed', { detail: reason }),
    );
  };

  const api = new OpenAPIHono<AdminEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        recordRefusal(c, 'invalid_request');
        throw validationError(result.error);
      }
    },
  });
  api.openAPIRegistry.registerComponent('securitySchemes', 'adminToken', {
    type: 'http',
    scheme: 'bearer',
    description: 'The bootstrap admin token (`RB_ADMIN_TOKEN`). Counts as `owner`. Not an MCP access token.',
  });
  api.openAPIRegistry.registerComponent('securitySchemes', 'sessionCookie', {
    type: 'apiKey',
    in: 'cookie',
    name: '__Host-rb_session',
    description:
      'Admin session from signing in at `/auth/login` (`rb_session` on http://localhost). Ignored when an ' +
      '`Authorization` header is present. Browser same-origin requests only; role-checked on every route.',
  });
  api.openAPIRegistry.registerComponent('securitySchemes', 'csrfToken', {
    type: 'apiKey',
    in: 'header',
    name: 'X-CSRF-Token',
    description:
      'With the session cookie, on every POST/PATCH/DELETE: the `csrfToken` from `GET /session`, plus an `Origin` ' +
      'header equal to the public URL.',
  });

  // 1. Declared body size, then pre-authentication hooks (per-IP limit, failed-auth throttle), then the token.
  api.use('*', async (c, next) => {
    const requestId = c.get('requestId');
    const log = c.get('log');
    log['admin'] = true;
    const declared = c.req.header('content-length');
    if (declared !== undefined && (!/^\d{1,15}$/.test(declared) || Number(declared) > deps.maxBodyBytes)) {
      log['reject'] = 'body_size';
      return adminErrorResponse(new AdminApiError('payload_too_large', 'request body is too large'));
    }
    if (deps.beforeAuth) {
      const stop = await deps.beforeAuth(c, requestId);
      if (stop) {
        deps.onRejected?.(c, stop.status);
        return asAdminRefusal(stop);
      }
    }
    const authenticated = await authenticate(c);
    if (!authenticated.ok) {
      const reason = authenticated.reason;
      log['deny'] = reason;
      try {
        deps.onAuthFailure?.(c, reason);
      } catch {
        // a failing hook never changes the answer
      }
      // The failure throttle (P3-13) answers 429 for an address over its failure budget. Only failures get here:
      // the valid admin token is never refused by it.
      try {
        const instead = await deps.refuseAuthFailure?.(c, reason);
        if (instead) return asAdminRefusal(instead);
      } catch {
        // as above
      }
      return adminErrorResponse(new AdminApiError('unauthorized', 'admin authentication required'), {
        'WWW-Authenticate': ADMIN_REALM,
      });
    }
    const principal = authenticated.principal;
    c.set('principal', principal);
    log['principal'] = principal.kind;
    if (principal.kind === 'session' && deps.sessions) {
      // CSRF (T13): fetch metadata and Origin first, then the synchronizer token on changes, then the role.
      const unsafe = isUnsafeMethod(c.req.method);
      const problem =
        deps.sessions.checkFetchOrigin(c, unsafe) ??
        (unsafe && !deps.sessions.csrfMatches(principal, c.req.header(CSRF_HEADER)) ? 'csrf' : null);
      if (problem !== null) return forbidden(c, problem);
      if (ROLE_RANK[principal.role] < ROLE_RANK[requiredRole(c.req.method, relPath(c))]) {
        return forbidden(c, 'role');
      }
    }
    // Self-service routes belong to a user; the bootstrap admin token is nobody (audited like any refusal).
    if (principal.kind !== 'session' && /^\/me(?:\/|$)/.test(relPath(c))) return forbidden(c, 'no_user');
    // Bodies: JSON only, bounded while read (a body without Content-Length can't bypass the limit).
    if (c.req.method === 'POST' || c.req.method === 'PATCH' || c.req.method === 'PUT') {
      const type = c.req.header('content-type') ?? '';
      const hasBody = declared !== '0' && (declared !== undefined || c.req.raw.body !== null);
      // Body-less actions take no body at all, so a plain `curl -X POST` (no Content-Type) is fine.
      const bodyless = BODYLESS_ACTION.test(c.req.path);
      if (hasBody && !bodyless && !/^application\/json\s*(;|$)/i.test(type)) {
        return adminErrorResponse(
          new AdminApiError('unsupported_media_type', 'send the body as application/json'),
        );
      }
    }
    await next();
  });
  api.use(
    '*',
    bodyLimit({
      maxSize: deps.maxBodyBytes,
      onError: () => adminErrorResponse(new AdminApiError('payload_too_large', 'request body is too large')),
    }),
  );

  /** Run a change: on success audit `ok` and clear the access cache; on failure audit the error code and rethrow. */
  const change = async <T>(
    c: Context,
    meta: {
      readonly action: string;
      readonly targetType: string;
      readonly targetId?: string | null;
      readonly projectId?: string | null;
      readonly details?: Readonly<Record<string, unknown>>;
    },
    run: () => Promise<T>,
    after?: (result: T) => {
      targetId?: string | null;
      projectId?: string | null;
      details?: Record<string, unknown>;
    },
  ): Promise<T> => {
    const record = (event: Omit<AdminAuditEvent, 'actor' | 'action' | 'targetType'>) => {
      if (!deps.audit) return;
      deps.runInBackground(
        c,
        deps.audit({
          actor: actor(c),
          action: meta.action,
          targetType: meta.targetType,
          ...event,
          // Ids can come straight from the request (a failed change): redact them like any echoed value.
          targetId: cleanId(event.targetId),
          projectId: cleanId(event.projectId),
          details: {
            via: viaOf(c.get('principal') as AdminPrincipal | undefined),
            ...(meta.details ?? {}),
            ...(event.details ?? {}),
          },
        }),
        'admin_audit',
      );
    };
    let result: T;
    try {
      result = await run();
    } catch (error) {
      const mapped = toAdminApiError(error);
      record({
        targetId: meta.targetId ?? null,
        projectId: meta.projectId ?? null,
        status: mapped?.code === 'not_permitted' || mapped?.code === 'forbidden' ? 'denied' : 'error',
        errorCode: mapped?.code ?? 'internal_error',
      });
      throw error;
    }
    const extra = after?.(result) ?? {};
    record({
      targetId: extra.targetId ?? meta.targetId ?? null,
      projectId: extra.projectId ?? meta.projectId ?? null,
      ...(extra.details ? { details: extra.details } : {}),
    });
    deps.onChange?.();
    return result;
  };

  const notFound = (what: string, id: string) =>
    new AdminApiError('not_found', `${what} ${redact(id).slice(0, 64)} not found`, { field: 'id' });

  const must = async <T>(what: string, id: string, get: (id: string) => Promise<T | null>): Promise<T> => {
    const row = await get(id);
    if (row === null) throw notFound(what, id);
    return row;
  };

  const credentialDeps = {
    storage,
    keyring: deps.keyring,
    validate: deps.validateKey,
    clock,
  };

  const revokeAll = (userId: string): Promise<number> =>
    deps.sessions
      ? deps.sessions.revokeUser(userId)
      : deps.sessionKv
        ? revokeUserSessions(deps.sessionKv, userId)
        : Promise.resolve(0);

  /** A refusal inside a handler (audited by `change` as `denied`). */
  const denied = (reason: 'self' | 'owner' | 'role' | 'no_user') =>
    new AdminApiError('forbidden', FORBIDDEN_MESSAGES[reason] ?? 'not allowed', { detail: reason });
  const actsAsOwner = (c: Context) => (c.get('principal') as AdminPrincipal | undefined)?.role === 'owner';

  /**
   * "Only owners touch owners" also covers an owner's keys, grants and tokens (phase 4 review H1): without this, an
   * admin could issue a token on an owner's grant (and query New Relic with the owner's personal key), point an
   * owner's key at another account, plant keys on an owner or delete an owner's grant. `userIds` are the users the
   * change acts for: a grant's user, a credential's owner, or the owner of the key a grant uses.
   */
  const guardOwnerAssets = async (c: Context, userIds: ReadonlyArray<string | null | undefined>) => {
    if (actsAsOwner(c)) return;
    for (const userId of new Set(userIds)) {
      if (userId == null) continue;
      if ((await storage.users.get(userId))?.role === 'owner') throw denied('owner');
    }
  };
  const credentialOwnerId = async (credentialId: string | null | undefined) =>
    credentialId == null ? null : ((await storage.credentials.get(credentialId))?.ownerUserId ?? null);
  /**
   * A grant acts for its user and for the owner of the personal key it names. A project default stays out: an owner
   * who made their own key a project's default shared it with that project (admins cannot make that choice for them:
   * project create and update are guarded).
   */
  const grantUsers = async (grant: { userId: string | null; credentialId: string | null }) => [
    grant.userId,
    await credentialOwnerId(grant.credentialId),
  ];

  /** End every session of a user after a privilege change, audited as its own row. */
  const endSessions = async (c: Context, userId: string, reason: string): Promise<void> => {
    const revoked = await revokeAll(userId);
    if (!deps.audit) return;
    deps.runInBackground(
      c,
      deps.audit({
        actor: actor(c),
        action: 'session.revoke_all',
        targetType: 'user',
        targetId: userId,
        details: { via: viaOf(c.get('principal') as AdminPrincipal | undefined), reason, revoked },
      }),
      'admin_audit',
    );
  };

  // ---------------------------------------------------------------------------------------------------- users
  api.openapi(routes.listUsers, async (c) => {
    const q = c.req.valid('query');
    const { page, nextCursor } = paginate(await storage.users.list(), q.limit, q.cursor);
    return c.json({ data: page.map(userView), nextCursor }, 200);
  });

  api.openapi(routes.createUser, async (c) => {
    const body = c.req.valid('json');
    const user = await change(
      c,
      { action: 'user.create', targetType: 'user', details: { role: body.role ?? 'member' } },
      async () => {
        if (body.role === 'owner' && !actsAsOwner(c)) throw denied('owner');
        return storage.users.create({
          id: newId('usr'),
          email: normalizeEmail(body.email),
          displayName: body.displayName ?? null,
          role: body.role ?? 'member',
        });
      },
      (u) => ({ targetId: u.id }),
    );
    return c.json({ data: userView(user) }, 201);
  });

  api.openapi(routes.getUser, async (c) => {
    const { id } = c.req.valid('param');
    return c.json({ data: userView(await must('user', id, (x) => storage.users.get(x))) }, 200);
  });

  api.openapi(routes.updateUser, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const user = await change(
      c,
      { action: 'user.update', targetType: 'user', targetId: id, details: { fields: Object.keys(body) } },
      async () => {
        const existing = await must('user', id, (x) => storage.users.get(x));
        const principal = c.get('principal') as AdminPrincipal | undefined;
        const privileged = body.role !== undefined || body.disabled !== undefined;
        // Through a session nobody changes their own role or disables themselves (no self-lockout, no self-promotion);
        // only owners touch owners or make one.
        if (principal?.kind === 'session' && principal.user.id === existing.id && privileged)
          throw denied('self');
        if ((existing.role === 'owner' || body.role === 'owner') && !actsAsOwner(c)) throw denied('owner');
        const patch: { -readonly [K in keyof UserPatch]: UserPatch[K] } = {};
        if (body.displayName !== undefined) patch.displayName = body.displayName;
        if (body.role !== undefined) patch.role = body.role;
        if (body.disabled !== undefined)
          patch.disabledAt = body.disabled ? (existing.disabledAt ?? clock.now()) : null;
        const updated =
          Object.keys(patch).length === 0 ? existing : await storage.users.update(existing.id, patch);
        // A privilege change ends the user's sessions (they sign in again with a fresh session); disabling too, and
        // re-enabling (P4-07): a session that outlived a disable made outside the API must not come back with it.
        const reason =
          updated.role !== existing.role
            ? 'role_change'
            : updated.disabledAt !== null && existing.disabledAt === null
              ? 'disabled'
              : updated.disabledAt === null && existing.disabledAt !== null
                ? 'enabled'
                : null;
        if (reason !== null) await endSessions(c, existing.id, reason);
        return updated;
      },
    );
    return c.json({ data: userView(user) }, 200);
  });

  api.openapi(routes.unbindUser, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const user = await change(
      c,
      // Never the subject or the typed confirmation: the previous provider id only.
      { action: 'user.unbind', targetType: 'user', targetId: id },
      async () => {
        if (!actsAsOwner(c)) throw denied('role');
        const principal = c.get('principal') as AdminPrincipal | undefined;
        if (principal?.kind === 'session' && principal.user.id === id) throw denied('self');
        const existing = await must('user', id, (x) => storage.users.get(x));
        if (existing.idp === null && existing.idpSubject === null) {
          throw new AdminApiError('conflict', 'the user has no sign-in identity to clear');
        }
        if (normalizeEmail(body.confirm) !== existing.email) {
          throw new AdminApiError('invalid_request', "confirm must repeat the user's email address", {
            field: 'confirm',
          });
        }
        // Sessions first: if the update then fails, the user is only signed out, never left signed in and unbound.
        await endSessions(c, existing.id, 'unbind');
        const updated = await storage.users.update(existing.id, { idp: null, idpSubject: null });
        return { updated, previousIdp: existing.idp };
      },
      (r) => ({ details: { previousIdp: r.previousIdp } }),
    );
    return c.json({ data: userView(user.updated) }, 200);
  });

  api.openapi(routes.revokeUserSessions, async (c) => {
    const { id } = c.req.valid('param');
    const principal = c.get('principal') as AdminPrincipal | undefined;
    const revoked = await change(
      c,
      {
        action: 'session.revoke_all',
        targetType: 'user',
        targetId: id,
        details: { reason: 'admin_request' },
      },
      async () => {
        // Members: themselves only, decided before any lookup (no user enumeration).
        if (principal?.kind === 'session' && principal.role === 'member' && principal.user.id !== id) {
          throw denied('role');
        }
        const target = await must('user', id, (x) => storage.users.get(x));
        const self = principal?.kind === 'session' && principal.user.id === target.id;
        if (target.role === 'owner' && !self && !actsAsOwner(c)) throw denied('owner');
        return revokeAll(target.id);
      },
      (n) => ({ details: { revoked: n } }),
    );
    return c.json({ data: { userId: id, revoked } }, 200);
  });

  // ------------------------------------------------------------------------------------------------- session
  api.openapi(routes.getSession, async (c) => {
    const principal = c.get('principal') as AdminPrincipal;
    if (principal.kind === 'admin_token') {
      return c.json(
        {
          data: {
            kind: 'admin_token' as const,
            role: 'owner' as const,
            user: null,
            csrfToken: null,
            provider: null,
            expiresAt: null,
            idleExpiresAt: null,
          },
        },
        200,
      );
    }
    const { session } = principal;
    return c.json(
      {
        data: {
          kind: 'session' as const,
          role: principal.role,
          user: userView(principal.user),
          csrfToken: session.record.csrf,
          provider: session.record.provider,
          expiresAt: session.record.expiresAt,
          idleExpiresAt: session.idleExpiresAt,
        },
      },
      200,
    );
  });

  // ---------------------------------------------------------------------------------------------- credentials
  api.openapi(routes.listCredentials, async (c) => {
    const q = c.req.valid('query');
    const rows = await storage.credentials.list(
      q.ownerUserId === undefined ? {} : { ownerUserId: q.ownerUserId },
    );
    const { page, nextCursor } = paginate(rows, q.limit, q.cursor);
    return c.json({ data: page.map(credentialView), nextCursor }, 200);
  });

  api.openapi(routes.createCredential, async (c) => {
    const body = c.req.valid('json');
    const credential = await change(
      c,
      {
        action: 'credential.create',
        targetType: 'credential',
        details: { label: body.label, region: body.region, owned: body.ownerUserId != null },
      },
      async () => {
        await guardOwnerAssets(c, [body.ownerUserId]);
        return createCredential(credentialDeps, {
          label: body.label,
          region: body.region,
          apiKey: new Secret(body.apiKey),
          ownerUserId: body.ownerUserId ?? null,
        });
      },
      (r) => ({ targetId: r.id }),
    );
    return c.json({ data: credentialView(credential) }, 201);
  });

  api.openapi(routes.getCredential, async (c) => {
    const { id } = c.req.valid('param');
    return c.json(
      { data: credentialView(await must('credential', id, (x) => storage.credentials.get(x))) },
      200,
    );
  });

  api.openapi(routes.updateCredential, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const credential = await change(
      c,
      { action: 'credential.update', targetType: 'credential', targetId: id, details: { label: body.label } },
      async () => {
        const existing = await must('credential', id, (x) => storage.credentials.get(x));
        await guardOwnerAssets(c, [existing.ownerUserId]);
        const label = body.label.trim();
        if (label === '')
          throw new AdminApiError('invalid_request', 'label must not be blank', { field: 'label' });
        return storage.credentials.update(existing.id, { label });
      },
    );
    return c.json({ data: credentialView(credential) }, 200);
  });

  api.openapi(routes.deleteCredential, async (c) => {
    const { id } = c.req.valid('param');
    await change(c, { action: 'credential.delete', targetType: 'credential', targetId: id }, async () => {
      const existing = await must('credential', id, (x) => storage.credentials.get(x));
      await guardOwnerAssets(c, [existing.ownerUserId]);
      try {
        await storage.credentials.delete(existing.id);
      } catch (error) {
        if (error instanceof ConflictError) {
          throw new AdminApiError(
            'conflict',
            'the credential is still used by a project or grant: point them at another credential first',
            { field: 'id' },
          );
        }
        throw error;
      }
    });
    return c.body(null, 204);
  });

  api.openapi(routes.rotateCredential, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const result = await change(
      c,
      { action: 'credential.rotate', targetType: 'credential', targetId: id },
      async () => {
        const existing = await must('credential', id, (x) => storage.credentials.get(x));
        await guardOwnerAssets(c, [existing.ownerUserId]);
        return rotateCredentialKey(credentialDeps, id, new Secret(body.apiKey));
      },
      (r) => ({ details: { warnings: [...r.warnings] } }),
    );
    return c.json({ data: credentialView(result.credential), warnings: [...result.warnings] }, 200);
  });

  api.openapi(routes.revalidateCredential, async (c) => {
    const { id } = c.req.valid('param');
    const result = await change(
      c,
      { action: 'credential.revalidate', targetType: 'credential', targetId: id },
      async () => {
        await must('credential', id, (x) => storage.credentials.get(x));
        return revalidateCredential(credentialDeps, id);
      },
      (r) => ({ details: { outcome: r.outcome, code: r.code } }),
    );
    const credential = await must('credential', id, (x) => storage.credentials.get(x));
    return c.json(
      {
        data: {
          id: result.id,
          outcome: result.outcome,
          code: result.code,
          accountsAdded: [...result.accountsAdded],
          accountsRemoved: [...result.accountsRemoved],
        },
        credential: credentialView(credential),
      },
      200,
    );
  });

  // ------------------------------------------------------------------------------------------------- projects
  api.openapi(routes.listProjects, async (c) => {
    const q = c.req.valid('query');
    let rows = await storage.projects.list();
    if (q.slug !== undefined) rows = rows.filter((p) => p.slug === q.slug);
    const { page, nextCursor } = paginate(rows, q.limit, q.cursor);
    return c.json({ data: page.map(projectView), nextCursor }, 200);
  });

  api.openapi(routes.createProject, async (c) => {
    const body = c.req.valid('json');
    const project = await change(
      c,
      { action: 'project.create', targetType: 'project', details: { slug: body.slug } },
      async () => {
        await guardOwnerAssets(c, [await credentialOwnerId(body.defaultCredentialId)]);
        return createProject(storage, compact(body) as CreateProjectInput, catalog);
      },
      (p) => ({ targetId: p.id, projectId: p.id }),
    );
    return c.json({ data: projectView(project) }, 201);
  });

  api.openapi(routes.getProject, async (c) => {
    const { id } = c.req.valid('param');
    return c.json({ data: projectView(await must('project', id, (x) => storage.projects.get(x))) }, 200);
  });

  api.openapi(routes.updateProject, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const result = await change(
      c,
      {
        action: 'project.update',
        targetType: 'project',
        targetId: id,
        projectId: id,
        details: { fields: Object.keys(body) },
      },
      async () => {
        await guardOwnerAssets(c, [await credentialOwnerId(body.defaultCredentialId)]);
        return updateProject(storage, id, compact(body) as UpdateProjectInput, catalog, clock.now());
      },
    );
    return c.json({ data: projectView(result.project), warnings: [...result.warnings] }, 200);
  });

  api.openapi(routes.deleteProject, async (c) => {
    const { id } = c.req.valid('param');
    await change(
      c,
      { action: 'project.delete', targetType: 'project', targetId: id, projectId: id },
      async () => {
        const existing = await must('project', id, (x) => storage.projects.get(x));
        await storage.projects.delete(existing.id);
      },
    );
    return c.body(null, 204);
  });

  // --------------------------------------------------------------------------------------------------- grants
  api.openapi(routes.listGrants, async (c) => {
    const q = c.req.valid('query');
    const rows = await storage.grants.list({
      ...(q.projectId === undefined ? {} : { projectId: q.projectId }),
      ...(q.userId === undefined ? {} : { userId: q.userId }),
    });
    const { page, nextCursor } = paginate(rows, q.limit, q.cursor);
    return c.json({ data: page.map(grantView), nextCursor }, 200);
  });

  api.openapi(routes.createGrant, async (c) => {
    const body = c.req.valid('json');
    const result = await change(
      c,
      {
        action: 'grant.create',
        targetType: 'grant',
        projectId: body.projectId,
        details: { userId: body.userId ?? null, credentialId: body.credentialId ?? null },
      },
      async () => {
        await guardOwnerAssets(
          c,
          await grantUsers({ userId: body.userId ?? null, credentialId: body.credentialId ?? null }),
        );
        return createGrant(storage, compact(body) as CreateGrantInput, catalog, clock.now());
      },
      (r) => ({ targetId: r.grant.id, projectId: r.grant.projectId }),
    );
    return c.json({ data: grantView(result.grant), warnings: [...result.warnings] }, 201);
  });

  api.openapi(routes.getGrant, async (c) => {
    const { id } = c.req.valid('param');
    return c.json({ data: grantView(await must('grant', id, (x) => storage.grants.get(x))) }, 200);
  });

  api.openapi(routes.revokeGrant, async (c) => {
    const { id } = c.req.valid('param');
    const grant = await change(
      c,
      { action: 'grant.revoke', targetType: 'grant', targetId: id },
      async () => {
        const existing = await must('grant', id, (x) => storage.grants.get(x));
        await guardOwnerAssets(c, await grantUsers(existing));
        return existing.revokedAt !== null
          ? existing
          : storage.grants.update(existing.id, { revokedAt: clock.now() });
      },
      (g) => ({ projectId: g.projectId }),
    );
    return c.json({ data: grantView(grant) }, 200);
  });

  api.openapi(routes.deleteGrant, async (c) => {
    const { id } = c.req.valid('param');
    await change(
      c,
      { action: 'grant.delete', targetType: 'grant', targetId: id },
      async () => {
        const existing = await must('grant', id, (x) => storage.grants.get(x));
        await guardOwnerAssets(c, await grantUsers(existing));
        await storage.grants.delete(existing.id);
        return existing;
      },
      (g) => ({ projectId: g.projectId }),
    );
    return c.body(null, 204);
  });

  // --------------------------------------------------------------------------------------------------- tokens
  api.openapi(routes.listTokens, async (c) => {
    const q = c.req.valid('query');
    const rows = await storage.accessTokens.list(q.grantId === undefined ? {} : { grantId: q.grantId });
    const { page, nextCursor } = paginate(rows, q.limit, q.cursor);
    return c.json({ data: page.map(tokenView), nextCursor }, 200);
  });

  api.openapi(routes.createToken, async (c) => {
    const body = c.req.valid('json');
    const ttl =
      body.ttlSeconds === undefined
        ? undefined
        : body.ttlSeconds === 'never'
          ? 'never'
          : body.ttlSeconds * 1000;
    const issued = await change(
      c,
      {
        action: 'token.create',
        targetType: 'token',
        details: { grantId: body.grantId, label: body.label, ttlSeconds: body.ttlSeconds ?? null },
      },
      async () => {
        const target = await storage.grants.get(body.grantId);
        if (target) await guardOwnerAssets(c, await grantUsers(target));
        const result = await issueAccessToken(
          storage,
          { grantId: body.grantId, label: body.label, ...(ttl === undefined ? {} : { ttl }) },
          clock.now(),
        );
        const grant = await storage.grants.get(result.record.grantId);
        return { result, projectId: grant?.projectId ?? null };
      },
      (r) => ({
        targetId: r.result.record.id,
        projectId: r.projectId,
        // The effective TTL (the instance default when the request gave none), not what was asked for.
        details: {
          warnings: [...r.result.warnings],
          ttlSeconds:
            r.result.record.expiresAt === null
              ? 'never'
              : Math.round((r.result.record.expiresAt - r.result.record.createdAt) / 1000),
        },
      }),
    );
    // The only place a token's plaintext is ever returned.
    return c.json(
      {
        data: tokenView(issued.result.record),
        token: issued.result.token.reveal(),
        warnings: [...issued.result.warnings],
      },
      201,
    );
  });

  api.openapi(routes.getToken, async (c) => {
    const { id } = c.req.valid('param');
    return c.json({ data: tokenView(await must('token', id, (x) => storage.accessTokens.get(x))) }, 200);
  });

  api.openapi(routes.revokeToken, async (c) => {
    const { id } = c.req.valid('param');
    const token = await change(
      c,
      { action: 'token.revoke', targetType: 'token', targetId: id },
      async () => {
        const record = await storage.accessTokens.get(id);
        const target = record ? await storage.grants.get(record.grantId) : null;
        if (target) await guardOwnerAssets(c, await grantUsers(target));
        const summary = await revokeAccessToken(storage, id, clock.now());
        const grant = await storage.grants.get(summary.grantId);
        return { summary, projectId: grant?.projectId ?? null };
      },
      (r) => ({ projectId: r.projectId }),
    );
    return c.json({ data: tokenView(token.summary) }, 200);
  });

  // ------------------------------------------------------------------------------------------------ master key
  api.openapi(routes.rotateKeys, async (c) => {
    // Owner-only (also checked by path in the middleware; this holds whatever path reached the handler).
    if (!actsAsOwner(c)) throw denied('role');
    const body = c.req.valid('json');
    const batchSize = Math.min(
      body.batchSize ?? S.DEFAULT_ROTATION_BATCH,
      deps.maxRotationBatch ?? S.MAX_ROTATION_BATCH_SIZE,
    );
    const report = await change(
      c,
      { action: 'keys.rotate', targetType: 'master_key', details: { batchSize } },
      () =>
        rotateCredentialKeysBatch(storage, deps.keyring, {
          limit: batchSize,
          ...(body.after == null ? {} : { after: body.after }),
        }),
      (r) => ({
        targetId: `v${r.currentVersion}`,
        // Counts and ids only (credential ids are not secret); failures capped so the row stays small.
        details: {
          reencrypted: r.reencrypted.length,
          failed: r.failed.slice(0, 20).map((f) => ({ id: f.id, code: f.code })),
          failedCount: r.failed.length,
          pending: r.pending,
          complete: r.nextCursor === null,
          versionsInUse: [...r.versionsInUse],
        },
      }),
    );
    return c.json(
      {
        data: {
          currentVersion: report.currentVersion,
          total: report.total,
          reencrypted: [...report.reencrypted],
          alreadyCurrent: report.alreadyCurrent,
          failed: report.failed.map((f) => ({ id: f.id, code: f.code })),
          nextCursor: report.nextCursor,
          pending: report.pending,
          versionsInUse: [...report.versionsInUse],
        },
      },
      200,
    );
  });

  // -------------------------------------------------------------------------------------------- setup links
  api.openapi(routes.createSetupLink, async (c) => {
    if (!actsAsOwner(c)) throw denied('role');
    const body = c.req.valid('json');
    const setup = deps.setupLinks;
    if (setup === undefined) {
      throw new AdminApiError(
        'not_permitted',
        'sign-in is not configured: set RB_PUBLIC_URL and an identity provider first',
      );
    }
    const provider = body.provider === undefined ? null : setup.providers.find((p) => p.id === body.provider);
    if (provider === undefined) {
      throw new AdminApiError('invalid_request', 'provider is not a configured sign-in provider', {
        field: 'provider',
      });
    }
    const ttlMinutes = body.ttlMinutes ?? 60;
    const link = await change(
      c,
      {
        action: 'setup_link.create',
        targetType: 'setup_link',
        // Never the code: lifetime and provider only.
        details: { ttlMinutes, provider: provider?.id ?? null },
      },
      () => createSetupLink(setup.kv, ttlMinutes * 60_000, clock),
    );
    const path =
      provider === null
        ? '/auth/login'
        : provider.kind === 'header'
          ? '/auth/cf-access'
          : `/auth/login/${provider.id}`;
    const url = `${setup.publicUrl}${path}?setup=${link.code}`;
    return c.json({ data: { url, expiresAt: link.expiresAt, provider: provider?.id ?? null } }, 201);
  });

  // ---------------------------------------------------------------------------------------------------- audit
  // ------------------------------------------------------------------------------------------ self-service (P4-10)
  // Every handler starts from `me(c)` (the signed-in user; the admin token is refused before it gets here) and then
  // looks a row up by id AND requires it to be the caller's. A row that is someone else's answers exactly like one that
  // does not exist (`404`), so ids cannot be probed. No handler takes a user id, an owner id or a project id from the
  // request: ownership always comes from the session.
  const me = (c: Context): UserRecord => {
    const principal = c.get('principal') as AdminPrincipal | undefined;
    if (principal?.kind !== 'session') throw denied('no_user');
    return principal.user;
  };
  const ownCredential = async (id: string, userId: string): Promise<CredentialRecord> => {
    const row = await storage.credentials.get(id);
    if (row === null || row.ownerUserId !== userId) throw notFound('credential', id);
    return row;
  };
  const ownGrant = async (id: string, userId: string): Promise<GrantRecord> => {
    const row = await storage.grants.get(id);
    if (row === null || row.userId === null || row.userId !== userId) throw notFound('grant', id);
    return row;
  };
  const myGrantView = async (g: GrantRecord) => {
    const project = await storage.projects.get(g.projectId);
    return {
      ...grantView(g),
      project:
        project === null
          ? null
          : { slug: project.slug, name: project.name, disabled: project.disabledAt !== null },
    };
  };

  api.openapi(routes.myCredentials, async (c) => {
    const self = me(c);
    const q = c.req.valid('query');
    const rows = (await storage.credentials.list({ ownerUserId: self.id })).filter(
      (r) => r.ownerUserId === self.id,
    );
    const { page, nextCursor } = paginate(rows, q.limit, q.cursor);
    return c.json({ data: page.map(credentialView), nextCursor }, 200);
  });

  api.openapi(routes.addMyCredential, async (c) => {
    const self = me(c);
    const body = c.req.valid('json');
    const credential = await change(
      c,
      {
        action: 'credential.create',
        targetType: 'credential',
        details: { label: body.label, region: body.region, owned: true, self: true },
      },
      async () => {
        const mine = await storage.credentials.list({ ownerUserId: self.id });
        if (mine.length >= MAX_OWN_CREDENTIALS) {
          throw new AdminApiError(
            'conflict',
            `you can keep at most ${MAX_OWN_CREDENTIALS} keys: delete one you no longer use first`,
          );
        }
        return createCredential(credentialDeps, {
          label: body.label,
          region: body.region,
          apiKey: new Secret(body.apiKey),
          ownerUserId: self.id,
        });
      },
      (r) => ({ targetId: r.id }),
    );
    return c.json({ data: credentialView(credential) }, 201);
  });

  api.openapi(routes.renameMyCredential, async (c) => {
    const self = me(c);
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const credential = await change(
      c,
      {
        action: 'credential.update',
        targetType: 'credential',
        targetId: id,
        details: { label: body.label, self: true },
      },
      async () => {
        const existing = await ownCredential(id, self.id);
        const label = body.label.trim();
        if (label === '')
          throw new AdminApiError('invalid_request', 'label must not be blank', { field: 'label' });
        return storage.credentials.update(existing.id, { label });
      },
    );
    return c.json({ data: credentialView(credential) }, 200);
  });

  api.openapi(routes.deleteMyCredential, async (c) => {
    const self = me(c);
    const { id } = c.req.valid('param');
    await change(
      c,
      { action: 'credential.delete', targetType: 'credential', targetId: id, details: { self: true } },
      async () => {
        const existing = await ownCredential(id, self.id);
        try {
          await storage.credentials.delete(existing.id);
        } catch (error) {
          if (error instanceof ConflictError) {
            throw new AdminApiError(
              'conflict',
              'the key is still used by a grant: point the grant at another key first',
              { field: 'id' },
            );
          }
          throw error;
        }
      },
    );
    return c.body(null, 204);
  });

  api.openapi(routes.rotateMyCredential, async (c) => {
    const self = me(c);
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const result = await change(
      c,
      { action: 'credential.rotate', targetType: 'credential', targetId: id, details: { self: true } },
      async () => {
        await ownCredential(id, self.id);
        return rotateCredentialKey(credentialDeps, id, new Secret(body.apiKey));
      },
      (r) => ({ details: { warnings: [...r.warnings] } }),
    );
    return c.json({ data: credentialView(result.credential), warnings: [...result.warnings] }, 200);
  });

  api.openapi(routes.revalidateMyCredential, async (c) => {
    const self = me(c);
    const { id } = c.req.valid('param');
    const result = await change(
      c,
      { action: 'credential.revalidate', targetType: 'credential', targetId: id, details: { self: true } },
      async () => {
        await ownCredential(id, self.id);
        return revalidateCredential(credentialDeps, id);
      },
      (r) => ({ details: { outcome: r.outcome, code: r.code } }),
    );
    const credential = await ownCredential(id, self.id);
    return c.json(
      {
        data: {
          id: result.id,
          outcome: result.outcome,
          code: result.code,
          accountsAdded: [...result.accountsAdded],
          accountsRemoved: [...result.accountsRemoved],
        },
        credential: credentialView(credential),
      },
      200,
    );
  });

  api.openapi(routes.myGrants, async (c) => {
    const self = me(c);
    const q = c.req.valid('query');
    const rows = (await storage.grants.list({ userId: self.id })).filter((g) => g.userId === self.id);
    const { page, nextCursor } = paginate(rows, q.limit, q.cursor);
    return c.json({ data: await Promise.all(page.map(myGrantView)), nextCursor }, 200);
  });

  api.openapi(routes.setMyGrantCredential, async (c) => {
    const self = me(c);
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const grant = await change(
      c,
      {
        action: 'grant.set_credential',
        targetType: 'grant',
        targetId: id,
        details: { self: true, credentialId: body.credentialId },
      },
      async () => {
        const existing = await ownGrant(id, self.id);
        if (existing.revokedAt !== null) {
          throw new AdminApiError('conflict', 'the grant is revoked', { field: 'id' });
        }
        if (body.credentialId !== null) {
          const credential = await ownCredential(body.credentialId, self.id);
          if (credential.revokedAt !== null || credential.validationStatus === 'invalid') {
            throw new AdminApiError(
              'not_permitted',
              'that key is revoked or was refused by New Relic: rotate it first',
              { field: 'credentialId' },
            );
          }
        }
        return storage.grants.update(existing.id, { credentialId: body.credentialId });
      },
      (g) => ({ projectId: g.projectId }),
    );
    return c.json({ data: await myGrantView(grant) }, 200);
  });

  api.openapi(routes.myTokens, async (c) => {
    const self = me(c);
    const q = c.req.valid('query');
    const grants = (await storage.grants.list({ userId: self.id })).filter((g) => g.userId === self.id);
    // `grantId`, when given, narrows the list; naming someone else's grant is a 404, never an empty page.
    const wanted = q.grantId === undefined ? grants : grants.filter((g) => g.id === q.grantId);
    if (q.grantId !== undefined && wanted.length === 0) throw notFound('grant', q.grantId);
    const rows = (await Promise.all(wanted.map((g) => storage.accessTokens.list({ grantId: g.id })))).flat();
    const { page, nextCursor } = paginate(rows, q.limit, q.cursor);
    return c.json({ data: page.map(tokenView), nextCursor }, 200);
  });

  api.openapi(routes.createMyToken, async (c) => {
    const self = me(c);
    const body = c.req.valid('json');
    const ttl =
      body.ttlSeconds === undefined
        ? undefined
        : body.ttlSeconds === 'never'
          ? 'never'
          : body.ttlSeconds * 1000;
    const issued = await change(
      c,
      {
        action: 'token.create',
        targetType: 'token',
        details: {
          grantId: body.grantId,
          label: body.label,
          ttlSeconds: body.ttlSeconds ?? null,
          self: true,
        },
      },
      async () => {
        const grant = await ownGrant(body.grantId, self.id);
        if (grant.revokedAt !== null) {
          throw new AdminApiError('conflict', 'the grant is revoked', { field: 'grantId' });
        }
        const now = clock.now();
        const live = (await storage.accessTokens.list({ grantId: grant.id })).filter(
          (t) => t.revokedAt === null && (t.expiresAt === null || t.expiresAt > now),
        );
        if (live.length >= MAX_LIVE_TOKENS_PER_GRANT) {
          throw new AdminApiError(
            'conflict',
            `a grant can have at most ${MAX_LIVE_TOKENS_PER_GRANT} live tokens: revoke one you no longer use`,
            { field: 'grantId' },
          );
        }
        const result = await issueAccessToken(
          storage,
          { grantId: grant.id, label: body.label, ...(ttl === undefined ? {} : { ttl }) },
          now,
        );
        return { result, projectId: grant.projectId };
      },
      (r) => ({
        targetId: r.result.record.id,
        projectId: r.projectId,
        details: {
          warnings: [...r.result.warnings],
          ttlSeconds:
            r.result.record.expiresAt === null
              ? 'never'
              : Math.round((r.result.record.expiresAt - r.result.record.createdAt) / 1000),
        },
      }),
    );
    return c.json(
      {
        data: tokenView(issued.result.record),
        token: issued.result.token.reveal(),
        warnings: [...issued.result.warnings],
      },
      201,
    );
  });

  api.openapi(routes.revokeMyToken, async (c) => {
    const self = me(c);
    const { id } = c.req.valid('param');
    const token = await change(
      c,
      { action: 'token.revoke', targetType: 'token', targetId: id, details: { self: true } },
      async () => {
        const existing = await storage.accessTokens.get(id);
        if (existing === null) throw notFound('token', id);
        const grant = await ownGrant(existing.grantId, self.id).catch(() => {
          throw notFound('token', id);
        });
        const summary = await revokeAccessToken(storage, existing.id, clock.now());
        return { summary, projectId: grant.projectId };
      },
      (r) => ({ projectId: r.projectId }),
    );
    return c.json({ data: tokenView(token.summary) }, 200);
  });

  api.openapi(routes.listAudit, async (c) => {
    const q = c.req.valid('query');
    const principal = c.get('principal') as AdminPrincipal | undefined;
    // Members read their own rows only: the filter is forced here, whatever the caller asked for.
    const own = principal?.kind === 'session' && principal.role === 'member' ? principal.user.id : undefined;
    if (own !== undefined && q.userId !== undefined && q.userId !== own)
      throw new HTTPException(403, { res: forbidden(c, 'role') });
    const limit = q.limit ?? DEFAULT_PAGE;
    let beforeId: number | undefined;
    if (q.cursor !== undefined) {
      const m = /^a:(\d{1,15})$/.exec(b64urlDecode(q.cursor) ?? '');
      if (m === null) throw badCursor();
      beforeId = Number(m[1]);
    }
    const since = parseTime(q.since, 'since');
    const until = parseTime(q.until, 'until');
    const query: AuditQuery = {
      ...(q.kind === undefined ? {} : { kind: q.kind }),
      ...(q.action === undefined ? {} : { action: q.action }),
      ...(q.status === undefined ? {} : { status: q.status }),
      ...(q.projectId === undefined ? {} : { projectId: q.projectId }),
      ...(own !== undefined ? { userId: own } : q.userId === undefined ? {} : { userId: q.userId }),
      ...(q.grantId === undefined ? {} : { grantId: q.grantId }),
      ...(q.tokenId === undefined ? {} : { tokenId: q.tokenId }),
      ...(q.keyId === undefined ? {} : q.keyId === 'any' ? { passthrough: true } : { keyId: q.keyId }),
      ...(q.order === 'slowest' ? { order: 'slowest' as const } : {}),
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
      ...(beforeId === undefined ? {} : { beforeId }),
      limit: limit + 1,
    };
    const rows = await storage.auditLog.list(query);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const nextCursor =
      q.order !== 'slowest' && rows.length > limit && last ? b64urlEncode(`a:${last.id}`) : null;
    return c.json({ data: page.map(auditView), nextCursor }, 200);
  });

  api.openapi(routes.auditStats, async (c) => {
    const q = c.req.valid('query');
    const until = parseTime(q.until, 'until') ?? clock.now();
    const since = parseTime(q.since, 'since') ?? until - 7 * 86_400_000;
    if (since >= until || until - since > S.AUDIT_STATS_MAX_DAYS * 86_400_000) {
      throw new AdminApiError(
        'invalid_request',
        `the window must be positive and at most ${S.AUDIT_STATS_MAX_DAYS} days`,
        { field: 'since' },
      );
    }
    const rows = await storage.auditLog.stats({
      groupBy: q.groupBy ?? 'action',
      since,
      until,
      ...(q.action === undefined ? {} : { action: q.action }),
      ...(q.projectId === undefined ? {} : { projectId: q.projectId }),
      ...(q.userId === undefined ? {} : { userId: q.userId }),
      ...(q.grantId === undefined ? {} : { grantId: q.grantId }),
      ...(q.tokenId === undefined ? {} : { tokenId: q.tokenId }),
      ...(q.limit === undefined ? {} : { limit: q.limit }),
    });
    return c.json({ data: rows.map((r) => ({ ...r })), window: { since, until } }, 200);
  });

  // ------------------------------------------------------------------------------------------------- document
  let document: unknown;
  api.get('/openapi.json', (c) => {
    document ??= adminOpenApiDocument(api);
    return c.json(document as Record<string, unknown>, 200);
  });

  api.all('*', () => {
    throw new AdminApiError('not_found', 'no such admin endpoint');
  });

  api.onError((error, c) => {
    const mapped = toAdminApiError(error);
    if (mapped !== null) {
      if (mapped.code === 'unavailable') c.header('Retry-After', String(ADMIN_RETRY_AFTER_SECONDS));
      return c.json(adminErrorBody(mapped), mapped.status as 400);
    }
    if (error instanceof HTTPException) {
      // A refusal a handler already built (and audited) through `forbidden`.
      if (error.status === 403) return error.getResponse();
      if (error.status === 400) recordRefusal(c, 'invalid_request');
      // Hono's own refusals: malformed JSON, oversized bodies.
      const code = error.status === 413 ? 'payload_too_large' : 'invalid_request';
      const message =
        error.status === 413 ? 'request body is too large' : 'the request body is not valid JSON';
      return c.json(adminErrorBody(new AdminApiError(code, message)), error.status === 413 ? 413 : 400);
    }
    logger.error('admin api error', {
      requestId: c.get('requestId'),
      error: error instanceof Error ? error.name : typeof error,
    });
    return c.json(adminErrorBody(new AdminApiError('internal_error', 'internal error')), 500);
  });

  return api;
}

/** The OpenAPI 3.1 document of the admin API. */
export function adminOpenApiDocument(api: OpenAPIHono<AdminEnv>): Record<string, unknown> {
  return api.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'relic-bridge admin API',
      version: 'v1',
      description:
        'API-first management of a relic-bridge instance: users, New Relic credentials, projects, grants, device ' +
        'tokens and the audit log. Authenticate with the bootstrap admin token (`Authorization: Bearer …`, role ' +
        '`owner`) or, from a browser, an admin session (cookie + `X-CSRF-Token`; roles `owner` > `admin` > `member`). ' +
        'New Relic keys are accepted in request bodies only and never returned; token hashes are never returned.',
    },
    servers: [{ url: ADMIN_API_BASE }],
    security: SECURITY,
  }) as unknown as Record<string, unknown>;
}
