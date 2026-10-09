// SPDX-License-Identifier: Apache-2.0
// The admin REST API (P2-09): `/api/admin/v1/*`, API-first management of users, credentials, projects, grants, access
// tokens and the audit log. Web-standard only (ADR-0004); mounted by `createHttpApp` when an admin token is set.
//
// Security rules (THREAT_MODEL T8/T13/T14/T23):
// - bearer admin token only (no cookies, no query-string credentials), one uniform 401, failures throttled and
//   audited through the same hooks as the MCP routes;
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
/** Recorded as the actor of admin changes until IdP sessions name a user (P4). */
export const ADMIN_TOKEN_ACTOR: 'admin_token' = 'admin_token';

export type StorageForAdmin = Pick<
  Storage,
  'users' | 'credentials' | 'projects' | 'grants' | 'accessTokens' | 'auditLog' | 'settings'
>;

type Vars = { requestId: string; started: number; log: Record<string, unknown> };
export type AdminEnv = { Variables: Vars };

/** What `createHttpApp` hands the admin API (everything request-scoped stays in the handler). */
export interface AdminApiDeps {
  readonly storage: StorageForAdmin;
  readonly keyring: Keyring;
  readonly verifier: AdminTokenVerifier;
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
  /** After every successful change (clears the access cache). */
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
  401: 'Missing or wrong admin token (`unauthorized`)',
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
  const all = [400, 401, 429, 503, ...codes];
  return Object.fromEntries(
    all.map((code) => [code, json(S.ErrorSchema, ERROR_DESCRIPTIONS[code] ?? 'Error')]),
  ) as Record<number, ReturnType<typeof json<typeof S.ErrorSchema>>>;
}

const BODY = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } }, required: true },
});

function route<const R extends RouteConfig>(config: R): R {
  return createRoute({ ...config, security: [{ adminToken: [] }] }) as R;
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
    request: { params: S.IdParam, ...BODY(S.UpdateUserBody) },
    responses: { 200: json(S.UserOne, 'Updated'), ...errors(404, 409, 413, 415) },
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

  listAudit: route({
    method: 'get',
    path: '/audit',
    tags: ['audit'],
    summary: 'Query the audit log (newest first)',
    request: { query: S.AuditQuerySchema },
    responses: { 200: json(S.AuditPage, 'Audit rows'), ...errors() },
  }),
};

/** Actions that take no request body (`POST …/revoke`, `POST …/revalidate`). */
const BODYLESS_ACTION = /\/(?:revoke|revalidate)\/?$/;

/** Mutating routes whose schema-refused requests are audited: [method, path under the base, action, target type]. */
const REFUSAL_ROUTES: readonly (readonly [string, RegExp, string, string])[] = [
  ['POST', /^\/users$/, 'user.create', 'user'],
  ['PATCH', /^\/users\/([^/]+)$/, 'user.update', 'user'],
  ['POST', /^\/credentials$/, 'credential.create', 'credential'],
  ['PATCH', /^\/credentials\/([^/]+)$/, 'credential.update', 'credential'],
  ['POST', /^\/credentials\/([^/]+)\/rotate$/, 'credential.rotate', 'credential'],
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

/** Build the admin sub-app (mounted at {@link ADMIN_API_BASE}). */
export function createAdminApi(deps: AdminApiDeps): OpenAPIHono<AdminEnv> {
  const { storage, clock, logger, catalog } = deps;
  /**
   * Audit a request refused before its handler ran (schema validation, malformed JSON) on a mutating route, so every
   * refused change leaves a row. Nothing the caller submitted goes into the row except the id in the path (redacted),
   * and the write is capped like other refusal rows.
   */
  const recordRefusal = (c: Context, errorCode: string): void => {
    if (!deps.audit) return;
    const at = c.req.path.indexOf(ADMIN_API_BASE);
    const rel = at === -1 ? c.req.path : c.req.path.slice(at + ADMIN_API_BASE.length);
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
          details: { via: ADMIN_TOKEN_ACTOR },
        }),
        'admin_audit',
      );
      return;
    }
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
    description: 'The bootstrap admin token (`RB_ADMIN_TOKEN`). Not an MCP access token.',
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
    const header = c.req.header('authorization');
    const presented = adminBearer(header);
    const ok = presented !== null && (await deps.verifier.verify(presented));
    if (!ok) {
      const reason =
        header === undefined
          ? 'admin_missing_token'
          : presented === null
            ? 'admin_malformed_header'
            : 'admin_bad_token';
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

  const actor = (c: Context) => ({ requestId: c.get('requestId') as string });

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
          details: { via: ADMIN_TOKEN_ACTOR, ...(meta.details ?? {}), ...(event.details ?? {}) },
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
        status: mapped?.code === 'not_permitted' ? 'denied' : 'error',
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
      () =>
        storage.users.create({
          id: newId('usr'),
          email: normalizeEmail(body.email),
          displayName: body.displayName ?? null,
          role: body.role ?? 'member',
        }),
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
        const patch: { -readonly [K in keyof UserPatch]: UserPatch[K] } = {};
        if (body.displayName !== undefined) patch.displayName = body.displayName;
        if (body.role !== undefined) patch.role = body.role;
        if (body.disabled !== undefined)
          patch.disabledAt = body.disabled ? (existing.disabledAt ?? clock.now()) : null;
        return Object.keys(patch).length === 0 ? existing : storage.users.update(existing.id, patch);
      },
    );
    return c.json({ data: userView(user) }, 200);
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
      () =>
        createCredential(credentialDeps, {
          label: body.label,
          region: body.region,
          apiKey: new Secret(body.apiKey),
          ownerUserId: body.ownerUserId ?? null,
        }),
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
        await must('credential', id, (x) => storage.credentials.get(x));
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
      () => createProject(storage, compact(body) as CreateProjectInput, catalog),
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
      () => updateProject(storage, id, compact(body) as UpdateProjectInput, catalog, clock.now()),
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
      () => createGrant(storage, compact(body) as CreateGrantInput, catalog, clock.now()),
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
  api.openapi(routes.listAudit, async (c) => {
    const q = c.req.valid('query');
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
      ...(q.userId === undefined ? {} : { userId: q.userId }),
      ...(q.grantId === undefined ? {} : { grantId: q.grantId }),
      ...(q.tokenId === undefined ? {} : { tokenId: q.tokenId }),
      ...(q.keyId === undefined ? {} : q.keyId === 'any' ? { passthrough: true } : { keyId: q.keyId }),
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
      ...(beforeId === undefined ? {} : { beforeId }),
      limit: limit + 1,
    };
    const rows = await storage.auditLog.list(query);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const nextCursor = rows.length > limit && last ? b64urlEncode(`a:${last.id}`) : null;
    return c.json({ data: page.map(auditView), nextCursor }, 200);
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
        'tokens and the audit log. Authenticate with the bootstrap admin token (`Authorization: Bearer …`). New ' +
        'Relic keys are accepted in request bodies only and never returned; token hashes are never returned.',
    },
    servers: [{ url: ADMIN_API_BASE }],
    security: [{ adminToken: [] }],
  }) as unknown as Record<string, unknown>;
}
