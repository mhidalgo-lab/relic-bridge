// SPDX-License-Identifier: Apache-2.0
// What the P4-04 screens read from the admin API, parsed field by field: only the fields a page shows, with the types
// it expects (a wrong type becomes null, never a crash or a surprise in the markup). Key material is never part of an
// admin API answer; these parsers would not pick it up anyway.

type Row = Readonly<Record<string, unknown>>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) ? v : 0);
const intOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
const ints = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isSafeInteger(x)) : [];
const intsOrNull = (v: unknown): number[] | null => (Array.isArray(v) ? ints(v) : null);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const strsOrNull = (v: unknown): string[] | null => (Array.isArray(v) ? strs(v) : null);
const obj = (v: unknown): Row => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Row) : {});

export type Role = 'owner' | 'admin' | 'member';
export const ROLES: readonly Role[] = ['owner', 'admin', 'member'];
const role = (v: unknown): Role => (v === 'owner' || v === 'admin' ? v : 'member');

export interface User {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly idp: string | null;
  readonly role: Role;
  readonly createdAt: number;
  readonly disabledAt: number | null;
}

export function parseUser(r: Row): User | null {
  const id = str(r['id']);
  if (id === '') return null;
  return {
    id,
    email: str(r['email']),
    displayName: strOrNull(r['displayName']),
    idp: strOrNull(r['idp']),
    role: role(r['role']),
    createdAt: int(r['createdAt']),
    disabledAt: intOrNull(r['disabledAt']),
  };
}

export type Region = 'US' | 'EU' | 'JP';
export const REGIONS: readonly Region[] = ['US', 'EU', 'JP'];

export interface Credential {
  readonly id: string;
  readonly label: string;
  readonly region: string;
  readonly ownerUserId: string | null;
  /** Last 4 characters of the key; the only part of a key the UI ever has. */
  readonly keyHint: string | null;
  readonly keyStorage: string;
  readonly validationStatus: string;
  readonly validationErrorCode: string | null;
  readonly validatedAt: number | null;
  readonly nrUserEmail: string | null;
  readonly reachableAccountIds: number[] | null;
  readonly createdAt: number;
  readonly revokedAt: number | null;
}

export function parseCredential(r: Row): Credential | null {
  const id = str(r['id']);
  if (id === '') return null;
  return {
    id,
    label: str(r['label']),
    region: str(r['region']),
    ownerUserId: strOrNull(r['ownerUserId']),
    keyHint: strOrNull(r['keyHint']),
    keyStorage: str(r['keyStorage']),
    validationStatus: str(r['validationStatus']),
    validationErrorCode: strOrNull(r['validationErrorCode']),
    validatedAt: intOrNull(r['validatedAt']),
    nrUserEmail: strOrNull(r['nrUserEmail']),
    reachableAccountIds: intsOrNull(r['reachableAccountIds']),
    createdAt: int(r['createdAt']),
    revokedAt: intOrNull(r['revokedAt']),
  };
}

export interface Limits {
  readonly maxLimit?: number;
  readonly maxWindowDays?: number;
  readonly rawNrql?: boolean;
  readonly maxResponseBytes?: number;
  readonly eventTypes?: { readonly allow?: string[]; readonly deny?: string[] };
}

export function parseLimits(v: unknown): Limits {
  const r = obj(v);
  const out: {
    maxLimit?: number;
    maxWindowDays?: number;
    rawNrql?: boolean;
    maxResponseBytes?: number;
    eventTypes?: { allow?: string[]; deny?: string[] };
  } = {};
  for (const k of ['maxLimit', 'maxWindowDays', 'maxResponseBytes'] as const) {
    const n = intOrNull(r[k]);
    if (n !== null) out[k] = n;
  }
  if (typeof r['rawNrql'] === 'boolean') out.rawNrql = r['rawNrql'];
  if (r['eventTypes'] !== undefined) {
    const e = obj(r['eventTypes']);
    out.eventTypes = {
      ...(Array.isArray(e['allow']) ? { allow: strs(e['allow']) } : {}),
      ...(Array.isArray(e['deny']) ? { deny: strs(e['deny']) } : {}),
    };
  }
  return out;
}

export interface Project {
  readonly id: string;
  readonly slug: string;
  readonly name: string | null;
  readonly defaultAccountId: number;
  readonly allowedAccountIds: number[];
  /** null = every tool, including tools added later. */
  readonly enabledTools: string[] | null;
  readonly limits: Limits;
  readonly defaultCredentialId: string | null;
  readonly createdAt: number;
  readonly disabledAt: number | null;
}

export function parseProject(r: Row): Project | null {
  const id = str(r['id']);
  if (id === '') return null;
  return {
    id,
    slug: str(r['slug']),
    name: strOrNull(r['name']),
    defaultAccountId: int(r['defaultAccountId']),
    allowedAccountIds: ints(r['allowedAccountIds']),
    enabledTools: strsOrNull(r['enabledTools']),
    limits: parseLimits(r['limits']),
    defaultCredentialId: strOrNull(r['defaultCredentialId']),
    createdAt: int(r['createdAt']),
    disabledAt: intOrNull(r['disabledAt']),
  };
}

export interface Grant {
  readonly id: string;
  readonly projectId: string;
  readonly userId: string | null;
  readonly label: string | null;
  readonly credentialId: string | null;
  readonly tools: string[] | null;
  readonly accountIds: number[] | null;
  readonly rateLimit: { readonly requests: number; readonly perSeconds: number } | null;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
}

export function parseGrant(r: Row): Grant | null {
  const id = str(r['id']);
  if (id === '') return null;
  const rl = r['rateLimit'] === null || r['rateLimit'] === undefined ? null : obj(r['rateLimit']);
  return {
    id,
    projectId: str(r['projectId']),
    userId: strOrNull(r['userId']),
    label: strOrNull(r['label']),
    credentialId: strOrNull(r['credentialId']),
    tools: strsOrNull(r['tools']),
    accountIds: intsOrNull(r['accountIds']),
    rateLimit: rl === null ? null : { requests: int(rl['requests']), perSeconds: int(rl['perSeconds']) },
    createdAt: int(r['createdAt']),
    expiresAt: intOrNull(r['expiresAt']),
    revokedAt: intOrNull(r['revokedAt']),
  };
}

/** A grant of the signed-in member (`GET /me/grants`): the grant plus the project it is for. */
export interface MyGrant extends Grant {
  readonly project: {
    readonly slug: string;
    readonly name: string | null;
    readonly disabled: boolean;
  } | null;
}

export function parseMyGrant(r: Row): MyGrant | null {
  const grant = parseGrant(r);
  if (grant === null) return null;
  const p = r['project'] === null || r['project'] === undefined ? null : obj(r['project']);
  return {
    ...grant,
    project:
      p === null
        ? null
        : { slug: str(p['slug']), name: strOrNull(p['name']), disabled: p['disabled'] === true },
  };
}

export interface Token {
  readonly id: string;
  readonly grantId: string;
  /** First characters (`rb_live_Ab3d`), for recognition only. */
  readonly prefix: string;
  readonly label: string;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
}

export function parseToken(r: Row): Token | null {
  const id = str(r['id']);
  if (id === '') return null;
  return {
    id,
    grantId: str(r['grantId']),
    prefix: str(r['prefix']),
    label: str(r['label']),
    createdAt: int(r['createdAt']),
    expiresAt: intOrNull(r['expiresAt']),
    lastUsedAt: intOrNull(r['lastUsedAt']),
    revokedAt: intOrNull(r['revokedAt']),
  };
}

/** An app connected with OAuth (P5-05): one authorization, never token material. */
export interface OAuthDevice {
  readonly id: string;
  readonly userId: string;
  readonly clientId: string;
  /** Untrusted text from the client's registration: render escaped, never as a link. */
  readonly clientName: string | null;
  readonly clientKind: 'metadata_document' | 'dynamic';
  readonly clientHost: string | null;
  readonly label: string | null;
  readonly projectSlug: string | null;
  readonly grantId: string | null;
  readonly createdAt: number;
  readonly expiresAt: number | null;
}

export function parseOAuthDevice(r: Row): OAuthDevice | null {
  const id = str(r['id']);
  if (!/^oauth_[A-Za-z0-9_-]{16}$/.test(id)) return null;
  return {
    id,
    userId: str(r['userId']),
    clientId: str(r['clientId']),
    clientName: strOrNull(r['clientName']),
    clientKind: r['clientKind'] === 'metadata_document' ? 'metadata_document' : 'dynamic',
    clientHost: strOrNull(r['clientHost']),
    label: strOrNull(r['label']),
    projectSlug: strOrNull(r['projectSlug']),
    grantId: strOrNull(r['grantId']),
    createdAt: int(r['createdAt']),
    expiresAt: intOrNull(r['expiresAt']),
  };
}

/** An OAuth client (P5-08). The name is untrusted text: render escaped, never as a link. */
export interface OAuthClient {
  readonly id: string;
  readonly kind: 'metadata_document' | 'dynamic';
  readonly name: string | null;
  readonly host: string | null;
  readonly redirectHosts: string[];
  readonly registeredAt: number | null;
  readonly expiresAt: number | null;
}

export function parseOAuthClient(r: Row): OAuthClient | null {
  const id = str(r['id']);
  if (id === '' || id.length > 512) return null;
  return {
    id,
    kind: r['kind'] === 'metadata_document' ? 'metadata_document' : 'dynamic',
    name: strOrNull(r['name']),
    host: strOrNull(r['host']),
    redirectHosts: strs(r['redirectHosts']),
    registeredAt: intOrNull(r['registeredAt']),
    expiresAt: intOrNull(r['expiresAt']),
  };
}

/** Dynamic client registration state (P5-08). */
export interface OAuthRegistration {
  readonly enabled: boolean;
  readonly deployment: boolean;
  readonly setting: boolean;
}

export function parseOAuthRegistration(r: Row): OAuthRegistration | null {
  if (typeof r['enabled'] !== 'boolean' || typeof r['deployment'] !== 'boolean') return null;
  return { enabled: r['enabled'], deployment: r['deployment'], setting: r['setting'] !== false };
}

/** Result of removing a client. */
export interface OAuthClientRemoval {
  readonly devicesRevoked: number;
  readonly approvalsForgotten: number;
}

export function parseOAuthClientRemoval(r: Row): OAuthClientRemoval | null {
  return { devicesRevoked: int(r['devicesRevoked']), approvalsForgotten: int(r['approvalsForgotten']) };
}

/** `{ data: {...} }` of a single-resource answer. */
export function one<T>(body: unknown, parse: (r: Row) => T | null): T | null {
  const data = (body as { data?: unknown } | null)?.data;
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? parse(data as Row) : null;
}

export interface ListPage<T> {
  readonly rows: T[];
  readonly nextCursor: string | null;
}

const CURSOR_RE = /^[A-Za-z0-9_-]{1,200}$/;

/** `{ data: [...], nextCursor }` of a list answer; null when it is not one. */
export function listPage<T>(body: unknown, parse: (r: Row) => T | null): ListPage<T> | null {
  const b = body as { data?: unknown; nextCursor?: unknown } | null;
  if (!Array.isArray(b?.data)) return null;
  const rows = b.data.flatMap((r) => {
    const parsed = typeof r === 'object' && r !== null ? parse(r as Row) : null;
    return parsed === null ? [] : [parsed];
  });
  const next = typeof b.nextCursor === 'string' && CURSOR_RE.test(b.nextCursor) ? b.nextCursor : null;
  return { rows, nextCursor: next };
}

/** A `cursor` query value shaped like an admin API cursor (anything else: the first page). */
export const validCursor = (v: string | undefined): string | undefined =>
  v !== undefined && CURSOR_RE.test(v) ? v : undefined;

/** An id the admin API could know (anything else is a 404 without asking). */
export const isId = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v) && v !== '.' && v !== '..';

// ---------------------------------------------------------------------------------------------------------------
// Audit and usage (P4-05)
// ---------------------------------------------------------------------------------------------------------------

export type AuditStatus = 'ok' | 'error' | 'denied';

/** One audit row. Every string in it can be influenced by a caller (tool names, error codes, details): escape it. */
export interface AuditRow {
  readonly id: number;
  readonly ts: number;
  readonly kind: string;
  readonly action: string;
  readonly status: AuditStatus;
  readonly requestId: string | null;
  readonly userId: string | null;
  readonly grantId: string | null;
  readonly tokenId: string | null;
  readonly clientId: string | null;
  readonly keyId: string | null;
  readonly projectId: string | null;
  readonly accountIds: number[] | null;
  readonly nrql: string | null;
  readonly durationMs: number | null;
  readonly inspectedCount: number | null;
  readonly errorCode: string | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly details: Row | null;
}

export function parseAudit(r: Row): AuditRow | null {
  const id = r['id'];
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return null;
  const status = r['status'];
  return {
    id,
    ts: int(r['ts']),
    kind: str(r['kind']),
    action: str(r['action']),
    status: status === 'ok' || status === 'error' ? status : 'denied',
    requestId: strOrNull(r['requestId']),
    userId: strOrNull(r['userId']),
    grantId: strOrNull(r['grantId']),
    tokenId: strOrNull(r['tokenId']),
    clientId: strOrNull(r['clientId']),
    keyId: strOrNull(r['keyId']),
    projectId: strOrNull(r['projectId']),
    accountIds: intsOrNull(r['accountIds']),
    nrql: strOrNull(r['nrql']),
    durationMs: intOrNull(r['durationMs']),
    inspectedCount: intOrNull(r['inspectedCount']),
    errorCode: strOrNull(r['errorCode']),
    targetType: strOrNull(r['targetType']),
    targetId: strOrNull(r['targetId']),
    details: r['details'] === null || r['details'] === undefined ? null : obj(r['details']),
  };
}

/** One group of `GET /audit/stats`. */
export interface UsageRow {
  readonly key: string | null;
  readonly calls: number;
  readonly errors: number;
  readonly denied: number;
  readonly durationSumMs: number;
  readonly durationCount: number;
  readonly maxDurationMs: number | null;
  readonly inspectedCount: number;
}

export function parseUsage(r: Row): UsageRow | null {
  if (typeof r['calls'] !== 'number') return null;
  return {
    key: strOrNull(r['key']),
    calls: int(r['calls']),
    errors: int(r['errors']),
    denied: int(r['denied']),
    durationSumMs: int(r['durationSumMs']),
    durationCount: int(r['durationCount']),
    maxDurationMs: intOrNull(r['maxDurationMs']),
    inspectedCount: int(r['inspectedCount']),
  };
}
