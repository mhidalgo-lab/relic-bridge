// SPDX-License-Identifier: Apache-2.0
// Storage-backed access resolution: load the records a request needs, then hand them to the pure `computeAccess`.
import { type Credential, Secret } from '@relic-bridge/core';
import {
  type CredentialRecord,
  type GrantRecord,
  type ProjectRecord,
  SLUG_RE,
  type Storage,
  type UserRecord,
} from '@relic-bridge/storage';
import type { Keyring } from '../crypto/keyring.ts';
import { AccessError } from './errors.ts';
import {
  type AccessDecision,
  computeAccess,
  credentialIdFor,
  type DenyReason,
  type EffectiveAccess,
  type Principal,
} from './resolve.ts';

/** Longest grant id we look up; real ids are `grt_` + 32 hex characters. */
const MAX_ID_CHARS = 128;

export interface ResolveAccessInput {
  readonly storage: Pick<Storage, 'projects' | 'grants' | 'users' | 'credentials'>;
  /** From the request URL. Unknown or malformed slugs deny without telling them apart. */
  readonly projectSlug: string;
  readonly principal: Principal;
  readonly catalog: readonly string[];
  readonly now: number;
}

export type ResolvedAccess =
  | {
      readonly ok: true;
      readonly access: EffectiveAccess;
      /** The credential row, for `openCredential`. Holds ciphertext only (or a yaml reference). */
      readonly credential: CredentialRecord;
    }
  | { readonly ok: false; readonly reason: DenyReason };

/**
 * Resolve a request's effective access from storage (at most five reads, three round trips). Storage errors propagate:
 * the caller must treat them as a denial (fail closed), never as "no restriction".
 */
export async function resolveAccess(input: ResolveAccessInput): Promise<ResolvedAccess> {
  const { storage, projectSlug, principal } = input;
  if (typeof projectSlug !== 'string' || !SLUG_RE.test(projectSlug))
    return { ok: false, reason: 'project_not_found' };
  const grantId = principal?.grantId;
  if (typeof grantId !== 'string' || grantId === '' || grantId.length > MAX_ID_CHARS) {
    return { ok: false, reason: 'invalid_request' };
  }
  const [project, grant] = await Promise.all([
    storage.projects.getBySlug(projectSlug),
    storage.grants.get(grantId),
  ]);
  if (project === null) return { ok: false, reason: 'project_not_found' };
  if (grant === null) return { ok: false, reason: 'grant_not_found' };
  // Don't read anything else for a grant of another project (T2).
  if (grant.projectId !== project.id) return { ok: false, reason: 'grant_wrong_project' };

  const credentialId = credentialIdFor(project, grant);
  const [user, credential] = await Promise.all([
    grant.userId === null ? Promise.resolve(null) : storage.users.get(grant.userId),
    credentialId === null ? Promise.resolve(null) : storage.credentials.get(credentialId),
  ]);
  // A third read only for a key owned by someone other than the grant's user (team default or shared-by-owner key).
  const ownerId = credential?.ownerUserId ?? null;
  const credentialOwner =
    ownerId === null || ownerId === grant.userId ? undefined : await storage.users.get(ownerId);
  const decision = computeAccess({
    ...input,
    project,
    grant,
    user,
    credential,
    ...(credentialOwner === undefined ? {} : { credentialOwner }),
  });
  if (!decision.ok) return decision;
  // computeAccess denies when the credential is missing; this narrows the type.
  if (credential === null) return { ok: false, reason: 'credential_not_found' };
  return { ok: true, access: decision.access, credential };
}

export interface OpenCredentialOptions {
  /** Needed for `encrypted` key material (SQL storage). */
  readonly keyring?: Keyring;
  /** Needed for `env` key references (yaml storage). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The core `Credential` for a request's `ToolContext`: the resolved credential with its key decrypted into a
 * `Secret`. Refuses a record that is not the one access was resolved for.
 */
export async function openCredential(
  access: EffectiveAccess,
  record: CredentialRecord,
  options: OpenCredentialOptions,
): Promise<Credential> {
  if (record.id !== access.credential.id || record.region !== access.credential.region) {
    throw new AccessError('invalid_input', 'credential does not match the resolved access', 'credential');
  }
  let apiKey: Secret;
  const key = record.key;
  if (key.kind === 'encrypted') {
    if (options.keyring === undefined) {
      throw new AccessError('invalid_input', `credential ${record.id} needs the master key`, 'keyring');
    }
    apiKey = await options.keyring.decryptCredentialKey(record.id, key);
  } else if (key.kind === 'env') {
    const value = options.env?.[key.variable]?.trim() ?? '';
    if (value === '') {
      throw new AccessError('not_found', `credential ${record.id}: ${key.variable} is not set`, 'credential');
    }
    apiKey = new Secret(value);
  } else {
    apiKey = new Secret(key.reveal().trim());
  }
  return Object.freeze({ id: record.id, region: record.region, apiKey });
}

export interface EffectivePermission {
  readonly grant: GrantRecord;
  readonly projectSlug: string | null;
  readonly decision: AccessDecision;
}

/**
 * Every grant (optionally of one project or user) with what it currently resolves to, for the admin API and CLI.
 * Uses the same pure resolver as requests, as if the grant's own user were asking.
 */
export async function listEffectivePermissions(input: {
  readonly storage: Pick<Storage, 'projects' | 'grants' | 'users' | 'credentials'>;
  readonly filter?: { readonly projectId?: string; readonly userId?: string };
  readonly catalog: readonly string[];
  readonly now: number;
}): Promise<readonly EffectivePermission[]> {
  const { storage, catalog, now } = input;
  const [grants, projects, users, credentials] = await Promise.all([
    storage.grants.list(input.filter ?? {}),
    storage.projects.list(),
    storage.users.list(),
    storage.credentials.list(),
  ]);
  const byId = <T extends { readonly id: string }>(rows: readonly T[]): Map<string, T> =>
    new Map(rows.map((r) => [r.id, r]));
  const projectsById = byId<ProjectRecord>(projects);
  const usersById = byId<UserRecord>(users);
  const credentialsById = byId<CredentialRecord>(credentials);
  return grants.map((grant) => {
    const project = projectsById.get(grant.projectId) ?? null;
    const credentialId = project === null ? null : credentialIdFor(project, grant);
    const credential = credentialId === null ? null : (credentialsById.get(credentialId) ?? null);
    const decision = computeAccess({
      principal: { grantId: grant.id },
      project,
      grant,
      user: grant.userId === null ? null : (usersById.get(grant.userId) ?? null),
      credential,
      ...(credential?.ownerUserId == null || credential.ownerUserId === grant.userId
        ? {}
        : { credentialOwner: usersById.get(credential.ownerUserId) ?? null }),
      catalog,
      now,
    });
    return Object.freeze({ grant, projectSlug: project?.slug ?? null, decision });
  });
}
