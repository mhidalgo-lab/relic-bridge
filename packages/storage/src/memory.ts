// SPDX-License-Identifier: Apache-2.0
// In-memory adapter: the reference implementation of the `Storage` contract (tests, ephemeral servers). It enforces
// the same unique, referential and row rules as the SQL schema. State lives in the instance (THREAT_MODEL T21);
// records are copied in and out, so callers can't mutate stored rows.
import { auditStatsSql, utcDay } from './audit-stats.ts';
import { ConflictError, keyChangedError, NotFoundError } from './errors.ts';
import type {
  AccessTokenRecord,
  AccessTokensRepository,
  AuditEntry,
  AuditLogRepository,
  AuditQuery,
  AuditRecord,
  AuditStatsQuery,
  AuditStatsRow,
  CredentialRecord,
  CredentialsRepository,
  EncryptedKey,
  GrantRecord,
  GrantsRepository,
  JsonValue,
  KvListResult,
  KvPutOptions,
  KvRepository,
  ProjectRecord,
  ProjectsRepository,
  SettingsRepository,
  Storage,
  UserRecord,
  UsersRepository,
} from './types.ts';
import {
  checkEncryptedKey,
  checkGrantPrincipal,
  checkKeyHint,
  checkLimit,
  checkRegion,
  checkRole,
  checkTokenHash,
  checkTokenPrefix,
  kvExpiry,
  normalizeEmail,
} from './validate.ts';

export { kvExpiry };

export interface MemoryStorageOptions {
  /** Clock in epoch milliseconds (tests). */
  readonly now?: () => number;
}

/** Structured copy that keeps `Uint8Array`s and drops nothing else we store. */
function copy<T>(value: T): T {
  return structuredClone(value);
}

function freeze<T>(value: T): T {
  if (
    value !== null &&
    typeof value === 'object' &&
    !(value instanceof Uint8Array) &&
    !Object.isFrozen(value)
  ) {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}

const out = <T>(value: T): T => freeze(copy(value));

function copyKey(key: EncryptedKey): EncryptedKey {
  return {
    kind: 'encrypted',
    ciphertext: new Uint8Array(key.ciphertext),
    iv: new Uint8Array(key.iv),
    keyVersion: key.keyVersion,
  };
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);

function sameKey(stored: CredentialRecord['key'], expected: EncryptedKey): boolean {
  return (
    stored.kind === 'encrypted' &&
    stored.keyVersion === expected.keyVersion &&
    sameBytes(stored.iv, expected.iv) &&
    sameBytes(stored.ciphertext, expected.ciphertext)
  );
}

/** Apply only the keys present in `patch`. */
function merge<T extends object>(row: T, patch: object): T {
  const next = { ...row } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = copy(v);
  return next as T;
}

export const AUDIT_DEFAULT_LIMIT = 100;
export const AUDIT_MAX_LIMIT = 1000;
export const KV_MAX_LIST = 1000;

export function createMemoryStorage(options: MemoryStorageOptions = {}): Storage {
  const now = options.now ?? Date.now;
  const users = new Map<string, UserRecord>();
  const credentials = new Map<string, CredentialRecord>();
  const projects = new Map<string, ProjectRecord>();
  const grants = new Map<string, GrantRecord>();
  const tokens = new Map<string, AccessTokenRecord>();
  const audit: AuditRecord[] = [];
  let auditSeq = 0;
  const settings = new Map<string, string>();
  const kv = new Map<string, { value: string; expiresAt: number | null }>();

  const newId = (map: Map<string, unknown>, entity: string, id: string): void => {
    if (map.has(id)) throw new ConflictError(`${entity}.id`, `${entity} ${id} already exists`);
  };
  const mustExist = (map: Map<string, unknown>, entity: string, field: string, id: string | null): void => {
    if (id !== null && !map.has(id))
      throw new ConflictError(field, `${field} refers to an unknown ${entity}`);
  };

  // ------------------------------------------------------------------------------------------------- users
  const uniqueUser = (row: UserRecord): void => {
    for (const u of users.values()) {
      if (u.id === row.id) continue;
      if (u.email === row.email)
        throw new ConflictError('users.email', 'a user with this email already exists');
      if (
        row.idp !== null &&
        row.idpSubject !== null &&
        u.idp === row.idp &&
        u.idpSubject === row.idpSubject
      ) {
        throw new ConflictError('users.identity', 'a user with this identity already exists');
      }
    }
  };
  const usersRepo: UsersRepository = {
    async get(id) {
      const u = users.get(id);
      return u ? out(u) : null;
    },
    async getByEmail(email) {
      const e = normalizeEmail(email);
      for (const u of users.values()) if (u.email === e) return out(u);
      return null;
    },
    async getByIdentity(idp, idpSubject) {
      for (const u of users.values()) if (u.idp === idp && u.idpSubject === idpSubject) return out(u);
      return null;
    },
    async list() {
      return out([...users.values()]);
    },
    async create(input) {
      newId(users, 'user', input.id);
      const t = now();
      const row: UserRecord = {
        id: input.id,
        email: normalizeEmail(input.email),
        displayName: input.displayName ?? null,
        idp: input.idp ?? null,
        idpSubject: input.idpSubject ?? null,
        role: checkRole(input.role),
        createdAt: t,
        updatedAt: t,
        disabledAt: null,
      };
      uniqueUser(row);
      users.set(row.id, row);
      return out(row);
    },
    async update(id, patch) {
      const cur = users.get(id);
      if (!cur) throw new NotFoundError('user', id);
      const row = merge(cur, patch);
      const next: UserRecord = {
        ...row,
        email: normalizeEmail(row.email),
        role: checkRole(row.role),
        updatedAt: now(),
      };
      uniqueUser(next);
      users.set(id, next);
      return out(next);
    },
  };

  // ------------------------------------------------------------------------------------------- credentials
  const credentialsRepo: CredentialsRepository = {
    async get(id) {
      const c = credentials.get(id);
      return c ? out(c) : null;
    },
    async list(filter = {}) {
      return out(
        [...credentials.values()].filter(
          (c) => filter.ownerUserId === undefined || c.ownerUserId === filter.ownerUserId,
        ),
      );
    },
    async create(input) {
      newId(credentials, 'credential', input.id);
      checkEncryptedKey(input.key);
      checkKeyHint(input.keyHint);
      const ownerUserId = input.ownerUserId ?? null;
      mustExist(users, 'user', 'credentials.owner_user_id', ownerUserId);
      const t = now();
      const row: CredentialRecord = {
        id: input.id,
        ownerUserId,
        label: input.label,
        region: checkRegion(input.region),
        key: copyKey(input.key),
        keyHint: input.keyHint ?? null,
        validationStatus: 'unvalidated',
        validationErrorCode: null,
        validatedAt: null,
        nrUserId: null,
        nrUserEmail: null,
        reachableAccountIds: null,
        createdAt: t,
        updatedAt: t,
        revokedAt: null,
      };
      credentials.set(row.id, row);
      return out(row);
    },
    async update(id, patch) {
      const cur = credentials.get(id);
      if (!cur) throw new NotFoundError('credential', id);
      if (patch.ifKey !== undefined && !sameKey(cur.key, patch.ifKey)) throw keyChangedError(id);
      if (patch.key !== undefined) checkEncryptedKey(patch.key);
      if (patch.keyHint !== undefined) checkKeyHint(patch.keyHint);
      const v = patch.validation;
      const next: CredentialRecord = {
        ...cur,
        ...(patch.label === undefined ? {} : { label: patch.label }),
        ...(patch.key === undefined ? {} : { key: copyKey(patch.key) }),
        ...(patch.keyHint === undefined ? {} : { keyHint: patch.keyHint }),
        ...(patch.revokedAt === undefined ? {} : { revokedAt: patch.revokedAt }),
        ...(v === undefined
          ? {}
          : {
              validationStatus: v.validationStatus,
              validationErrorCode: v.validationErrorCode ?? null,
              validatedAt: v.validatedAt,
              ...(v.nrUserId === undefined ? {} : { nrUserId: v.nrUserId }),
              ...(v.nrUserEmail === undefined ? {} : { nrUserEmail: v.nrUserEmail }),
              ...(v.reachableAccountIds === undefined
                ? {}
                : {
                    reachableAccountIds: v.reachableAccountIds === null ? null : [...v.reachableAccountIds],
                  }),
            }),
        updatedAt: now(),
      };
      credentials.set(id, next);
      return out(next);
    },
    async delete(id) {
      if (!credentials.has(id)) throw new NotFoundError('credential', id);
      for (const p of projects.values()) {
        if (p.defaultCredentialId === id) {
          throw new ConflictError('projects.default_credential_id', 'credential is a project default');
        }
      }
      for (const g of grants.values()) {
        if (g.credentialId === id)
          throw new ConflictError('grants.credential_id', 'credential is used by a grant');
      }
      credentials.delete(id);
    },
  };

  // ---------------------------------------------------------------------------------------------- projects
  const uniqueSlug = (row: ProjectRecord): void => {
    for (const p of projects.values()) {
      if (p.id !== row.id && p.slug === row.slug) {
        throw new ConflictError('projects.slug', 'a project with this slug already exists');
      }
    }
  };
  const projectsRepo: ProjectsRepository = {
    async get(id) {
      const p = projects.get(id);
      return p ? out(p) : null;
    },
    async getBySlug(slug) {
      for (const p of projects.values()) if (p.slug === slug) return out(p);
      return null;
    },
    async list() {
      return out([...projects.values()]);
    },
    async create(input) {
      newId(projects, 'project', input.id);
      const defaultCredentialId = input.defaultCredentialId ?? null;
      mustExist(credentials, 'credential', 'projects.default_credential_id', defaultCredentialId);
      const t = now();
      const row: ProjectRecord = copy({
        id: input.id,
        slug: input.slug,
        name: input.name ?? null,
        defaultAccountId: input.defaultAccountId,
        allowedAccountIds: input.allowedAccountIds,
        enabledTools: input.enabledTools ?? null,
        limits: input.limits ?? {},
        defaultCredentialId,
        createdAt: t,
        updatedAt: t,
        disabledAt: null,
      });
      uniqueSlug(row);
      projects.set(row.id, row);
      return out(row);
    },
    async update(id, patch) {
      const cur = projects.get(id);
      if (!cur) throw new NotFoundError('project', id);
      const next: ProjectRecord = { ...merge(cur, patch), updatedAt: now() };
      mustExist(credentials, 'credential', 'projects.default_credential_id', next.defaultCredentialId);
      uniqueSlug(next);
      projects.set(id, next);
      return out(next);
    },
    async delete(id) {
      if (!projects.has(id)) throw new NotFoundError('project', id);
      for (const g of [...grants.values()]) if (g.projectId === id) deleteGrant(g.id);
      projects.delete(id);
    },
  };

  // ------------------------------------------------------------------------------------------------ grants
  const deleteGrant = (id: string): void => {
    for (const t of [...tokens.values()]) if (t.grantId === id) tokens.delete(t.id);
    grants.delete(id);
  };
  const checkGrantRefs = (g: GrantRecord): void => {
    mustExist(projects, 'project', 'grants.project_id', g.projectId);
    mustExist(users, 'user', 'grants.user_id', g.userId);
    mustExist(credentials, 'credential', 'grants.credential_id', g.credentialId);
    checkGrantPrincipal(g.userId, g.label);
  };
  const grantsRepo: GrantsRepository = {
    async get(id) {
      const g = grants.get(id);
      return g ? out(g) : null;
    },
    async list(filter = {}) {
      return out(
        [...grants.values()].filter(
          (g) =>
            (filter.projectId === undefined || g.projectId === filter.projectId) &&
            (filter.userId === undefined || g.userId === filter.userId),
        ),
      );
    },
    async create(input) {
      newId(grants, 'grant', input.id);
      const t = now();
      const row: GrantRecord = copy({
        id: input.id,
        projectId: input.projectId,
        userId: input.userId ?? null,
        label: input.label ?? null,
        credentialId: input.credentialId ?? null,
        tools: input.tools ?? null,
        accountIds: input.accountIds ?? null,
        limits: input.limits ?? {},
        rateLimit: input.rateLimit ?? null,
        createdAt: t,
        updatedAt: t,
        expiresAt: input.expiresAt ?? null,
        revokedAt: null,
      });
      checkGrantRefs(row);
      grants.set(row.id, row);
      return out(row);
    },
    async update(id, patch) {
      const cur = grants.get(id);
      if (!cur) throw new NotFoundError('grant', id);
      const next: GrantRecord = { ...merge(cur, patch), updatedAt: now() };
      checkGrantRefs(next);
      grants.set(id, next);
      return out(next);
    },
    async delete(id) {
      if (!grants.has(id)) throw new NotFoundError('grant', id);
      deleteGrant(id);
    },
  };

  // ------------------------------------------------------------------------------------------ access tokens
  const tokensRepo: AccessTokensRepository = {
    async get(id) {
      const t = tokens.get(id);
      return t ? out(t) : null;
    },
    async getByHash(tokenHash) {
      for (const t of tokens.values()) if (t.tokenHash === tokenHash) return out(t);
      return null;
    },
    async list(filter = {}) {
      return out(
        [...tokens.values()].filter((t) => filter.grantId === undefined || t.grantId === filter.grantId),
      );
    },
    async create(input) {
      newId(tokens, 'access token', input.id);
      checkTokenHash(input.tokenHash);
      checkTokenPrefix(input.prefix);
      mustExist(grants, 'grant', 'access_tokens.grant_id', input.grantId);
      for (const t of tokens.values()) {
        if (t.tokenHash === input.tokenHash)
          throw new ConflictError('access_tokens.token_hash', 'duplicate token');
      }
      const row: AccessTokenRecord = {
        id: input.id,
        grantId: input.grantId,
        prefix: input.prefix,
        tokenHash: input.tokenHash,
        label: input.label,
        createdAt: now(),
        expiresAt: input.expiresAt ?? null,
        lastUsedAt: null,
        revokedAt: null,
      };
      tokens.set(row.id, row);
      return out(row);
    },
    async markUsed(id, at) {
      const cur = tokens.get(id);
      if (!cur) throw new NotFoundError('access token', id);
      tokens.set(id, { ...cur, lastUsedAt: at });
    },
    async revoke(id, at) {
      const cur = tokens.get(id);
      if (!cur) throw new NotFoundError('access token', id);
      // First revocation wins: re-revoking keeps the original time.
      const next = { ...cur, revokedAt: cur.revokedAt ?? at };
      tokens.set(id, next);
      return out(next);
    },
  };

  // ------------------------------------------------------------------------------------------------ audit
  const auditRepo: AuditLogRepository = {
    async append(entry: AuditEntry) {
      auditSeq += 1;
      audit.push(
        copy({
          id: auditSeq,
          ts: entry.ts,
          kind: entry.kind,
          action: entry.action,
          status: entry.status,
          requestId: entry.requestId ?? null,
          userId: entry.userId ?? null,
          grantId: entry.grantId ?? null,
          tokenId: entry.tokenId ?? null,
          clientId: entry.clientId ?? null,
          keyId: entry.keyId ?? null,
          projectId: entry.projectId ?? null,
          accountIds: entry.accountIds ?? null,
          nrql: entry.nrql ?? null,
          durationMs: entry.durationMs ?? null,
          inspectedCount: entry.inspectedCount ?? null,
          errorCode: entry.errorCode ?? null,
          targetType: entry.targetType ?? null,
          targetId: entry.targetId ?? null,
          details: entry.details ?? null,
        }),
      );
    },
    async list(query: AuditQuery = {}) {
      checkLimit(query.limit, 'auditLog.limit');
      const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? AUDIT_DEFAULT_LIMIT)), AUDIT_MAX_LIMIT);
      const rows: AuditRecord[] = [];
      const slowest = query.order === 'slowest';
      for (let i = audit.length - 1; i >= 0 && (slowest || rows.length < limit); i--) {
        const r = audit[i] as AuditRecord;
        if (slowest && r.durationMs === null) continue;
        if (query.projectId !== undefined && r.projectId !== query.projectId) continue;
        if (query.userId !== undefined && r.userId !== query.userId) continue;
        if (query.grantId !== undefined && r.grantId !== query.grantId) continue;
        if (query.tokenId !== undefined && r.tokenId !== query.tokenId) continue;
        if (query.keyId !== undefined && r.keyId !== query.keyId) continue;
        if (query.passthrough === true && r.keyId === null) continue;
        if (query.kind !== undefined && r.kind !== query.kind) continue;
        if (query.action !== undefined && r.action !== query.action) continue;
        if (query.status !== undefined && r.status !== query.status) continue;
        if (query.since !== undefined && r.ts < query.since) continue;
        if (query.until !== undefined && r.ts >= query.until) continue;
        if (!slowest && query.beforeId !== undefined && r.id >= query.beforeId) continue;
        rows.push(r);
      }
      if (slowest)
        rows.sort((a, b) => (b.durationMs as number) - (a.durationMs as number) || b.id - a.id).splice(limit);
      return out(rows);
    },
    async stats(q: AuditStatsQuery) {
      const { params } = auditStatsSql(q); // same validation (window, group, limit) as the SQL adapters
      const limit = params.at(-1) as number;
      const groups = new Map<string | null, AuditStatsRow>();
      for (const r of audit) {
        if (r.kind !== 'tool_call' || r.ts < q.since || r.ts >= q.until) continue;
        if (q.projectId !== undefined && r.projectId !== q.projectId) continue;
        if (q.userId !== undefined && r.userId !== q.userId) continue;
        if (q.grantId !== undefined && r.grantId !== q.grantId) continue;
        if (q.tokenId !== undefined && r.tokenId !== q.tokenId) continue;
        if (q.action !== undefined && r.action !== q.action) continue;
        const key =
          q.groupBy === 'action'
            ? r.action
            : q.groupBy === 'project'
              ? r.projectId
              : q.groupBy === 'grant'
                ? r.grantId
                : q.groupBy === 'token'
                  ? r.tokenId
                  : utcDay(r.ts);
        const cur = groups.get(key);
        groups.set(key, {
          key,
          calls: (cur?.calls ?? 0) + 1,
          errors: (cur?.errors ?? 0) + (r.status === 'error' ? 1 : 0),
          denied: (cur?.denied ?? 0) + (r.status === 'denied' ? 1 : 0),
          durationSumMs: (cur?.durationSumMs ?? 0) + (r.durationMs ?? 0),
          durationCount: (cur?.durationCount ?? 0) + (r.durationMs === null ? 0 : 1),
          maxDurationMs:
            r.durationMs === null
              ? (cur?.maxDurationMs ?? null)
              : Math.max(cur?.maxDurationMs ?? 0, r.durationMs),
          inspectedCount: (cur?.inspectedCount ?? 0) + (r.inspectedCount ?? 0),
        });
      }
      // SQL orders a null key first (`ORDER BY k`) and the day newest first; mirror both.
      const cmp = (a: string | null, b: string | null) =>
        a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;
      const rows = [...groups.values()].sort((a, b) =>
        q.groupBy === 'day' ? cmp(b.key, a.key) : b.calls - a.calls || cmp(a.key, b.key),
      );
      return out(rows.slice(0, limit));
    },
    async purgeBefore(before, limit) {
      checkLimit(limit, 'auditLog.limit');
      const cap = limit ?? Number.POSITIVE_INFINITY;
      // Oldest first, like the SQL adapters (`ORDER BY ts`).
      const doomed = new Set(
        audit
          .filter((r) => r.ts < before)
          .sort((a, b) => a.ts - b.ts || a.id - b.id)
          .slice(0, cap),
      );
      if (doomed.size === 0) return 0;
      const keep = audit.filter((r) => !doomed.has(r));
      audit.splice(0, audit.length, ...keep);
      return doomed.size;
    },
  };

  // --------------------------------------------------------------------------------------------- settings
  const settingsRepo: SettingsRepository = {
    async get(key) {
      const v = settings.get(key);
      return v === undefined ? undefined : freeze(JSON.parse(v) as JsonValue);
    },
    async set(key, value) {
      settings.set(key, JSON.stringify(value));
    },
    async setIfAbsent(key, value) {
      if (settings.has(key)) return false;
      settings.set(key, JSON.stringify(value));
      return true;
    },
    async delete(key) {
      settings.delete(key);
    },
    async list() {
      const all: Record<string, JsonValue> = {};
      for (const [k, v] of settings) all[k] = JSON.parse(v) as JsonValue;
      return freeze(all);
    },
  };

  // --------------------------------------------------------------------------------------------------- kv
  const live = (key: string): { value: string; expiresAt: number | null } | undefined => {
    const e = kv.get(key);
    if (e === undefined) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= now()) {
      kv.delete(key);
      return undefined;
    }
    return e;
  };
  const kvRepo: KvRepository = {
    async get(key) {
      return live(key)?.value ?? null;
    },
    async put(key, value, opts: KvPutOptions = {}) {
      kv.set(key, { value, expiresAt: kvExpiry(opts, now()) });
    },
    async delete(key) {
      kv.delete(key);
    },
    async take(key) {
      const value = live(key)?.value ?? null;
      kv.delete(key);
      return value;
    },
    async list(opts = {}): Promise<KvListResult> {
      checkLimit(opts.limit, 'kv.limit');
      const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? KV_MAX_LIST)), KV_MAX_LIST);
      const prefix = opts.prefix ?? '';
      const after = opts.cursor === undefined ? undefined : decodeCursor(opts.cursor);
      const names = [...kv.keys()]
        .filter((k) => k.startsWith(prefix) && (after === undefined || k > after) && live(k) !== undefined)
        .sort();
      const page = names.slice(0, limit);
      const keys = page.map((name) => {
        const exp = kv.get(name)?.expiresAt ?? null;
        return exp === null ? { name } : { name, expiration: Math.floor(exp / 1000) };
      });
      const complete = names.length <= limit;
      const last = page.at(-1);
      return complete || last === undefined
        ? { keys, complete: true }
        : { keys, complete, cursor: encodeCursor(last) };
    },
  };

  return Object.freeze({
    kind: 'memory' as const,
    readOnly: false,
    users: usersRepo,
    credentials: credentialsRepo,
    projects: projectsRepo,
    grants: grantsRepo,
    accessTokens: tokensRepo,
    auditLog: auditRepo,
    settings: settingsRepo,
    kv: kvRepo,
    async close() {},
  });
}

/** Opaque list cursor (base64url of the last key). */
export function encodeCursor(key: string): string {
  const bytes = new TextEncoder().encode(key);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeCursor(cursor: string): string {
  try {
    const bin = atob(cursor.replaceAll('-', '+').replaceAll('_', '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return '';
  }
}
