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
