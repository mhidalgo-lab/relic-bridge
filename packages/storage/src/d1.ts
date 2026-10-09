// SPDX-License-Identifier: Apache-2.0
// The `d1` adapter (ADR-0006, P3-02): `Storage` on a Cloudflare D1 binding, with plain parameterised SQL against the
// schema the embedded migrations create (the same SQL and runner as the Node `sqlite` adapter).
//
// D1 has no interactive transactions, and every call is a network round trip that other isolates can interleave
// with. So every write is ONE statement whose condition the engine evaluates, and the outcome is read from
// `meta.changes` or `RETURNING`:
// - `settings.setIfAbsent`: `INSERT … ON CONFLICT DO NOTHING`; true iff a row was written (key check values, P2-03).
// - `credentials.update` with `ifKey`: the compare-and-swap guard is part of the `UPDATE … WHERE` (rotation, P2-03).
// - `update` methods set only the patched columns in one `UPDATE … RETURNING *`: no read-modify-write window, so two
//   concurrent patches of different fields never undo each other.
// Cascades and restrictions are the engine's foreign keys, which D1 always enforces.
//
// Web-standard only (ADR-0004). The binding is typed structurally, so this package needs no Workers types.
import {
  ACCESS_RECORDS_FIELDS,
  ACCESS_RECORDS_SQL,
  type AccessRecords,
  type AccessRecordsQuery,
  accessRecordsParams,
  NO_ACCESS_RECORDS,
} from './access-records.ts';
import {
  ConflictError,
  InvalidInputError,
  keyChangedError,
  MigrationError,
  NotFoundError,
  StorageError,
} from './errors.ts';
import { type MigrationDriver, migrate } from './migrate.ts';
import { MIGRATIONS } from './migrations.generated.ts';
import { toBytes } from './schema.ts';
import type {
  AccessTokenRecord,
  AccessTokensRepository,
  AuditLogRepository,
  AuditQuery,
  AuditRecord,
  CredentialRecord,
  CredentialsRepository,
  EncryptedKey,
  GrantRecord,
  GrantsRepository,
  JsonValue,
  KvListResult,
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

// ------------------------------------------------------------------------------------------------ D1 binding shape

/** Result metadata of a D1 statement (the fields the adapter reads). */
export interface D1MetaLike {
  readonly changes?: number;
}

export interface D1ResultLike {
  readonly results?: readonly Record<string, unknown>[];
  readonly meta?: D1MetaLike;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all(): Promise<D1ResultLike>;
  run(): Promise<D1ResultLike>;
}

/** The subset of the Workers `D1Database` binding the adapter uses. */
export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<readonly D1ResultLike[]>;
}

export interface D1StorageOptions {
  /** Clock in epoch milliseconds (tests). */
  readonly now?: () => number;
  /**
   * Apply pending migrations on open (default `true`). When `false`, an out-of-date or newer database is refused
   * instead (read-only check).
   */
  readonly migrate?: boolean;
}

export interface D1Storage extends Storage {
  readonly kind: 'd1';
}

// ------------------------------------------------------------------------------------------------ errors

const UNIQUE = /UNIQUE constraint failed: ([\w.]+)/;
const CHECK = /CHECK constraint failed: (\w+)/;

/** CHECK constraint names → the field `validate.ts` reports for the same rule. */
const CHECK_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  grants_principal_check: 'grants.principal',
  users_role_check: 'users.role',
  credentials_region_check: 'credentials.region',
  credentials_key_iv_check: 'credentials.key_iv',
  credentials_key_version_check: 'credentials.key_version',
  credentials_key_hint_check: 'credentials.key_hint',
  access_tokens_hash_check: 'access_tokens.token_hash',
  access_tokens_prefix_check: 'access_tokens.prefix',
});

function messages(error: unknown): string {
  const parts: string[] = [];
  let e: unknown = error;
  for (let i = 0; i < 4 && e instanceof Error; i++) {
    parts.push(e.message);
    e = e.cause;
  }
  return parts.join('\n');
}

/** Map D1/SQLite engine errors to the storage errors. Messages carry constraint names only, never values. */
export function mapD1Error(error: unknown): unknown {
  if (error instanceof StorageError) return error;
  const message = messages(error);
  const unique = UNIQUE.exec(message);
  if (unique) {
    return new ConflictError(unique[1] as string, 'a row with this unique value already exists', {
      cause: error,
    });
  }
  if (message.includes('FOREIGN KEY constraint failed')) {
    return new ConflictError('foreign_key', 'a referenced row is missing, or the row is still referenced', {
      cause: error,
    });
  }
  const check = CHECK.exec(message);
  if (check) return new InvalidInputError(CHECK_FIELDS[check[1] as string] ?? (check[1] as string));
  if (message.includes('NOT NULL constraint failed')) return new InvalidInputError('not_null');
  return error;
}

// ------------------------------------------------------------------------------------------------ helpers

type Row = Record<string, unknown>;

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
const copyBytes = (v: unknown): Uint8Array => new Uint8Array(toBytes(v));

/** A BLOB parameter. D1 binds `ArrayBuffer` (and views) as BLOB; a fresh exact-size buffer avoids view offsets. */
const blob = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer as ArrayBuffer;

/** `SET` clause builder: only columns whose value is not `undefined`. */
class Assignments {
  readonly columns: string[] = [];
  readonly params: unknown[] = [];
  set(column: string, value: unknown): this {
    if (value !== undefined) {
      this.columns.push(`${column} = ?`);
      this.params.push(value);
    }
    return this;
  }
  get sql(): string {
    return this.columns.join(', ');
  }
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8', { fatal: true });

function encodeCursor(key: string): string {
  let bin = '';
  for (const b of utf8.encode(key)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(cursor: string): string {
  try {
    const b64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return fromUtf8.decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    throw new InvalidInputError('kv.cursor');
  }
}

/**
 * `PRAGMA foreign_keys` statements in a migration (drizzle-kit emits them around table rebuilds). SQLite ignores the
 * pragma inside a transaction, and a D1 batch is one, so skipping them changes nothing; D1 always enforces foreign
 * keys and documents `PRAGMA defer_foreign_keys` instead, so a deployed database never sees a pragma it may refuse.
 */
const FOREIGN_KEYS_PRAGMA = /^PRAGMA\s+foreign_keys\s*=/i;

/**
 * The migration runner's view of a D1 database: `batch` is a D1 `batch()`, which D1 runs as one transaction (all
 * statements or none). Checksums cover the migration as written, skipped pragmas included.
 */
export function d1MigrationDriver(db: D1DatabaseLike): MigrationDriver {
  return {
    async all(sql, params = []) {
      return (
        (
          await db
            .prepare(sql)
            .bind(...params)
            .all()
        ).results ?? []
      );
    },
    async batch(statements) {
      await db.batch(
        statements
          .filter((s) => !FOREIGN_KEYS_PRAGMA.test(s.sql.trim()))
          .map((s) => db.prepare(s.sql).bind(...(s.params ?? []))),
      );
    },
  };
}

/**
 * Apply pending migrations. Several isolates may boot at once on a fresh or outdated database: the runner's batches
 * are atomic, so a loser's batch fails (primary key on `schema_migrations`, or the DDL itself) and rolls back, and it
 * runs again from the versions now recorded. Each such failure means another isolate applied a version, so a bounded
 * number of passes always catches up; a migration that is really broken still fails after them. A newer or edited
 * database (no `cause`) is refused at once.
 */
async function migrateD1(db: D1DatabaseLike, now: () => number): Promise<void> {
  const driver = d1MigrationDriver(db);
  for (let attempt = 0; ; attempt++) {
    try {
      await migrate(driver, MIGRATIONS, { now });
      return;
    } catch (error) {
      const raced = error instanceof MigrationError && error.cause !== undefined;
      if (!raced || attempt >= MIGRATIONS.length) throw error;
    }
  }
}

/** Throws unless every embedded migration is applied and nothing newer is. Read-only. */
async function assertCurrent(db: D1DatabaseLike): Promise<void> {
  const table = await db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .all();
  const v =
    (table.results?.length ?? 0) === 0
      ? 0
      : (await db.prepare('SELECT max(version) AS v FROM schema_migrations').all()).results?.[0]?.['v'];
  const version = typeof v === 'number' ? v : 0;
  if (version !== MIGRATIONS.length) {
    throw new MigrationError(
      `database schema version is ${version}, this build needs ${MIGRATIONS.length}; open it once with migrations enabled`,
    );
  }
}

// ------------------------------------------------------------------------------------------------ storage

/** Open the D1 storage on a binding (`env.DB`), applying pending migrations first. */
export async function createD1Storage(
  db: D1DatabaseLike,
  options: D1StorageOptions = {},
): Promise<D1Storage> {
  const now = options.now ?? Date.now;
  try {
    if (options.migrate ?? true) await migrateD1(db, now);
    else await assertCurrent(db);
  } catch (error) {
    throw mapD1Error(error);
  }

  const stmt = (sql: string, params: readonly unknown[]): D1PreparedStatementLike =>
    db.prepare(sql).bind(...params);
  const all = async (sql: string, params: readonly unknown[] = []): Promise<Row[]> =>
    ((await stmt(sql, params).all()).results ?? []) as Row[];
  const one = async (sql: string, params: readonly unknown[] = []): Promise<Row | null> =>
    (await all(sql, params))[0] ?? null;
  const run = async (sql: string, params: readonly unknown[] = []): Promise<number> =>
    Number((await stmt(sql, params).run()).meta?.changes ?? 0);

  /** Runs `fn`; engine errors become storage errors. */
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      throw mapD1Error(error);
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
  const usersRepo: UsersRepository = {
    get: (id) =>
      call(async () => {
        const r = await one('SELECT * FROM users WHERE id = ?', [id]);
        return r ? userOf(r) : null;
      }),
    getByEmail: (email) =>
      call(async () => {
        const r = await one('SELECT * FROM users WHERE email = ?', [normalizeEmail(email)]);
        return r ? userOf(r) : null;
      }),
    getByIdentity: (idp, idpSubject) =>
      call(async () => {
        const r = await one('SELECT * FROM users WHERE idp = ? AND idp_subject = ?', [idp, idpSubject]);
        return r ? userOf(r) : null;
      }),
    list: () => call(async () => freeze((await all('SELECT * FROM users ORDER BY rowid')).map(userOf))),
    create: (input) =>
      call(async () => {
        const t = now();
        const role = checkRole(input.role);
        const r = await one(
          'INSERT INTO users (id, email, display_name, idp, idp_subject, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
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
        return userOf(r as Row);
      }),
    update: (id, patch) =>
      call(async () => {
        const a = new Assignments()
          .set('email', patch.email === undefined ? undefined : normalizeEmail(patch.email))
          .set('display_name', patch.displayName)
          .set('idp', patch.idp)
          .set('idp_subject', patch.idpSubject)
          .set('role', patch.role === undefined ? undefined : checkRole(patch.role))
          .set('disabled_at', patch.disabledAt)
          .set('updated_at', now());
        const r = await one(`UPDATE users SET ${a.sql} WHERE id = ? RETURNING *`, [...a.params, id]);
        if (!r) throw new NotFoundError('user', id);
        return userOf(r);
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
  const getCredential = async (id: string): Promise<CredentialRecord | null> => {
    const r = await one('SELECT * FROM credentials WHERE id = ?', [id]);
    return r ? credentialOf(r) : null;
  };
  const credentialsRepo: CredentialsRepository = {
    get: (id) => call(() => getCredential(id)),
    list: (filter = {}) =>
      call(async () =>
        freeze(
          (filter.ownerUserId === undefined
            ? await all('SELECT * FROM credentials ORDER BY rowid')
            : await all('SELECT * FROM credentials WHERE owner_user_id = ? ORDER BY rowid', [
                filter.ownerUserId,
              ])
          ).map(credentialOf),
        ),
      ),
    create: (input) =>
      call(async () => {
        checkEncryptedKey(input.key);
        checkKeyHint(input.keyHint);
        const region = checkRegion(input.region);
        const t = now();
        const r = await one(
          'INSERT INTO credentials (id, owner_user_id, label, region, key_ciphertext, key_iv, key_version, key_hint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
          [
            input.id,
            input.ownerUserId ?? null,
            input.label,
            region,
            blob(input.key.ciphertext),
            blob(input.key.iv),
            input.key.keyVersion,
            input.keyHint ?? null,
            t,
            t,
          ],
        );
        return credentialOf(r as Row);
      }),
    update: (id, patch) =>
      call(async () => {
        if (patch.key !== undefined) checkEncryptedKey(patch.key);
        if (patch.ifKey !== undefined) checkEncryptedKey(patch.ifKey);
        if (patch.keyHint !== undefined) checkKeyHint(patch.keyHint);
        const v = patch.validation;
        const key: EncryptedKey | undefined = patch.key;
        const a = new Assignments()
          .set('label', patch.label)
          .set('key_ciphertext', key === undefined ? undefined : blob(key.ciphertext))
          .set('key_iv', key === undefined ? undefined : blob(key.iv))
          .set('key_version', key?.keyVersion)
          .set('key_hint', patch.keyHint)
          .set('revoked_at', patch.revokedAt);
        if (v !== undefined) {
          a.set('validation_status', v.validationStatus)
            .set('validation_error_code', v.validationErrorCode ?? null)
            .set('validated_at', v.validatedAt)
            .set('nr_user_id', v.nrUserId)
            .set('nr_user_email', v.nrUserEmail)
            .set(
              'reachable_account_ids',
              v.reachableAccountIds === undefined ? undefined : toJson(v.reachableAccountIds),
            );
        }
        a.set('updated_at', now());
        // The compare-and-swap guard is evaluated by the engine in the same statement as the write.
        const guard = patch.ifKey;
        const r = await one(
          `UPDATE credentials SET ${a.sql} WHERE id = ?${guard === undefined ? '' : ' AND key_ciphertext = ? AND key_iv = ? AND key_version = ?'} RETURNING *`,
          [
            ...a.params,
            id,
            ...(guard === undefined ? [] : [blob(guard.ciphertext), blob(guard.iv), guard.keyVersion]),
          ],
        );
        if (r) return credentialOf(r);
        if (guard !== undefined && (await one('SELECT 1 AS x FROM credentials WHERE id = ?', [id]))) {
          throw keyChangedError(id);
        }
        throw new NotFoundError('credential', id);
      }),
    delete: (id) =>
      call(async () => {
        // FK RESTRICT turns "still referenced" into a ConflictError.
        if ((await run('DELETE FROM credentials WHERE id = ?', [id])) === 0) {
          throw new NotFoundError('credential', id);
        }
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
  const projectsRepo: ProjectsRepository = {
    get: (id) =>
      call(async () => {
        const r = await one('SELECT * FROM projects WHERE id = ?', [id]);
        return r ? projectOf(r) : null;
      }),
    getBySlug: (slug) =>
      call(async () => {
        const r = await one('SELECT * FROM projects WHERE slug = ?', [slug]);
        return r ? projectOf(r) : null;
      }),
    list: () => call(async () => freeze((await all('SELECT * FROM projects ORDER BY rowid')).map(projectOf))),
    create: (input) =>
      call(async () => {
        const t = now();
        const r = await one(
          'INSERT INTO projects (id, slug, name, default_account_id, allowed_account_ids, enabled_tools, limits, default_credential_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
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
        return projectOf(r as Row);
      }),
    update: (id, patch) =>
      call(async () => {
        const a = new Assignments()
          .set('slug', patch.slug)
          .set('name', patch.name)
          .set('default_account_id', patch.defaultAccountId)
          .set(
            'allowed_account_ids',
            patch.allowedAccountIds === undefined ? undefined : JSON.stringify(patch.allowedAccountIds),
          )
          .set('enabled_tools', patch.enabledTools === undefined ? undefined : toJson(patch.enabledTools))
          .set('limits', patch.limits === undefined ? undefined : JSON.stringify(patch.limits))
          .set('default_credential_id', patch.defaultCredentialId)
          .set('disabled_at', patch.disabledAt)
          .set('updated_at', now());
        const r = await one(`UPDATE projects SET ${a.sql} WHERE id = ? RETURNING *`, [...a.params, id]);
        if (!r) throw new NotFoundError('project', id);
        return projectOf(r);
      }),
    delete: (id) =>
      call(async () => {
        // ON DELETE CASCADE removes the project's grants and, through them, their access tokens.
        if ((await run('DELETE FROM projects WHERE id = ?', [id])) === 0)
          throw new NotFoundError('project', id);
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
  const grantsRepo: GrantsRepository = {
    get: (id) =>
      call(async () => {
        const r = await one('SELECT * FROM grants WHERE id = ?', [id]);
        return r ? grantOf(r) : null;
      }),
    list: (filter = {}) =>
      call(async () => {
        const where: string[] = [];
        const params: unknown[] = [];
        if (filter.projectId !== undefined) {
          where.push('project_id = ?');
          params.push(filter.projectId);
        }
        if (filter.userId !== undefined) {
          where.push('user_id = ?');
          params.push(filter.userId);
        }
        const sql = `SELECT * FROM grants${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid`;
        return freeze((await all(sql, params)).map(grantOf));
      }),
    create: (input) =>
      call(async () => {
        checkGrantPrincipal(input.userId ?? null, input.label ?? null);
        const t = now();
        const r = await one(
          'INSERT INTO grants (id, project_id, user_id, label, credential_id, tools, account_ids, limits, rate_limit, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
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
        return grantOf(r as Row);
      }),
    update: (id, patch) =>
      call(async () => {
        // A label cleared on a service grant breaks `grants_principal_check` → InvalidInputError (grants.principal).
        const a = new Assignments()
          .set('label', patch.label)
          .set('credential_id', patch.credentialId)
          .set('tools', patch.tools === undefined ? undefined : toJson(patch.tools))
          .set('account_ids', patch.accountIds === undefined ? undefined : toJson(patch.accountIds))
          .set('limits', patch.limits === undefined ? undefined : JSON.stringify(patch.limits))
          .set('rate_limit', patch.rateLimit === undefined ? undefined : toJson(patch.rateLimit))
          .set('expires_at', patch.expiresAt)
          .set('revoked_at', patch.revokedAt)
          .set('updated_at', now());
        const r = await one(`UPDATE grants SET ${a.sql} WHERE id = ? RETURNING *`, [...a.params, id]);
        if (!r) throw new NotFoundError('grant', id);
        return grantOf(r);
      }),
    delete: (id) =>
      call(async () => {
        if ((await run('DELETE FROM grants WHERE id = ?', [id])) === 0) throw new NotFoundError('grant', id);
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
  const tokensRepo: AccessTokensRepository = {
    get: (id) =>
      call(async () => {
        const r = await one('SELECT * FROM access_tokens WHERE id = ?', [id]);
        return r ? tokenOf(r) : null;
      }),
    getByHash: (tokenHash) =>
      call(async () => {
        const r = await one('SELECT * FROM access_tokens WHERE token_hash = ?', [tokenHash]);
        return r ? tokenOf(r) : null;
      }),
    list: (filter = {}) =>
      call(async () =>
        freeze(
          (filter.grantId === undefined
            ? await all('SELECT * FROM access_tokens ORDER BY rowid')
            : await all('SELECT * FROM access_tokens WHERE grant_id = ? ORDER BY rowid', [filter.grantId])
          ).map(tokenOf),
        ),
      ),
    create: (input) =>
      call(async () => {
        checkTokenHash(input.tokenHash);
        checkTokenPrefix(input.prefix);
        const r = await one(
          'INSERT INTO access_tokens (id, grant_id, prefix, token_hash, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *',
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
        return tokenOf(r as Row);
      }),
    markUsed: (id, at) =>
      call(async () => {
        if ((await run('UPDATE access_tokens SET last_used_at = ? WHERE id = ?', [at, id])) === 0) {
          throw new NotFoundError('access token', id);
        }
      }),
    revoke: (id, at) =>
      call(async () => {
        // First revocation wins: re-revoking keeps the original time.
        const r = await one(
          'UPDATE access_tokens SET revoked_at = coalesce(revoked_at, ?) WHERE id = ? RETURNING *',
          [at, id],
        );
        if (!r) throw new NotFoundError('access token', id);
        return tokenOf(r);
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
    append: (e) =>
      call(async () => {
        await run(
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
      call(async () => {
        checkLimit(q.limit, 'auditLog.limit');
        const limit = Math.min(Math.max(1, Math.trunc(q.limit ?? AUDIT_DEFAULT_LIMIT)), AUDIT_MAX_LIMIT);
        const where: string[] = [];
        const params: unknown[] = [];
        const add = (clause: string, value: string | number | undefined): void => {
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
        return freeze((await all(sql, [...params, limit])).map(auditOf));
      }),
    purgeBefore: (before, limit) =>
      call(() => {
        checkLimit(limit, 'auditLog.limit');
        return limit === undefined
          ? run('DELETE FROM audit_log WHERE ts < ?', [before])
          : run(
              'DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE ts < ? ORDER BY ts, id LIMIT ?)',
              [before, limit],
            );
      }),
  };

  // --------------------------------------------------------------------------------------------- settings
  const settingsRepo: SettingsRepository = {
    get: (key) =>
      call(async () => {
        const r = await one('SELECT value FROM settings WHERE key = ?', [key]);
        return r ? freeze(JSON.parse(str(r['value'])) as JsonValue) : undefined;
      }),
    set: (key, value) =>
      call(async () => {
        await run(
          'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
          [key, JSON.stringify(value), now()],
        );
      }),
    // One statement: the engine decides, so exactly one of several racing isolates sees `true`.
    setIfAbsent: (key, value) =>
      call(
        async () =>
          (await run(
            'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING',
            [key, JSON.stringify(value), now()],
          )) === 1,
      ),
    delete: (key) =>
      call(async () => {
        await run('DELETE FROM settings WHERE key = ?', [key]);
      }),
    list: () =>
      call(async () => {
        const out: Record<string, JsonValue> = {};
        for (const r of await all('SELECT key, value FROM settings ORDER BY key')) {
          out[str(r['key'])] = JSON.parse(str(r['value'])) as JsonValue;
        }
        return freeze(out);
      }),
  };

  // --------------------------------------------------------------------------------------------------- kv
  const kvRepo: KvRepository = {
    get: (key) =>
      call(async () => {
        const r = await one('SELECT value FROM kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)', [
          key,
          now(),
        ]);
        return r ? str(r['value']) : null;
      }),
    put: (key, value, opts = {}) =>
      call(async () => {
        const expiresAt = kvExpiry(opts, now());
        await run(
          'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
          [key, value, expiresAt],
        );
      }),
    delete: (key) =>
      call(async () => {
        await run('DELETE FROM kv WHERE key = ?', [key]);
      }),
    // One statement: SQLite deletes and returns the row atomically, so concurrent takes can't both see it. An expired
    // row is deleted too but not returned.
    take: (key) =>
      call(async () => {
        const r = await one('DELETE FROM kv WHERE key = ? RETURNING value, expires_at', [key]);
        if (r === null) return null;
        const exp = numOrNull(r['expires_at']);
        return exp !== null && exp <= now() ? null : str(r['value']);
      }),
    list: (opts = {}) =>
      call(async (): Promise<KvListResult> => {
        checkLimit(opts.limit, 'kv.limit');
        const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? KV_MAX_LIST)), KV_MAX_LIST);
        const prefix = opts.prefix ?? '';
        const useAfter = opts.cursor !== undefined;
        const after = opts.cursor === undefined ? '' : decodeCursor(opts.cursor);
        const rows = await all(
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
  // One `batch()` = one round trip, run by D1 as one transaction, so the rows are a consistent snapshot (P3-09).
  const loadAccessRecords = (query: AccessRecordsQuery): Promise<AccessRecords> =>
    call(async () => {
      const results = await db.batch(
        ACCESS_RECORDS_FIELDS.map((field) =>
          stmt(ACCESS_RECORDS_SQL[field], accessRecordsParams(field, query)),
        ),
      );
      const row = (i: number): Row | null => (results[i]?.results?.[0] as Row | undefined) ?? null;
      const token = row(0);
      if (token === null) return NO_ACCESS_RECORDS;
      const [project, grant, user, credential, owner] = [row(1), row(2), row(3), row(4), row(5)];
      return Object.freeze({
        token: tokenOf(token),
        project: project ? projectOf(project) : null,
        grant: grant ? grantOf(grant) : null,
        user: user ? userOf(user) : null,
        credential: credential ? credentialOf(credential) : null,
        credentialOwner: owner ? userOf(owner) : null,
      });
    });

  return Object.freeze({
    kind: 'd1' as const,
    readOnly: false,
    users: usersRepo,
    credentials: credentialsRepo,
    projects: projectsRepo,
    grants: grantsRepo,
    accessTokens: tokensRepo,
    auditLog: auditRepo,
    settings: settingsRepo,
    kv: kvRepo,
    loadAccessRecords,
    // The binding has no connection to close.
    async close() {},
  });
}
