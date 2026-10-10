// SPDX-License-Identifier: Apache-2.0
// Config export and import (P7-06, THREAT_MODEL T29). Web-standard only (ADR-0004).
//
// Export reads users, credentials (metadata), projects, grants and allowlisted settings into a `ConfigBundle`; New
// Relic keys are included only sealed under a wrap key the caller derived from a passphrase. Import walks the bundle in
// dependency order (users, credentials, projects, grants, settings), decides per entity what it would do and, when
// `apply` is set, does it through the same domain services the admin API uses (so every rule holds). One code path
// computes the plan and applies it, so a dry run cannot disagree with the real run.
//
// Rules: natural keys (email, owner+label, slug, project+user) make a second run a no-op; nothing is deleted or
// revoked; users are create-only and never become owners; existing grants and stored keys are never modified; a
// personal key becomes a project default only when its owner runs the import (the same rule as the admin API's
// `guardProjectDefault`, P4-18): otherwise the default is left unset and the plan says why.
import { type Clock, isRbError, type Secret } from '@relic-bridge/core';
import {
  type CredentialRecord,
  cloneQuota,
  type EncryptedKey,
  type GrantRecord,
  newId,
  type ProjectRecord,
  type Storage,
  type StoredLimits,
  type UserRecord,
} from '@relic-bridge/storage';
import { createGrant, createProject, updateProject } from '../access/config.ts';
import { createCredential, type KeyValidator } from '../access/credentials.ts';
import { isAccessError } from '../access/errors.ts';
import { isCryptoError } from '../crypto/errors.ts';
import type { Keyring } from '../crypto/keyring.ts';
import {
  BUNDLE_FORMAT,
  BUNDLE_SETTINGS,
  BUNDLE_VERSION,
  type BundleCredential,
  type BundleGrant,
  type BundleKdf,
  type BundleProject,
  type BundleSecrets,
  type BundleUser,
  type ConfigBundle,
  credentialKey,
  grantKey,
  validateBundle,
} from './bundle.ts';
import { openCredentialKeys, sealCredentialKeys } from './seal.ts';

export type TransferStorage = Pick<Storage, 'users' | 'credentials' | 'projects' | 'grants' | 'settings'>;

// ---------------------------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------------------------

export interface ExportOptions {
  /** Include the New Relic keys, sealed under this wrap key (derived by the caller from a passphrase). */
  readonly wrap?: { readonly key: Uint8Array; readonly kdf: BundleKdf };
  /**
   * Whose personal keys may be sealed in: shared keys always, and keys owned by this user. Anyone else's personal key
   * is listed (metadata) but never leaves: the API never reveals a key, and an export must not become a way to take a
   * colleague's. `null` (the admin token, which is nobody) means shared keys only.
   */
  readonly keyOwnerUserId?: string | null;
}

export interface ExportResult {
  readonly bundle: ConfigBundle;
  /** Things left out and why (never values). */
  readonly warnings: readonly string[];
}

const byString =
  <T>(f: (t: T) => string) =>
  (a: T, b: T) => {
    const x = f(a);
    const y = f(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };

const cleanLimits = (l: StoredLimits): StoredLimits => JSON.parse(JSON.stringify(l)) as StoredLimits;

export async function exportConfig(
  deps: { readonly storage: TransferStorage; readonly keyring: Keyring; readonly clock: Clock },
  options: ExportOptions = {},
): Promise<ExportResult> {
  const { storage } = deps;
  const now = deps.clock.now();
  const warnings: string[] = [];

  const allUsers = await storage.users.list();
  const users = allUsers.filter((u) => u.disabledAt === null);
  const emailById = new Map(users.map((u) => [u.id, u.email]));
  const bundleUsers: BundleUser[] = users
    .map((u) => ({ email: u.email, displayName: u.displayName, role: u.role }))
    .sort(byString((u) => u.email));
  if (allUsers.length !== users.length)
    warnings.push(`${allUsers.length - users.length} disabled user(s) not exported`);

  const credentialRecords = (await storage.credentials.list()).filter((c) => c.revokedAt === null);
  const exported: { record: CredentialRecord; meta: BundleCredential }[] = [];
  for (const c of credentialRecords) {
    if (c.key.kind !== 'encrypted') {
      warnings.push(`credential "${c.label}" is not stored encrypted: not exported`);
      continue;
    }
    let owner: string | null = null;
    if (c.ownerUserId !== null) {
      owner = emailById.get(c.ownerUserId) ?? null;
      if (owner === null) {
        warnings.push(`credential "${c.label}" belongs to a user that is not exported: not exported`);
        continue;
      }
    }
    exported.push({ record: c, meta: { ref: c.id, label: c.label, region: c.region, owner } });
  }
  exported.sort(byString((e) => credentialKey(e.meta)));
  const refById = new Map(exported.map((e) => [e.record.id, e.meta.ref]));

  const projectRecords = await storage.projects.list();
  const slugById = new Map(projectRecords.map((p) => [p.id, p.slug]));
  const bundleProjects: BundleProject[] = projectRecords
    .map((p) => {
      let defaultCredential: string | null = null;
      if (p.defaultCredentialId !== null) {
        defaultCredential = refById.get(p.defaultCredentialId) ?? null;
        if (defaultCredential === null) {
          warnings.push(
            `project "${p.slug}": its default credential is not exported; the default is left empty`,
          );
        }
      }
      return {
        slug: p.slug,
        name: p.name,
        defaultAccountId: p.defaultAccountId,
        allowedAccountIds: [...p.allowedAccountIds].sort((a, b) => a - b),
        enabledTools: p.enabledTools === null ? null : [...p.enabledTools].sort(),
        limits: cleanLimits(p.limits),
        defaultCredential,
        disabled: p.disabledAt !== null,
      };
    })
    .sort(byString((p) => p.slug));

  const grantMap = new Map<string, BundleGrant>();
  const grantRecords = [...(await storage.grants.list())].sort((a, b) => a.createdAt - b.createdAt);
  let skippedGrants = 0;
  for (const g of grantRecords) {
    if (g.revokedAt !== null || (g.expiresAt !== null && g.expiresAt <= now)) continue;
    const project = slugById.get(g.projectId);
    const user = g.userId === null ? null : (emailById.get(g.userId) ?? null);
    const credential = g.credentialId === null ? null : (refById.get(g.credentialId) ?? null);
    if (
      project === undefined ||
      (g.userId !== null && user === null) ||
      (g.credentialId !== null && credential === null)
    ) {
      skippedGrants++;
      continue;
    }
    const grant: BundleGrant = {
      project,
      user,
      label: g.label,
      credential,
      tools: g.tools === null ? null : [...g.tools].sort(),
      accountIds: g.accountIds === null ? null : [...g.accountIds].sort((a, b) => a - b),
      limits: cleanLimits(g.limits),
      rateLimit:
        g.rateLimit === null ? null : { requests: g.rateLimit.requests, perSeconds: g.rateLimit.perSeconds },
      quota: g.quota === null ? null : cloneQuota(g.quota),
      expiresAt: g.expiresAt,
    };
    const key = grantKey(grant);
    if (grantMap.has(key))
      warnings.push(`project "${project}": two grants share one key; the newer one is exported`);
    grantMap.set(key, grant);
  }
  if (skippedGrants > 0) {
    warnings.push(
      `${skippedGrants} grant(s) not exported (their user or key is not exported, or the project is gone)`,
    );
  }
  const bundleGrants = [...grantMap.values()].sort(byString(grantKey));

  const settings: { -readonly [K in (typeof BUNDLE_SETTINGS)[number]]?: boolean } = {};
  for (const key of BUNDLE_SETTINGS) {
    const value = await storage.settings.get(key);
    if (typeof value === 'boolean') settings[key] = value;
  }

  const credentials = exported.map((e) => e.meta);
  let secrets: BundleSecrets | undefined;
  if (options.wrap !== undefined) {
    const keys: Record<string, string> = {};
    const mayExport = (c: CredentialRecord): boolean =>
      c.ownerUserId === null || c.ownerUserId === (options.keyOwnerUserId ?? null);
    for (const e of exported) {
      if (!mayExport(e.record)) {
        warnings.push(
          `credential "${e.meta.label}" is a personal key of another user: its key is not exported`,
        );
        continue;
      }
      try {
        keys[e.meta.ref] = (
          await deps.keyring.decryptCredentialKey(e.record.id, e.record.key as EncryptedKey)
        ).reveal();
      } catch (error) {
        if (!isCryptoError(error)) throw error;
        warnings.push(
          `credential "${e.meta.label}" could not be decrypted (${error.code}): its key is not exported`,
        );
      }
    }
    secrets = await sealCredentialKeys(options.wrap.key, options.wrap.kdf, credentials, keys);
  }

  const bundle: ConfigBundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: new Date(now).toISOString(),
    users: bundleUsers,
    credentials,
    projects: bundleProjects,
    grants: bundleGrants,
    settings,
    ...(secrets === undefined ? {} : { secrets }),
  };
  return { bundle, warnings };
}

// ---------------------------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------------------------

export type EntityKind = 'user' | 'credential' | 'project' | 'grant' | 'setting';
export type PlanAction = 'create' | 'update' | 'unchanged' | 'skip';

export interface PlanEntry {
  readonly kind: EntityKind;
  /** Natural key: email, `owner|label`, slug, `project|user|…`, setting name. Never a secret. */
  readonly key: string;
  readonly action: PlanAction;
  /** Changed fields (`update`). */
  readonly fields?: readonly string[];
  /** Why `skip`ped, or what was adjusted. */
  readonly reason?: string;
}

export interface ImportFailure {
  readonly kind: EntityKind;
  readonly key: string;
  readonly code: string;
  readonly message: string;
}

export interface ImportReport {
  readonly dryRun: boolean;
  readonly entries: readonly PlanEntry[];
  readonly summary: {
    readonly create: number;
    readonly update: number;
    readonly unchanged: number;
    readonly skip: number;
  };
  readonly warnings: readonly string[];
  /** Apply stopped here; everything before it was applied, and a repeated import resumes. */
  readonly failed: ImportFailure | null;
}

export interface ImportDeps {
  readonly storage: TransferStorage;
  readonly keyring: Keyring;
  readonly validate: KeyValidator;
  readonly catalog: readonly string[];
  readonly clock: Clock;
}

export interface ImportOptions {
  readonly apply: boolean;
  /** Opens `bundle.secrets`. Without it the keys are treated as absent. */
  readonly wrapKey?: Uint8Array;
  /**
   * The user running the import (a session's user id); `null` or absent for the admin token, which is nobody. Only
   * this user's own personal keys may become a project default (phase 7 review H1, P4-18).
   */
  readonly actorUserId?: string | null;
}

const PLANNED = 'planned:';
const norm = (email: string): string => email.trim().toLowerCase();

function canon(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.map(canon);
    if (value.every((v) => typeof v !== 'object' || v === null)) items.sort();
    return `[${items.join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canon(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown): boolean => canon(a) === canon(b);

function failureOf(error: unknown): { code: string; message: string } | null {
  if (isAccessError(error)) return { code: error.code, message: error.message };
  if (isRbError(error))
    return { code: error.code, message: 'New Relic refused the key or could not be asked' };
  if (isCryptoError(error)) return { code: error.code, message: 'the master key is unavailable' };
  return null;
}

export async function importConfig(
  deps: ImportDeps,
  bundle: ConfigBundle,
  options: ImportOptions,
): Promise<ImportReport> {
  const { storage, clock } = deps;
  const { apply } = options;
  validateBundle(bundle, deps.catalog);
  const now = clock.now();
  const entries: PlanEntry[] = [];
  const warnings: string[] = [];
  const record = (e: PlanEntry): void => {
    entries.push(e);
  };

  let keys: ReadonlyMap<string, Secret> = new Map();
  if (bundle.secrets !== undefined) {
    if (options.wrapKey === undefined) {
      warnings.push(
        'the file holds encrypted New Relic keys but no passphrase was given: new credentials are skipped',
      );
    } else {
      keys = await openCredentialKeys(options.wrapKey, bundle);
    }
  }

  // Current state, by natural key.
  const usersByEmail = new Map<string, UserRecord>(
    (await storage.users.list()).map((u) => [norm(u.email), u]),
  );
  const userIds = new Map<string, string>(); // email -> id (real or planned)
  const emailByUserId = new Map<string, string>([...usersByEmail].map(([email, u]) => [u.id, email]));
  const credentialRecords = (await storage.credentials.list()).filter((c) => c.revokedAt === null);
  const credentialIds = new Map<string, string>(); // bundle ref -> id (real or planned); absent = unavailable
  const projectsBySlug = new Map<string, ProjectRecord>(
    (await storage.projects.list()).map((p) => [p.slug, p]),
  );
  const projectIds = new Map<string, string>();
  const personalRefs = new Set(bundle.credentials.filter((c) => c.owner !== null).map((c) => c.ref));
  const ownerOfRef = new Map(bundle.credentials.map((c) => [c.ref, c.owner === null ? null : norm(c.owner)]));
  const refusedDefaults = new Set<string>(); // project slugs whose personal-key default was refused

  const counts = { create: 0, update: 0, unchanged: 0, skip: 0 };
  const state: { failed: ImportFailure | null } = { failed: null };

  const step = async (kind: EntityKind, key: string, run: () => Promise<void>): Promise<boolean> => {
    try {
      await run();
      return true;
    } catch (error) {
      const f = failureOf(error);
      if (f === null) throw error;
      state.failed = { kind, key, code: f.code, message: f.message };
      return false;
    }
  };

  // ---- users: create-only; never an owner.
  for (const u of bundle.users) {
    const email = norm(u.email);
    const existing = usersByEmail.get(email);
    if (existing !== undefined) {
      userIds.set(email, existing.id);
      record({
        kind: 'user',
        key: email,
        action: 'unchanged',
        ...(existing.disabledAt === null ? {} : { reason: 'user is disabled here' }),
      });
      continue;
    }
    const role = u.role === 'owner' ? 'admin' : u.role;
    const reason =
      u.role === 'owner'
        ? 'created as admin: owners are never created by an import (`user add --role owner`)'
        : undefined;
    let id = `${PLANNED}user:${email}`;
    if (apply) {
      const ok = await step('user', email, async () => {
        const created = await storage.users.create({
          id: newId('usr'),
          email,
          displayName: u.displayName,
          role,
        });
        id = created.id;
      });
      if (!ok) break;
    }
    userIds.set(email, id);
    record({ kind: 'user', key: email, action: 'create', ...(reason === undefined ? {} : { reason }) });
  }

  // ---- credentials: matched by owner + label; stored keys are never replaced.
  if (state.failed === null) {
    const existingByKey = new Map<string, CredentialRecord>();
    for (const c of credentialRecords) {
      const owner = c.ownerUserId === null ? null : (emailByUserId.get(c.ownerUserId) ?? null);
      existingByKey.set(credentialKey({ owner, label: c.label }), c);
    }
    for (const c of bundle.credentials) {
      const owner = c.owner === null ? null : norm(c.owner);
      const label = c.label.trim();
      const key = credentialKey({ owner, label });
      const existing = existingByKey.get(key);
      if (existing !== undefined) {
        credentialIds.set(c.ref, existing.id);
        if (existing.region !== c.region) {
          warnings.push(
            `credential "${label}": exists here in region ${existing.region}, the file says ${c.region}`,
          );
        }
        record({ kind: 'credential', key, action: 'unchanged', reason: 'exists: its stored key is kept' });
        continue;
      }
      const secret = keys.get(c.ref);
      if (secret === undefined) {
        record({
          kind: 'credential',
          key,
          action: 'skip',
          reason:
            'no key in the file: add it with `credential add`, then import again (grants using it are skipped)',
        });
        continue;
      }
      let id = `${PLANNED}credential:${c.ref}`;
      const ownerUserId = owner === null ? null : (userIds.get(owner) ?? null);
      if (apply) {
        const ok = await step('credential', key, async () => {
          const created = await createCredential(
            { storage, keyring: deps.keyring, validate: deps.validate, clock },
            { label, region: c.region, apiKey: secret, ownerUserId },
          );
          id = created.id;
        });
        if (!ok) break;
      }
      credentialIds.set(c.ref, id);
      record({
        kind: 'credential',
        key,
        action: 'create',
        reason: 'key validated against New Relic when applied',
      });
    }
  }

  // ---- projects: created, or updated where they differ (the diff shows widenings).
  if (state.failed === null) {
    for (const p of bundle.projects) {
      const existing = projectsBySlug.get(p.slug);
      let defaultCredentialId: string | null | undefined; // undefined = leave as is
      const ref = p.defaultCredential;
      if (ref !== null) {
        if (credentialIds.has(ref)) {
          const candidate = credentialIds.get(ref) as string;
          const keyOwner = ownerOfRef.get(ref) ?? null;
          const keyOwnerId = keyOwner === null ? null : (userIds.get(keyOwner) ?? null);
          if (!personalRefs.has(ref) || candidate === existing?.defaultCredentialId) {
            defaultCredentialId = candidate;
          } else if (keyOwnerId !== null && keyOwnerId === (options.actorUserId ?? null)) {
            // The admin API lets only a key's owner make it a project default (`guardProjectDefault`, P4-18); so
            // does the import: the person running it is the key's owner. The plan still says so.
            defaultCredentialId = candidate;
            warnings.push(
              `project "${p.slug}": your personal key becomes the project default (shared with everyone on it)`,
            );
          } else {
            // Anyone else (another owner, the admin token) would pull a colleague's key into a project, which the
            // admin API refuses (phase 7 review H1). The default is left as it is; grants needing it are skipped.
            refusedDefaults.add(p.slug);
            warnings.push(
              `project "${p.slug}": its default is a personal key of ${keyOwner ?? 'another user'}; only that user can make it a project default (default not set)`,
            );
          }
        } else {
          warnings.push(`project "${p.slug}": its default credential is not available here; default not set`);
        }
      }

      if (existing === undefined) {
        let id = `${PLANNED}project:${p.slug}`;
        if (apply) {
          const ok = await step('project', p.slug, async () => {
            const created = await createProject(
              storage,
              {
                slug: p.slug,
                name: p.name,
                defaultAccountId: p.defaultAccountId,
                allowedAccountIds: p.allowedAccountIds,
                enabledTools: p.enabledTools,
                limits: p.limits,
                defaultCredentialId: defaultCredentialId ?? null,
              },
              deps.catalog,
            );
            id = created.id;
            if (p.disabled) await updateProject(storage, id, { disabled: true }, deps.catalog, now);
          });
          if (!ok) break;
        }
        projectIds.set(p.slug, id);
        record({ kind: 'project', key: p.slug, action: 'create' });
        continue;
      }

      projectIds.set(p.slug, existing.id);
      const fields: string[] = [];
      const input: {
        name?: string | null;
        defaultAccountId?: number;
        allowedAccountIds?: readonly number[];
        enabledTools?: readonly string[] | null;
        limits?: StoredLimits;
        defaultCredentialId?: string | null;
        disabled?: boolean;
      } = {};
      if ((existing.name ?? null) !== p.name) {
        fields.push('name');
        input.name = p.name;
      }
      if (existing.defaultAccountId !== p.defaultAccountId) {
        fields.push('defaultAccountId');
        input.defaultAccountId = p.defaultAccountId;
      }
      if (!same(existing.allowedAccountIds, p.allowedAccountIds)) {
        fields.push('allowedAccountIds');
        input.allowedAccountIds = p.allowedAccountIds;
      }
      if (!same(existing.enabledTools, p.enabledTools)) {
        fields.push('enabledTools');
        input.enabledTools = p.enabledTools;
      }
      if (!same(existing.limits, p.limits)) {
        fields.push('limits');
        input.limits = p.limits;
      }
      if (defaultCredentialId !== undefined && defaultCredentialId !== existing.defaultCredentialId) {
        fields.push('defaultCredential');
        input.defaultCredentialId = defaultCredentialId;
      }
      if ((existing.disabledAt !== null) !== p.disabled) {
        fields.push('disabled');
        input.disabled = p.disabled;
      }
      if (fields.length === 0) {
        record({ kind: 'project', key: p.slug, action: 'unchanged' });
        continue;
      }
      if (apply) {
        const ok = await step('project', p.slug, async () => {
          const result = await updateProject(storage, existing.id, input, deps.catalog, now);
          warnings.push(...result.warnings.map((w) => `project "${p.slug}": ${w}`));
        });
        if (!ok) break;
      }
      record({ kind: 'project', key: p.slug, action: 'update', fields });
    }
  }

  // ---- grants: create-only. A grant that exists with other settings is left alone.
  if (state.failed === null) {
    const existingGrants = new Map<string, GrantRecord[]>();
    for (const g of await storage.grants.list()) {
      if (g.revokedAt !== null) continue;
      const list = existingGrants.get(g.projectId) ?? [];
      list.push(g);
      existingGrants.set(g.projectId, list);
    }
    const defaultOf = (slug: string): string | null => {
      const e = projectsBySlug.get(slug);
      const p = bundle.projects.find((x) => x.slug === slug);
      if (e !== undefined && e.defaultCredentialId !== null) return e.defaultCredentialId;
      if (refusedDefaults.has(slug)) return null;
      if (p?.defaultCredential != null) {
        return credentialIds.get(p.defaultCredential) ?? null;
      }
      return null;
    };
    for (const g of bundle.grants) {
      const email = g.user === null ? null : norm(g.user);
      const label = g.label === null ? null : g.label.trim();
      const key = grantKey({ project: g.project, user: email, label });
      const skip = (reason: string): void => record({ kind: 'grant', key, action: 'skip', reason });
      const projectId = projectIds.get(g.project);
      if (projectId === undefined) {
        skip('its project was not imported');
        continue;
      }
      const userId = email === null ? null : (userIds.get(email) ?? null);
      if (email !== null) {
        const u = usersByEmail.get(email);
        if (userId === null || (u !== undefined && u.disabledAt !== null)) {
          skip('its user is disabled or unavailable');
          continue;
        }
      }
      let credentialId: string | null = null;
      if (g.credential !== null) {
        const id = credentialIds.get(g.credential);
        if (id === undefined) {
          skip('its credential has no key in the file and does not exist here');
          continue;
        }
        const owner = ownerOfRef.get(g.credential) ?? null;
        if (owner !== null && owner !== email) {
          skip("a grant cannot use another user's personal key");
          continue;
        }
        credentialId = id;
      } else if (defaultOf(g.project) === null) {
        skip('the project has no default credential available here');
        continue;
      }
      if (g.expiresAt !== null && g.expiresAt <= now) {
        skip('it has expired');
        continue;
      }

      const mine = (existingGrants.get(projectId) ?? []).filter((x) =>
        email === null ? x.userId === null && (x.label ?? '') === (label ?? '') : x.userId === userId,
      );
      if (mine.length > 0) {
        const equal = mine.some(
          (x) =>
            (x.credentialId ?? null) === credentialId &&
            same(x.tools, g.tools) &&
            same(x.accountIds, g.accountIds) &&
            same(x.limits, g.limits) &&
            same(x.rateLimit, g.rateLimit) &&
            same(x.quota, g.quota ?? null) &&
            x.expiresAt === g.expiresAt,
        );
        if (equal) record({ kind: 'grant', key, action: 'unchanged' });
        else
          skip(
            'a grant exists with other settings; import never changes existing grants (use `grant revoke`, then import)',
          );
        continue;
      }
      if (apply) {
        const ok = await step('grant', key, async () => {
          const result = await createGrant(
            storage,
            {
              projectId,
              userId,
              label,
              credentialId,
              tools: g.tools,
              accountIds: g.accountIds,
              limits: g.limits,
              rateLimit: g.rateLimit,
              quota: g.quota ?? null,
              expiresAt: g.expiresAt,
            },
            deps.catalog,
            now,
          );
          warnings.push(...result.warnings.map((w) => `grant ${key}: ${w}`));
        });
        if (!ok) break;
      }
      record({
        kind: 'grant',
        key,
        action: 'create',
        reason: 'no access tokens are imported: create them with `token create`',
      });
    }
  }

  // ---- settings (allowlist).
  if (state.failed === null) {
    for (const name of BUNDLE_SETTINGS) {
      const desired = bundle.settings[name];
      if (desired === undefined) continue;
      const current = (await storage.settings.get(name)) !== false;
      if (current === desired) {
        record({ kind: 'setting', key: name, action: 'unchanged' });
        continue;
      }
      if (apply) await storage.settings.set(name, desired);
      record({ kind: 'setting', key: name, action: 'update', fields: [name] });
    }
  }

  for (const e of entries) counts[e.action]++;
  return Object.freeze({
    dryRun: !apply,
    entries: Object.freeze(entries),
    summary: counts,
    warnings: Object.freeze([...new Set(warnings)]),
    failed: state.failed,
  });
}
