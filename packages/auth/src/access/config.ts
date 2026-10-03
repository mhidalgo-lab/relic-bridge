// SPDX-License-Identifier: Apache-2.0
// Project and grant domain services (ADR-0008). They validate input the storage layer can't (tool names against the
// catalog, accounts against the project, credential ownership) before writing. The resolver re-checks everything
// at request time anyway, so a row changed behind these services still can't widen access.
import { redact } from '@relic-bridge/core';
import {
  type GrantRecord,
  limitsSchema,
  newId,
  type ProjectRecord,
  SLUG_RE,
  type Storage,
  type StoredLimits,
  type StoredRateLimit,
} from '@relic-bridge/storage';
import { AccessError } from './errors.ts';
import { credentialPermitted } from './resolve.ts';

export const MAX_NAME_CHARS = 100;
export const MAX_ACCOUNTS = 1000;
export const MAX_TOOLS = 200;

type Deps = Pick<Storage, 'projects' | 'grants' | 'users' | 'credentials'>;

function checkName(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  const v = typeof value === 'string' ? value.trim() : '';
  if (v === '' || v.length > MAX_NAME_CHARS) {
    throw new AccessError('invalid_input', `${field} must be 1-${MAX_NAME_CHARS} characters`, field);
  }
  return v;
}

function checkAccounts(value: readonly number[], field: string): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ACCOUNTS) {
    throw new AccessError('invalid_input', `${field} must list 1-${MAX_ACCOUNTS} account ids`, field);
  }
  for (const id of value) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new AccessError('invalid_input', `${field} must hold positive integer account ids`, field);
    }
  }
  return [...new Set(value)];
}

/** Tool names must be known: a typo must not silently grant less (or, after a rename, more) than intended. */
function checkTools(value: readonly string[], catalog: readonly string[], field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TOOLS) {
    throw new AccessError('invalid_input', `${field} must list 1-${MAX_TOOLS} tool names`, field);
  }
  const unknown = value.filter((t) => typeof t !== 'string' || !catalog.includes(t));
  if (unknown.length > 0) {
    throw new AccessError(
      'invalid_input',
      redact(`${field}: unknown tool name(s) ${unknown.map((t) => String(t).slice(0, 64)).join(', ')}`),
      field,
    );
  }
  return [...new Set(value)];
}

function checkLimits(value: StoredLimits | undefined, field: string): StoredLimits {
  if (value === undefined) return {};
  const parsed = limitsSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `.${issue.path.join('.')}` : '';
    throw new AccessError('invalid_input', `${field}${where}: ${issue?.message ?? 'invalid'}`, field);
  }
  return JSON.parse(JSON.stringify(parsed.data)) as StoredLimits;
}

async function liveCredential(storage: Deps, id: string, field: string) {
  const credential = await storage.credentials.get(id);
  if (credential === null || credential.revokedAt !== null) {
    throw new AccessError('not_found', `credential ${id} not found`, field);
  }
  return credential;
}

export interface CreateProjectInput {
  readonly slug: string;
  readonly name?: string | null;
  readonly defaultAccountId: number;
  readonly allowedAccountIds: readonly number[];
  /** Null or absent = every tool in the catalog. */
  readonly enabledTools?: readonly string[] | null;
  readonly limits?: StoredLimits;
  readonly defaultCredentialId?: string | null;
}

export async function createProject(
  storage: Deps,
  input: CreateProjectInput,
  catalog: readonly string[],
): Promise<ProjectRecord> {
  const slug = typeof input.slug === 'string' ? input.slug.trim() : '';
  if (!SLUG_RE.test(slug)) {
    throw new AccessError(
      'invalid_input',
      'slug must be lowercase letters, digits and dashes (max 63)',
      'slug',
    );
  }
  const allowedAccountIds = checkAccounts(input.allowedAccountIds, 'allowedAccountIds');
  if (!allowedAccountIds.includes(input.defaultAccountId)) {
    throw new AccessError(
      'invalid_input',
      'defaultAccountId must be one of allowedAccountIds',
      'defaultAccountId',
    );
  }
  const enabledTools =
    input.enabledTools === undefined || input.enabledTools === null
      ? null
      : checkTools(input.enabledTools, catalog, 'enabledTools');
  const limits = checkLimits(input.limits, 'limits');
  const defaultCredentialId = input.defaultCredentialId ?? null;
  if (defaultCredentialId !== null) await liveCredential(storage, defaultCredentialId, 'defaultCredentialId');
  return storage.projects.create({
    id: newId('prj'),
    slug,
    name: checkName(input.name, 'name'),
    defaultAccountId: input.defaultAccountId,
    allowedAccountIds,
    enabledTools,
    limits,
    defaultCredentialId,
  });
}

export interface CreateGrantInput {
  readonly projectId: string;
  /** A user grant; omit (null) for a service grant, which then needs a `label`. */
  readonly userId?: string | null;
  readonly label?: string | null;
  /** Null/absent = the project's default credential. */
  readonly credentialId?: string | null;
  /** Null/absent = everything the project enables. */
  readonly tools?: readonly string[] | null;
  /** Null/absent = every project account. */
  readonly accountIds?: readonly number[] | null;
  readonly limits?: StoredLimits;
  readonly rateLimit?: StoredRateLimit | null;
  readonly expiresAt?: number | null;
}

export interface CreateGrantResult {
  readonly grant: GrantRecord;
  /**
   * Parts of the request the project does not allow (tools it doesn't enable, accounts it doesn't allow). They are
   * stored as asked but never take effect while the project doesn't allow them: access is always the intersection.
   */
  readonly warnings: readonly string[];
}

export async function createGrant(
  storage: Deps,
  input: CreateGrantInput,
  catalog: readonly string[],
  now: number,
): Promise<CreateGrantResult> {
  const project = await storage.projects.get(input.projectId);
  if (project === null)
    throw new AccessError('not_found', `project ${input.projectId} not found`, 'projectId');
  const userId = input.userId ?? null;
  const label = checkName(input.label, 'label');
  if (userId === null && label === null) {
    throw new AccessError('invalid_input', 'a service grant (no user) needs a label', 'label');
  }
  if (userId !== null) {
    const user = await storage.users.get(userId);
    if (user === null || user.disabledAt !== null) {
      throw new AccessError('not_found', `user ${userId} not found`, 'userId');
    }
  }
  const credentialId = input.credentialId ?? null;
  if (credentialId === null && project.defaultCredentialId === null) {
    throw new AccessError(
      'invalid_input',
      'the project has no default credential: give the grant a credentialId',
      'credentialId',
    );
  }
  if (credentialId !== null) {
    const credential = await liveCredential(storage, credentialId, 'credentialId');
    if (!credentialPermitted(project, { credentialId, userId }, credential)) {
      throw new AccessError(
        'not_permitted',
        "a grant can use the project's default credential, a shared one or its own user's, not another user's",
        'credentialId',
      );
    }
  }
  const warnings: string[] = [];
  const tools =
    input.tools === undefined || input.tools === null ? null : checkTools(input.tools, catalog, 'tools');
  if (tools !== null && project.enabledTools !== null) {
    const outside = tools.filter((t) => !project.enabledTools?.includes(t));
    if (outside.length > 0)
      warnings.push(`tools not enabled on the project (no effect): ${outside.join(', ')}`);
  }
  const accountIds =
    input.accountIds === undefined || input.accountIds === null
      ? null
      : checkAccounts(input.accountIds, 'accountIds');
  if (accountIds !== null) {
    const outside = accountIds.filter((a) => !project.allowedAccountIds.includes(a));
    if (outside.length > 0)
      warnings.push(`accounts not allowed on the project (no effect): ${outside.join(', ')}`);
  }
  const rateLimit = input.rateLimit ?? null;
  if (
    rateLimit !== null &&
    !(
      Number.isSafeInteger(rateLimit.requests) &&
      rateLimit.requests > 0 &&
      Number.isSafeInteger(rateLimit.perSeconds) &&
      rateLimit.perSeconds > 0
    )
  ) {
    throw new AccessError(
      'invalid_input',
      'rateLimit needs positive integer requests and perSeconds',
      'rateLimit',
    );
  }
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && !(Number.isSafeInteger(expiresAt) && expiresAt > now)) {
    throw new AccessError('invalid_input', 'expiresAt must be in the future', 'expiresAt');
  }
  const grant = await storage.grants.create({
    id: newId('grt'),
    projectId: project.id,
    userId,
    label,
    credentialId,
    tools,
    accountIds,
    limits: checkLimits(input.limits, 'limits'),
    rateLimit: rateLimit === null ? null : { requests: rateLimit.requests, perSeconds: rateLimit.perSeconds },
    expiresAt,
  });
  return Object.freeze({ grant, warnings: Object.freeze(warnings) });
}
