// SPDX-License-Identifier: Apache-2.0
// The repositories on top of a synchronous `node:sqlite` handle. Every value is a bound parameter. The driver is
// synchronous, so a method body runs without interleaving with other callers in this process; each write is a single statement
// (cascades happen inside the engine), so it is atomic on its own.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  ACCESS_RECORDS_FIELDS,
  ACCESS_RECORDS_SQL,
  type AccessRecords,
  type AccessRecordsQuery,
  type AccessTokenRecord,
  type AccessTokensRepository,
  type AuditEntry,
  type AuditLogRepository,
  type AuditQuery,
  type AuditRecord,
  accessRecordsParams,
  type CredentialRecord,
  type CredentialsRepository,
  checkEncryptedKey,
  checkGrantPrincipal,
  checkKeyHint,
  checkRegion,
  checkRole,
  checkTokenHash,
  checkTokenPrefix,
  type EncryptedKey,
  type GrantRecord,
  type GrantsRepository,
  type JsonValue,
  type KvListResult,
  type KvPutOptions,
  type KvRepository,
  keyChangedError,
  NO_ACCESS_RECORDS,
  NotFoundError,
  normalizeEmail,
  type ProjectRecord,
  type ProjectsRepository,
  type SettingsRepository,
  type Storage,
  type UserRecord,
  type UsersRepository,
} from '@relic-bridge/storage';
import { mapSqliteError } from './errors.ts';

type Row = Record<string, unknown>;
type Params = SQLInputValue[];

const AUDIT_DEFAULT_LIMIT = 100;
const AUDIT_MAX_LIMIT = 1000;
const KV_MAX_LIST = 1000;

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

const str = (v: unknown): string => v as string;
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : (v as string));
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const jsonOrNull = <T>(v: unknown): T | null =>
  v === null || v === undefined ? null : (JSON.parse(v as string) as T);
const toJson = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));
const copyBytes = (v: unknown): Uint8Array => new Uint8Array(v as Uint8Array);

/** Merge a patch: only keys present (and not `undefined`) apply. */
function merge<T extends object>(row: T, patch: object): T {
  const next = { ...row } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v;
  return next as T;
}

export function createRepositories(
  db: DatabaseSync,
  now: () => number,
): Omit<Storage, 'kind' | 'readOnly' | 'close'> {
  const all = (sql: string, params: Params = []): Row[] => db.prepare(sql).all(...params) as Row[];
  const one = (sql: string, params: Params = []): Row | null =>
    (db.prepare(sql).get(...params) as Row | undefined) ?? null;
  const run = (sql: string, params: Params = []): number => Number(db.prepare(sql).run(...params).changes);

  /** Runs `fn` as a promise: engine errors become storage errors. */
  const call = <T>(fn: () => T): Promise<T> => {
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(mapSqliteError(error));
    }
  };

  // ------------------------------------------------------------------------------------------------- users
  const userOf = (r: Row): UserRecord =>
    freeze({
      id: str(r['id']),
      email: str(r['email']),
      displayName: strOrNull(r['display_name']),
      idp: strOrNull(r['idp']),
      idpSubject: strOrNull(r['idp_subject']),
      role: checkRole(str(r['role'])),
      createdAt: num(r['created_at']),
      updatedAt: num(r['updated_at']),
      disabledAt: numOrNull(r['disabled_at']),
    });
  const getUser = (id: string): UserRecord | null => {
    const r = one('SELECT * FROM users WHERE id = ?', [id]);
    return r ? userOf(r) : null;
  };
  const writeUser = (u: UserRecord): void => {
    run(
      'UPDATE users SET email = ?, display_name = ?, idp = ?, idp_subject = ?, role = ?, updated_at = ?, disabled_at = ? WHERE id = ?',
      [u.email, u.displayName, u.idp, u.idpSubject, u.role, u.updatedAt, u.disabledAt, u.id],
    );
  };
  const usersRepo: UsersRepository = {
    get: (id) => call(() => getUser(id)),
    getByEmail: (email) =>
      call(() => {
        const r = one('SELECT * FROM users WHERE email = ?', [normalizeEmail(email)]);
        return r ? userOf(r) : null;
      }),
    getByIdentity: (idp, idpSubject) =>
      call(() => {
        const r = one('SELECT * FROM users WHERE idp = ? AND idp_subject = ?', [idp, idpSubject]);
        return r ? userOf(r) : null;
      }),
    list: () => call(() => freeze(all('SELECT * FROM users ORDER BY rowid').map(userOf))),
    create: (input) =>
      call(() => {
        const t = now();
        const role = checkRole(input.role);
        run(
          'INSERT INTO users (id, email, display_name, idp, idp_subject, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            input.id,
            normalizeEmail(input.email),
            input.displayName ?? null,
            input.idp ?? null,
            input.idpSubject ?? null,
            role,
            t,
            t,
          ],
        );
        return getUser(input.id) as UserRecord;
      }),
    update: (id, patch) =>
      call(() => {
        const cur = getUser(id);
        if (!cur) throw new NotFoundError('user', id);
        const row = merge(cur, patch);
        const next: UserRecord = {
          ...row,
          email: normalizeEmail(row.email),
          role: checkRole(row.role),
          updatedAt: now(),
        };
        writeUser(next);
        return freeze(next);
      }),
  };

  // ------------------------------------------------------------------------------------------- credentials
  const credentialOf = (r: Row): CredentialRecord =>
    freeze({
      id: str(r['id']),
      ownerUserId: strOrNull(r['owner_user_id']),
      label: str(r['label']),
      region: checkRegion(str(r['region'])),
      key: {
        kind: 'encrypted' as const,
        ciphertext: copyBytes(r['key_ciphertext']),
        iv: copyBytes(r['key_iv']),
        keyVersion: num(r['key_version']),
      },
      keyHint: strOrNull(r['key_hint']),
      validationStatus: str(r['validation_status']) as CredentialRecord['validationStatus'],
      validationErrorCode: strOrNull(r['validation_error_code']),
      validatedAt: numOrNull(r['validated_at']),
      nrUserId: numOrNull(r['nr_user_id']),
      nrUserEmail: strOrNull(r['nr_user_email']),
      reachableAccountIds: jsonOrNull<number[]>(r['reachable_account_ids']),
      createdAt: num(r['created_at']),
      updatedAt: num(r['updated_at']),
      revokedAt: numOrNull(r['revoked_at']),
    });
  const getCredential = (id: string): CredentialRecord | null => {
    const r = one('SELECT * FROM credentials WHERE id = ?', [id]);
    return r ? credentialOf(r) : null;
  };
  const encKey = (k: EncryptedKey): { c: Uint8Array; iv: Uint8Array; v: number } => ({
    c: new Uint8Array(k.ciphertext),
    iv: new Uint8Array(k.iv),
    v: k.keyVersion,
  });
  const credentialsRepo: CredentialsRepository = {
    get: (id) => call(() => getCredential(id)),
    list: (filter = {}) =>
      call(() =>
        freeze(
          (filter.ownerUserId === undefined
            ? all('SELECT * FROM credentials ORDER BY rowid')
            : all('SELECT * FROM credentials WHERE owner_user_id = ? ORDER BY rowid', [filter.ownerUserId])
          ).map(credentialOf),
        ),
      ),
    create: (input) =>
      call(() => {
        checkEncryptedKey(input.key);
        checkKeyHint(input.keyHint);
        const region = checkRegion(input.region);
        const k = encKey(input.key);
        const t = now();
        run(
          'INSERT INTO credentials (id, owner_user_id, label, region, key_ciphertext, key_iv, key_version, key_hint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            input.id,
            input.ownerUserId ?? null,
            input.label,
            region,
            k.c,
            k.iv,
            k.v,
            input.keyHint ?? null,
            t,
            t,
          ],
        );
        return getCredential(input.id) as CredentialRecord;
      }),
    update: (id, patch) =>
      call(() => {
        const cur = getCredential(id);
        if (!cur) throw new NotFoundError('credential', id);
        if (patch.key !== undefined) checkEncryptedKey(patch.key);
        if (patch.keyHint !== undefined) checkKeyHint(patch.keyHint);
        const v = patch.validation;
        const key = patch.key === undefined ? (cur.key as EncryptedKey) : patch.key;
        const k = encKey(key);
        const next = {
          label: patch.label ?? cur.label,
          keyHint: patch.keyHint === undefined ? cur.keyHint : patch.keyHint,
          revokedAt: patch.revokedAt === undefined ? cur.revokedAt : patch.revokedAt,
          validationStatus: v === undefined ? cur.validationStatus : v.validationStatus,
          validationErrorCode: v === undefined ? cur.validationErrorCode : (v.validationErrorCode ?? null),
          validatedAt: v === undefined ? cur.validatedAt : v.validatedAt,
          nrUserId: v?.nrUserId === undefined ? cur.nrUserId : v.nrUserId,
          nrUserEmail: v?.nrUserEmail === undefined ? cur.nrUserEmail : v.nrUserEmail,
          reachable: v?.reachableAccountIds === undefined ? cur.reachableAccountIds : v.reachableAccountIds,
        };
        // `ifKey` is checked in the UPDATE itself, so it holds against other connections too (compare-and-swap).
        const guard = patch.ifKey === undefined ? null : encKey(patch.ifKey);
        const changed = run(
          `UPDATE credentials SET label = ?, key_ciphertext = ?, key_iv = ?, key_version = ?, key_hint = ?, validation_status = ?, validation_error_code = ?, validated_at = ?, nr_user_id = ?, nr_user_email = ?, reachable_account_ids = ?, updated_at = ?, revoked_at = ? WHERE id = ?${guard === null ? '' : ' AND key_ciphertext = ? AND key_iv = ? AND key_version = ?'}`,
          [
            next.label,
            k.c,
            k.iv,
            k.v,
            next.keyHint,
            next.validationStatus,
            next.validationErrorCode,
            next.validatedAt,
            next.nrUserId,
            next.nrUserEmail,
            toJson(next.reachable),
            now(),
            next.revokedAt,
            id,
            ...(guard === null ? [] : [guard.c, guard.iv, guard.v]),
          ],
        );
        if (changed === 0) {
          if (guard !== null) throw keyChangedError(id);
          throw new NotFoundError('credential', id);
        }
        return getCredential(id) as CredentialRecord;
      }),
    delete: (id) =>
      call(() => {
        // FK RESTRICT turns "still referenced" into a ConflictError.
        if (run('DELETE FROM credentials WHERE id = ?', [id]) === 0)
          throw new NotFoundError('credential', id);
      }),
  };

  // ---------------------------------------------------------------------------------------------- projects
  const projectOf = (r: Row): ProjectRecord =>
    freeze({
      id: str(r['id']),
      slug: str(r['slug']),
      name: strOrNull(r['name']),
      defaultAccountId: num(r['default_account_id']),
      allowedAccountIds: JSON.parse(str(r['allowed_account_ids'])) as number[],
      enabledTools: jsonOrNull<string[]>(r['enabled_tools']),
      limits: JSON.parse(str(r['limits'])) as ProjectRecord['limits'],
      defaultCredentialId: strOrNull(r['default_credential_id']),
      createdAt: num(r['created_at']),
      updatedAt: num(r['updated_at']),
      disabledAt: numOrNull(r['disabled_at']),
    });
  const getProject = (id: string): ProjectRecord | null => {
    const r = one('SELECT * FROM projects WHERE id = ?', [id]);
    return r ? projectOf(r) : null;
  };
  const projectsRepo: ProjectsRepository = {
    get: (id) => call(() => getProject(id)),
    getBySlug: (slug) =>
      call(() => {
        const r = one('SELECT * FROM projects WHERE slug = ?', [slug]);
        return r ? projectOf(r) : null;
      }),
    list: () => call(() => freeze(all('SELECT * FROM projects ORDER BY rowid').map(projectOf))),
    create: (input) =>
      call(() => {
        const t = now();
        run(
          'INSERT INTO projects (id, slug, name, default_account_id, allowed_account_ids, enabled_tools, limits, default_credential_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            input.id,
            input.slug,
            input.name ?? null,
            input.defaultAccountId,
            JSON.stringify(input.allowedAccountIds),
            toJson(input.enabledTools),
            JSON.stringify(input.limits ?? {}),
            input.defaultCredentialId ?? null,
            t,
            t,
          ],
        );
        return getProject(input.id) as ProjectRecord;
      }),
    update: (id, patch) =>
      call(() => {
        const cur = getProject(id);
        if (!cur) throw new NotFoundError('project', id);
        const n = merge(cur, patch);
        run(
          'UPDATE projects SET slug = ?, name = ?, default_account_id = ?, allowed_account_ids = ?, enabled_tools = ?, limits = ?, default_credential_id = ?, updated_at = ?, disabled_at = ? WHERE id = ?',
          [
            n.slug,
            n.name,
            n.defaultAccountId,
            JSON.stringify(n.allowedAccountIds),
            toJson(n.enabledTools),
            JSON.stringify(n.limits),
            n.defaultCredentialId,
            now(),
            n.disabledAt,
            id,
          ],
        );
        return getProject(id) as ProjectRecord;
      }),
    delete: (id) =>
      call(() => {
        // ON DELETE CASCADE removes the project's grants and, through them, their access tokens.
        if (run('DELETE FROM projects WHERE id = ?', [id]) === 0) throw new NotFoundError('project', id);
      }),
  };

  // ------------------------------------------------------------------------------------------------ grants
  const grantOf = (r: Row): GrantRecord =>
    freeze({
      id: str(r['id']),
      projectId: str(r['project_id']),
      userId: strOrNull(r['user_id']),
      label: strOrNull(r['label']),
      credentialId: strOrNull(r['credential_id']),
      tools: jsonOrNull<string[]>(r['tools']),
      accountIds: jsonOrNull<number[]>(r['account_ids']),
      limits: JSON.parse(str(r['limits'])) as GrantRecord['limits'],
      rateLimit: jsonOrNull<GrantRecord['rateLimit'] & object>(r['rate_limit']),
      createdAt: num(r['created_at']),
      updatedAt: num(r['updated_at']),
      expiresAt: numOrNull(r['expires_at']),
      revokedAt: numOrNull(r['revoked_at']),
    });
  const getGrant = (id: string): GrantRecord | null => {
    const r = one('SELECT * FROM grants WHERE id = ?', [id]);
    return r ? grantOf(r) : null;
  };
  const grantsRepo: GrantsRepository = {
    get: (id) => call(() => getGrant(id)),
    list: (filter = {}) =>
      call(() => {
        const where: string[] = [];
        const params: Params = [];
        if (filter.projectId !== undefined) {
          where.push('project_id = ?');
          params.push(filter.projectId);
        }
        if (filter.userId !== undefined) {
          where.push('user_id = ?');
          params.push(filter.userId);
        }
        const sql = `SELECT * FROM grants${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid`;
        return freeze(all(sql, params).map(grantOf));
      }),
    create: (input) =>
      call(() => {
        checkGrantPrincipal(input.userId ?? null, input.label ?? null);
        const t = now();
        run(
          'INSERT INTO grants (id, project_id, user_id, label, credential_id, tools, account_ids, limits, rate_limit, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            input.id,
            input.projectId,
            input.userId ?? null,
            input.label ?? null,
            input.credentialId ?? null,
            toJson(input.tools),
            toJson(input.accountIds),
            JSON.stringify(input.limits ?? {}),
            toJson(input.rateLimit),
            t,
            t,
            input.expiresAt ?? null,
          ],
        );
        return getGrant(input.id) as GrantRecord;
      }),
    update: (id, patch) =>
      call(() => {
        const cur = getGrant(id);
        if (!cur) throw new NotFoundError('grant', id);
        const n = merge(cur, patch);
        checkGrantPrincipal(n.userId, n.label);
        run(
          'UPDATE grants SET label = ?, credential_id = ?, tools = ?, account_ids = ?, limits = ?, rate_limit = ?, updated_at = ?, expires_at = ?, revoked_at = ? WHERE id = ?',
          [
            n.label,
            n.credentialId,
            toJson(n.tools),
            toJson(n.accountIds),
            JSON.stringify(n.limits),
            toJson(n.rateLimit),
            now(),
            n.expiresAt,
            n.revokedAt,
            id,
          ],
        );
        return getGrant(id) as GrantRecord;
      }),
    delete: (id) =>
      call(() => {
        if (run('DELETE FROM grants WHERE id = ?', [id]) === 0) throw new NotFoundError('grant', id);
      }),
  };

  // ------------------------------------------------------------------------------------------ access tokens
  const tokenOf = (r: Row): AccessTokenRecord =>
    freeze({
      id: str(r['id']),
      grantId: str(r['grant_id']),
      prefix: str(r['prefix']),
      tokenHash: str(r['token_hash']),
      label: str(r['label']),
      createdAt: num(r['created_at']),
      expiresAt: numOrNull(r['expires_at']),
      lastUsedAt: numOrNull(r['last_used_at']),
      revokedAt: numOrNull(r['revoked_at']),
    });
  const getToken = (id: string): AccessTokenRecord | null => {
    const r = one('SELECT * FROM access_tokens WHERE id = ?', [id]);
    return r ? tokenOf(r) : null;
  };
  const tokensRepo: AccessTokensRepository = {
    get: (id) => call(() => getToken(id)),
    getByHash: (tokenHash) =>
      call(() => {
        const r = one('SELECT * FROM access_tokens WHERE token_hash = ?', [tokenHash]);
        return r ? tokenOf(r) : null;
      }),
    list: (filter = {}) =>
      call(() =>
        freeze(
          (filter.grantId === undefined
            ? all('SELECT * FROM access_tokens ORDER BY rowid')
            : all('SELECT * FROM access_tokens WHERE grant_id = ? ORDER BY rowid', [filter.grantId])
          ).map(tokenOf),
        ),
      ),
    create: (input) =>
      call(() => {
        checkTokenHash(input.tokenHash);
        checkTokenPrefix(input.prefix);
        run(
          'INSERT INTO access_tokens (id, grant_id, prefix, token_hash, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            input.id,
            input.grantId,
            input.prefix,
            input.tokenHash,
            input.label,
            now(),
            input.expiresAt ?? null,
          ],
        );
        return getToken(input.id) as AccessTokenRecord;
      }),
    markUsed: (id, at) =>
      call(() => {
        if (run('UPDATE access_tokens SET last_used_at = ? WHERE id = ?', [at, id]) === 0) {
          throw new NotFoundError('access token', id);
        }
      }),
    revoke: (id, at) =>
      call(() => {
        // First revocation wins: re-revoking keeps the original time.
        if (
          run('UPDATE access_tokens SET revoked_at = coalesce(revoked_at, ?) WHERE id = ?', [at, id]) === 0
        ) {
          throw new NotFoundError('access token', id);
        }
        return getToken(id) as AccessTokenRecord;
      }),
  };

  // ------------------------------------------------------------------------------------------------ audit
  const auditOf = (r: Row): AuditRecord =>
    freeze({
      id: num(r['id']),
      ts: num(r['ts']),
      kind: str(r['kind']) as AuditRecord['kind'],
      action: str(r['action']),
      status: str(r['status']) as AuditRecord['status'],
      requestId: strOrNull(r['request_id']),
      userId: strOrNull(r['user_id']),
      grantId: strOrNull(r['grant_id']),
      tokenId: strOrNull(r['token_id']),
      clientId: strOrNull(r['client_id']),
      keyId: strOrNull(r['key_id']),
      projectId: strOrNull(r['project_id']),
      accountIds: jsonOrNull<number[]>(r['account_ids']),
      nrql: strOrNull(r['nrql']),
      durationMs: numOrNull(r['duration_ms']),
      inspectedCount: numOrNull(r['inspected_count']),
      errorCode: strOrNull(r['error_code']),
      targetType: strOrNull(r['target_type']),
      targetId: strOrNull(r['target_id']),
      details: jsonOrNull<Record<string, unknown>>(r['details']),
    });
  const auditRepo: AuditLogRepository = {
    append: (e: AuditEntry) =>
      call(() => {
        run(
          'INSERT INTO audit_log (ts, kind, action, status, request_id, user_id, grant_id, token_id, client_id, key_id, project_id, account_ids, nrql, duration_ms, inspected_count, error_code, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            e.ts,
            e.kind,
            e.action,
            e.status,
            e.requestId ?? null,
            e.userId ?? null,
            e.grantId ?? null,
            e.tokenId ?? null,
            e.clientId ?? null,
            e.keyId ?? null,
            e.projectId ?? null,
            toJson(e.accountIds),
            e.nrql ?? null,
            e.durationMs ?? null,
            e.inspectedCount ?? null,
            e.errorCode ?? null,
            e.targetType ?? null,
            e.targetId ?? null,
            toJson(e.details),
          ],
        );
      }),
    list: (q: AuditQuery = {}) =>
      call(() => {
        const limit = Math.min(Math.max(1, Math.trunc(q.limit ?? AUDIT_DEFAULT_LIMIT)), AUDIT_MAX_LIMIT);
        const where: string[] = [];
        const params: Params = [];
        const add = (clause: string, value: SQLInputValue | undefined): void => {
          if (value === undefined) return;
          where.push(clause);
          params.push(value);
        };
        add('project_id = ?', q.projectId);
        add('user_id = ?', q.userId);
        add('grant_id = ?', q.grantId);
        add('token_id = ?', q.tokenId);
        add('key_id = ?', q.keyId);
        if (q.passthrough === true) where.push('key_id IS NOT NULL');
        add('kind = ?', q.kind);
        add('action = ?', q.action);
        add('status = ?', q.status);
        add('ts >= ?', q.since);
        add('ts < ?', q.until);
        add('id < ?', q.beforeId);
        const sql = `SELECT * FROM audit_log${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
        return freeze(all(sql, [...params, limit]).map(auditOf));
      }),
    purgeBefore: (before, limit) =>
      call(() =>
        limit === undefined
          ? run('DELETE FROM audit_log WHERE ts < ?', [before])
          : run(
              'DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE ts < ? ORDER BY ts, id LIMIT ?)',
              [before, limit],
            ),
      ),
  };

  // --------------------------------------------------------------------------------------------- settings
  const settingsRepo: SettingsRepository = {
    get: (key) =>
      call(() => {
        const r = one('SELECT value FROM settings WHERE key = ?', [key]);
        return r ? freeze(JSON.parse(str(r['value'])) as JsonValue) : undefined;
      }),
    set: (key, value) =>
      call(() => {
        run(
          'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
          [key, JSON.stringify(value), now()],
        );
      }),
    setIfAbsent: (key, value) =>
      call(
        () =>
          run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING', [
            key,
            JSON.stringify(value),
            now(),
          ]) === 1,
      ),
    delete: (key) =>
      call(() => {
        run('DELETE FROM settings WHERE key = ?', [key]);
      }),
    list: () =>
      call(() => {
        const out: Record<string, JsonValue> = {};
        for (const r of all('SELECT key, value FROM settings ORDER BY key')) {
          out[str(r['key'])] = JSON.parse(str(r['value'])) as JsonValue;
        }
        return freeze(out);
      }),
  };

  // --------------------------------------------------------------------------------------------------- kv
  const kvRepo: KvRepository = {
    get: (key) =>
      call(() => {
        const r = one('SELECT value FROM kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)', [
          key,
          now(),
        ]);
        return r ? str(r['value']) : null;
      }),
    put: (key, value, opts: KvPutOptions = {}) =>
      call(() => {
        const t = now();
        const expiresAt =
          opts.expiration !== undefined
            ? opts.expiration * 1000
            : opts.expirationTtl !== undefined
              ? t + opts.expirationTtl * 1000
              : null;
        run(
          'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
          [key, value, expiresAt],
        );
      }),
    delete: (key) =>
      call(() => {
        run('DELETE FROM kv WHERE key = ?', [key]);
      }),
    list: (opts = {}) =>
      call((): KvListResult => {
        const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? KV_MAX_LIST)), KV_MAX_LIST);
        const prefix = opts.prefix ?? '';
        const after = opts.cursor === undefined ? '' : decodeCursor(opts.cursor);
        const useAfter = opts.cursor !== undefined;
        const rows = all(
          'SELECT key, expires_at FROM kv WHERE substr(key, 1, ?) = ? AND (? = 0 OR key > ?) AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?',
          [[...prefix].length, prefix, useAfter ? 1 : 0, after, now(), limit + 1],
        );
        const page = rows.slice(0, limit);
        const keys = page.map((r) => {
          const exp = numOrNull(r['expires_at']);
          return exp === null
            ? { name: str(r['key']) }
            : { name: str(r['key']), expiration: Math.floor(exp / 1000) };
        });
        const last = page.at(-1);
        return rows.length <= limit || last === undefined
          ? freeze({ keys, complete: true })
          : freeze({ keys, complete: false, cursor: encodeCursor(str(last['key'])) });
      }),
  };

  // ------------------------------------------------------------------------------------------ access records
  // The same statements as D1's batch (P3-09), in one read transaction: a consistent snapshot even with another
  // process writing (WAL). The driver is synchronous, so nothing else on this connection runs in between.
  const loadAccessRecords = (query: AccessRecordsQuery): Promise<AccessRecords> =>
    call(() => {
      db.exec('BEGIN');
      let rows: (Row | null)[];
      try {
        rows = ACCESS_RECORDS_FIELDS.map((field) =>
          one(ACCESS_RECORDS_SQL[field], [...accessRecordsParams(field, query)]),
        );
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
      const [token, project, grant, user, credential, owner] = rows;
      if (!token) return NO_ACCESS_RECORDS;
      return Object.freeze({
        token: tokenOf(token),
        project: project ? projectOf(project) : null,
        grant: grant ? grantOf(grant) : null,
        user: user ? userOf(user) : null,
        credential: credential ? credentialOf(credential) : null,
        credentialOwner: owner ? userOf(owner) : null,
      });
    });

  return {
    users: usersRepo,
    credentials: credentialsRepo,
    projects: projectsRepo,
    grants: grantsRepo,
    accessTokens: tokensRepo,
    auditLog: auditRepo,
    settings: settingsRepo,
    kv: kvRepo,
    loadAccessRecords,
  };
}

function encodeCursor(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8');
}
