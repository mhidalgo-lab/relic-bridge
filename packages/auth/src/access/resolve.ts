// SPDX-License-Identifier: Apache-2.0
// The effective-permission resolver (ADR-0008, ARCHITECTURE §4, THREAT_MODEL T2/T3). Pure: no I/O, no clock, no
// module state. Everything it needs is passed in, and anything it can't vouch for is a denial (deny by default).
import {
  type AccountScope,
  DEFAULT_LIMITS,
  type QueryLimits,
  RAW_NRQL_TOOLS,
  type Region,
  WRITE_TOOL_NAMES,
} from '@relic-bridge/core';
import {
  type CredentialRecord,
  cloneQuota,
  type GrantRecord,
  isStoredQuota,
  limitsSchema,
  NR_REGIONS,
  type ProjectRecord,
  type StoredLimits,
  type StoredQuota,
  type StoredRateLimit,
  type UserRecord,
} from '@relic-bridge/storage';

/** Who is asking. Comes from an authenticated token or OAuth session (P2-05, P5), never from the client's input. */
export interface Principal {
  /** The grant the token/session is bound to. */
  readonly grantId: string;
  /**
   * The user the session belongs to, when the authenticator knows it (OAuth, admin sessions). When given it must be
   * the grant's user; a service grant never matches a user principal.
   */
  readonly userId?: string;
}

/**
 * Why access was denied. Stable values for logs and the audit log only: HTTP answers every one of them with the same
 * generic 401/403 so slugs, grants and credentials can't be enumerated (P2-06).
 */
export type DenyReason =
  | 'invalid_request'
  | 'project_not_found'
  | 'project_disabled'
  | 'grant_not_found'
  | 'grant_wrong_project'
  | 'grant_revoked'
  | 'grant_expired'
  | 'principal_mismatch'
  | 'user_not_found'
  | 'user_disabled'
  | 'credential_missing'
  | 'credential_not_found'
  | 'credential_revoked'
  | 'credential_invalid'
  | 'credential_unvalidated'
  | 'credential_not_permitted'
  | 'credential_owner_disabled'
  | 'invalid_config'
  | 'no_tools'
  | 'no_accounts';

export const DENY_REASONS: readonly DenyReason[] = Object.freeze([
  'invalid_request',
  'project_not_found',
  'project_disabled',
  'grant_not_found',
  'grant_wrong_project',
  'grant_revoked',
  'grant_expired',
  'principal_mismatch',
  'user_not_found',
  'user_disabled',
  'credential_missing',
  'credential_not_found',
  'credential_revoked',
  'credential_invalid',
  'credential_unvalidated',
  'credential_not_permitted',
  'credential_owner_disabled',
  'invalid_config',
  'no_tools',
  'no_accounts',
] as const);

/** What a request may do. Everything here is already the intersection of project, grant and credential. */
export interface EffectiveAccess {
  readonly projectId: string;
  readonly projectSlug: string;
  readonly grantId: string;
  /** Null for service grants. */
  readonly userId: string | null;
  /** Which stored credential to use. The key itself is decrypted separately (`openCredential`). */
  readonly credential: { readonly id: string; readonly region: Region };
  /** Tool names, in catalog order. Never empty. Register only these (hidden, not just refused). */
  readonly tools: readonly string[];
  /** Never empty; `default` is one of `allowed`. */
  readonly accounts: AccountScope;
  readonly limits: QueryLimits;
  readonly rateLimit: StoredRateLimit | null;
  /** The grant's usage caps (P7-12); null = unlimited. */
  readonly quota: StoredQuota | null;
  /** The grant's expiry, so a cache of this result can expire with it (P2-06). */
  readonly expiresAt: number | null;
}

export type AccessDecision =
  | { readonly ok: true; readonly access: EffectiveAccess }
  | { readonly ok: false; readonly reason: DenyReason };

export interface ComputeAccessInput {
  readonly principal: Principal;
  /** The project addressed by the request URL (`/p/{slug}/mcp`); null when the slug is unknown. */
  readonly project: ProjectRecord | null;
  readonly grant: GrantRecord | null;
  /** The grant's user (null for service grants or when not found). */
  readonly user: UserRecord | null;
  /** The credential the grant resolves to (`grant.credentialId ?? project.defaultCredentialId`), null if not found. */
  readonly credential: CredentialRecord | null;
  /**
   * The credential's owner when it is not the grant's user (null when not found; omit when the credential has no
   * owner or the grant's user owns it). A disabled or deleted owner's key stops working for every grant.
   */
  readonly credentialOwner?: UserRecord | null;
  /** Every tool this build can serve (built-in read-only tools). Names outside it are never granted. */
  readonly catalog: readonly string[];
  /** Epoch milliseconds. */
  readonly now: number;
}

/** A frozen copy of a valid quota (a cached access result is shared between requests). */
function freezeQuota(q: StoredQuota): StoredQuota {
  const c = cloneQuota(q);
  if (c.day !== undefined) Object.freeze(c.day);
  if (c.month !== undefined) Object.freeze(c.month);
  return Object.freeze(c);
}

const deny = (reason: DenyReason): AccessDecision => Object.freeze({ ok: false as const, reason });

const isPositiveInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isStringArray = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const isRateLimit = (v: StoredRateLimit): boolean =>
  typeof v === 'object' && isPositiveInt(v.requests) && isPositiveInt(v.perSeconds);
const isAccountArray = (v: unknown): v is readonly number[] => Array.isArray(v) && v.every(isPositiveInt);

/** Which credential a grant runs with: its own, else the project's default. */
export function credentialIdFor(project: ProjectRecord, grant: GrantRecord): string | null {
  return grant.credentialId ?? project.defaultCredentialId ?? null;
}

/**
 * Whether `grant` may use `credential` (the pattern behind "bring your own key"): the project's default credential,
 * a credential without an owner (shared, set up by an admin), or one the grant's own user owns. A grant pointing at
 * someone else's personal key is refused, also at grant creation.
 */
export function credentialPermitted(
  project: ProjectRecord,
  grant: Pick<GrantRecord, 'credentialId' | 'userId'>,
  credential: Pick<CredentialRecord, 'id' | 'ownerUserId'>,
): boolean {
  if (grant.credentialId === null || grant.credentialId === project.defaultCredentialId) return true;
  return credential.ownerUserId === null || credential.ownerUserId === grant.userId;
}

/** Stored limit overrides → full limits, over `DEFAULT_LIMITS`. Null when the stored value is not valid. */
export function limitsFrom(stored: StoredLimits): QueryLimits | null {
  const parsed = limitsSchema.safeParse(stored);
  if (!parsed.success) return null;
  const s = parsed.data;
  return freezeLimits({
    maxLimit: s.maxLimit ?? DEFAULT_LIMITS.maxLimit,
    maxWindowDays: s.maxWindowDays ?? DEFAULT_LIMITS.maxWindowDays,
    rawNrql: s.rawNrql ?? DEFAULT_LIMITS.rawNrql,
    maxResponseBytes: s.maxResponseBytes ?? DEFAULT_LIMITS.maxResponseBytes,
    eventTypes: {
      ...(s.eventTypes?.allow === undefined ? {} : { allow: s.eventTypes.allow }),
      ...(s.eventTypes?.deny === undefined ? {} : { deny: s.eventTypes.deny }),
    },
  });
}

/**
 * Tighten `base` with a grant's overrides: the smaller number wins, raw NRQL needs both, event-type allow lists are
 * intersected (exact match, as NRQL event types are case-sensitive) and deny lists united. The result is never looser
 * than `base` in any field. Null when the stored value is not valid.
 */
export function tightenLimits(base: QueryLimits, stored: StoredLimits): QueryLimits | null {
  const parsed = limitsSchema.safeParse(stored);
  if (!parsed.success) return null;
  const g = parsed.data;
  const pAllow = base.eventTypes.allow;
  const gAllow = g.eventTypes?.allow;
  let allow: readonly string[] | undefined;
  if (pAllow !== undefined && gAllow !== undefined) allow = pAllow.filter((e) => gAllow.includes(e));
  else allow = pAllow ?? gAllow;
  const pDeny = base.eventTypes.deny;
  const gDeny = g.eventTypes?.deny;
  const deny =
    pDeny === undefined && gDeny === undefined
      ? undefined
      : [...new Set([...(pDeny ?? []), ...(gDeny ?? [])])];
  return freezeLimits({
    maxLimit: Math.min(base.maxLimit, g.maxLimit ?? base.maxLimit),
    maxWindowDays: Math.min(base.maxWindowDays, g.maxWindowDays ?? base.maxWindowDays),
    rawNrql: base.rawNrql && (g.rawNrql ?? true),
    maxResponseBytes: Math.min(base.maxResponseBytes, g.maxResponseBytes ?? base.maxResponseBytes),
    eventTypes: {
      ...(allow === undefined ? {} : { allow: [...new Set(allow)] }),
      ...(deny === undefined ? {} : { deny }),
    },
  });
}

function freezeLimits(l: QueryLimits): QueryLimits {
  return Object.freeze({
    ...l,
    eventTypes: Object.freeze({
      ...(l.eventTypes.allow === undefined ? {} : { allow: Object.freeze([...l.eventTypes.allow]) }),
      ...(l.eventTypes.deny === undefined ? {} : { deny: Object.freeze([...l.eventTypes.deny]) }),
    }),
  });
}

/**
 * Compute what a request may do (ARCHITECTURE §4):
 *
 * ```
 * tools    = catalog ∩ (project.enabledTools ?? catalog) ∩ (grant.tools ?? all), minus raw-NRQL tools if rawNrql is off;
 *            a write tool (P7-09) only when the project AND the grant name it explicitly (never through `null`) and the
 *            key is shared or the grant user's own (ADR-0015)
 * accounts = credential.reachableAccounts ∩ project.allowedAccounts ∩ (grant.accounts ?? all)
 * limits   = project limits tightened by grant limits
 * key      = grant.credential ?? project.defaultCredential
 * ```
 *
 * Any missing, disabled, revoked, expired, unvalidated or inconsistent piece denies. Pure and deterministic.
 */
export function computeAccess(input: ComputeAccessInput): AccessDecision {
  const { principal, project, grant, user, credential, catalog, now } = input;
  if (
    principal === null ||
    typeof principal !== 'object' ||
    typeof principal.grantId !== 'string' ||
    principal.grantId === '' ||
    (principal.userId !== undefined && (typeof principal.userId !== 'string' || principal.userId === '')) ||
    !Number.isFinite(now) ||
    !isStringArray(catalog)
  ) {
    return deny('invalid_request');
  }

  // Project
  if (project === null) return deny('project_not_found');
  if (project.disabledAt !== null) return deny('project_disabled');

  // Grant: bound to this project, live.
  if (grant === null || grant.id !== principal.grantId) return deny('grant_not_found');
  if (grant.projectId !== project.id) return deny('grant_wrong_project');
  if (grant.revokedAt !== null) return deny('grant_revoked');
  if (grant.expiresAt !== null && !(now < grant.expiresAt)) return deny('grant_expired');

  // Principal and user
  if (principal.userId !== undefined && principal.userId !== grant.userId) return deny('principal_mismatch');
  if (grant.userId !== null) {
    if (user === null || user.id !== grant.userId) return deny('user_not_found');
    if (user.disabledAt !== null) return deny('user_disabled');
  } else if (grant.label === null || grant.label.trim() === '') {
    // A grant with neither a user nor a label breaks the storage rule: refuse rather than guess.
    return deny('invalid_config');
  }

  // Credential
  const credentialId = credentialIdFor(project, grant);
  if (credentialId === null) return deny('credential_missing');
  if (credential === null || credential.id !== credentialId) return deny('credential_not_found');
  if (credential.revokedAt !== null) return deny('credential_revoked');
  if (credential.validationStatus === 'invalid') return deny('credential_invalid');
  if (credential.validationStatus !== 'valid' || credential.reachableAccountIds === null) {
    return deny('credential_unvalidated');
  }
  if (!credentialPermitted(project, grant, credential)) return deny('credential_not_permitted');
  if (credential.ownerUserId !== null) {
    const owner = credential.ownerUserId === grant.userId ? user : (input.credentialOwner ?? null);
    if (owner === null || owner.id !== credential.ownerUserId || owner.disabledAt !== null) {
      return deny('credential_owner_disabled');
    }
  }
  if (!(NR_REGIONS as readonly string[]).includes(credential.region)) return deny('invalid_config');

  // Stored shapes (JSON columns) are checked, never trusted.
  if (
    !isAccountArray(project.allowedAccountIds) ||
    !isPositiveInt(project.defaultAccountId) ||
    (project.enabledTools !== null && !isStringArray(project.enabledTools)) ||
    (grant.tools !== null && !isStringArray(grant.tools)) ||
    (grant.accountIds !== null && !isAccountArray(grant.accountIds)) ||
    !isAccountArray(credential.reachableAccountIds) ||
    (grant.rateLimit !== null && !isRateLimit(grant.rateLimit)) ||
    (grant.quota !== null && !isStoredQuota(grant.quota))
  ) {
    return deny('invalid_config');
  }

  // Limits: project over defaults, tightened by the grant.
  const projectLimits = limitsFrom(project.limits);
  if (projectLimits === null) return deny('invalid_config');
  const limits = tightenLimits(projectLimits, grant.limits);
  if (limits === null) return deny('invalid_config');

  // Tools
  const projectTools = project.enabledTools;
  const grantTools = grant.tools;
  // Writes act in New Relic as the key's user: never with somebody else's personal key (e.g. an owner's key that is a
  // project default), whoever administers the grant.
  const writeKey = credential.ownerUserId === null || credential.ownerUserId === grant.userId;
  const tools = [...new Set(catalog)].filter((name) =>
    WRITE_TOOL_NAMES.includes(name)
      ? // Explicit names only: `null` ("every tool") never implies a write tool.
        writeKey && projectTools?.includes(name) === true && grantTools?.includes(name) === true
      : (projectTools === null || projectTools.includes(name)) &&
        (grantTools === null || grantTools.includes(name)) &&
        (limits.rawNrql || !RAW_NRQL_TOOLS.includes(name)),
  );
  if (tools.length === 0) return deny('no_tools');

  // Accounts, in project order.
  const reachable = credential.reachableAccountIds;
  const grantAccounts = grant.accountIds;
  const allowed = [...new Set(project.allowedAccountIds)].filter(
    (id) => reachable.includes(id) && (grantAccounts === null || grantAccounts.includes(id)),
  );
  const first = allowed[0];
  if (first === undefined) return deny('no_accounts');
  const defaultAccount = allowed.includes(project.defaultAccountId) ? project.defaultAccountId : first;

  const access: EffectiveAccess = Object.freeze({
    projectId: project.id,
    projectSlug: project.slug,
    grantId: grant.id,
    userId: grant.userId,
    credential: Object.freeze({ id: credential.id, region: credential.region }),
    tools: Object.freeze(tools),
    accounts: Object.freeze({ allowed: Object.freeze(allowed), default: defaultAccount }),
    limits,
    rateLimit: grant.rateLimit === null ? null : Object.freeze({ ...grant.rateLimit }),
    quota: grant.quota === null ? null : freezeQuota(grant.quota),
    expiresAt: grant.expiresAt,
  });
  return Object.freeze({ ok: true as const, access });
}
