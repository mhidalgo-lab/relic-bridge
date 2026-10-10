// SPDX-License-Identifier: Apache-2.0
// The config bundle (P7-06): what `config export` writes and `config import` reads. Plain data, web-standard only
// (ADR-0004). The HTTP layer validates the shape strictly (zod); `validateBundle` checks what a shape cannot: caps,
// uniqueness and that every reference resolves inside the bundle.

import { redact } from '@relic-bridge/core';
import type { NrRegion, StoredLimits, StoredQuota, StoredRateLimit, UserRole } from '@relic-bridge/storage';
import { isStoredQuota, SLUG_RE } from '@relic-bridge/storage';
import { AccessError } from '../access/errors.ts';

export const BUNDLE_FORMAT = 'relic-bridge-config';
export const BUNDLE_VERSION = 1;

/** Largest bundle: a personal or small-team setup, far below the admin API body limit. */
export const MAX_BUNDLE_USERS = 200;
export const MAX_BUNDLE_CREDENTIALS = 100;
export const MAX_BUNDLE_PROJECTS = 100;
export const MAX_BUNDLE_GRANTS = 500;

/** Settings a bundle may carry: an allowlist, so a crafted file can never write an internal key (key checks, …). */
export const BUNDLE_SETTINGS = ['oauth.registration'] as const;
export type BundleSettingKey = (typeof BUNDLE_SETTINGS)[number];

export interface BundleUser {
  readonly email: string;
  readonly displayName: string | null;
  readonly role: UserRole;
}

/** A New Relic key's metadata. The key itself is only ever in `secrets`, sealed. */
export interface BundleCredential {
  /** Link used inside the bundle (the source credential id). Not matched against the target. */
  readonly ref: string;
  readonly label: string;
  readonly region: NrRegion;
  /** Owner's email, null for a shared key. */
  readonly owner: string | null;
}

export interface BundleProject {
  readonly slug: string;
  readonly name: string | null;
  readonly defaultAccountId: number;
  readonly allowedAccountIds: readonly number[];
  readonly enabledTools: readonly string[] | null;
  readonly limits: StoredLimits;
  /** A `credentials[].ref`. */
  readonly defaultCredential: string | null;
  readonly disabled: boolean;
}

export interface BundleGrant {
  /** A project slug. */
  readonly project: string;
  /** A user email; null for a service grant (which needs a label). */
  readonly user: string | null;
  readonly label: string | null;
  /** A `credentials[].ref`; null = the project's default credential. */
  readonly credential: string | null;
  readonly tools: readonly string[] | null;
  readonly accountIds: readonly number[] | null;
  readonly limits: StoredLimits;
  readonly rateLimit: StoredRateLimit | null;
  /** Usage caps (P7-12). Absent in files exported before quotas existed: same as null. */
  readonly quota?: StoredQuota | null;
  /** Epoch ms; null = never. */
  readonly expiresAt: number | null;
}

export interface BundleKdf {
  readonly name: 'pbkdf2-sha256';
  readonly iterations: number;
  /** base64, 16 bytes. */
  readonly salt: string;
}

export interface BundleSecrets {
  readonly kdf: BundleKdf;
  readonly cipher: 'aes-256-gcm';
  /** base64, 12 bytes (the AES-GCM IV). */
  readonly nonce: string;
  /** base64: AES-GCM output (ciphertext || 16-byte tag) of `{"keys":{<ref>: <NR key>}}`. */
  readonly sealed: string;
}

export interface ConfigBundle {
  readonly format: typeof BUNDLE_FORMAT;
  readonly version: typeof BUNDLE_VERSION;
  /** ISO 8601, informational. */
  readonly exportedAt: string;
  readonly users: readonly BundleUser[];
  readonly credentials: readonly BundleCredential[];
  readonly projects: readonly BundleProject[];
  readonly grants: readonly BundleGrant[];
  readonly settings: { readonly [K in BundleSettingKey]?: boolean };
  readonly secrets?: BundleSecrets;
}

/** The natural key of a grant inside a bundle (and in a target): project, user (or service) and, for services, label. */
export function grantKey(g: { project: string; user: string | null; label: string | null }): string {
  return g.user === null ? `${g.project}|service|${g.label ?? ''}` : `${g.project}|user|${g.user}`;
}

/** The natural key of a credential: owner (or shared) and label. */
export function credentialKey(c: { owner: string | null; label: string }): string {
  return `${c.owner ?? '-'}|${c.label}`;
}

const invalid = (message: string, field?: string): AccessError =>
  new AccessError('invalid_input', message, field);

/** Throws `invalid_input` (a message that names fields only, never values) when the bundle is inconsistent. */
export function validateBundle(bundle: ConfigBundle, catalog: readonly string[]): void {
  if (bundle.format !== BUNDLE_FORMAT || bundle.version !== BUNDLE_VERSION) {
    throw invalid(`not a ${BUNDLE_FORMAT} version ${BUNDLE_VERSION} file`, 'format');
  }
  const caps: [string, number, number][] = [
    ['users', bundle.users.length, MAX_BUNDLE_USERS],
    ['credentials', bundle.credentials.length, MAX_BUNDLE_CREDENTIALS],
    ['projects', bundle.projects.length, MAX_BUNDLE_PROJECTS],
    ['grants', bundle.grants.length, MAX_BUNDLE_GRANTS],
  ];
  for (const [field, n, max] of caps) {
    if (n > max) throw invalid(`${field}: at most ${max} entries per bundle`, field);
  }
  const emails = new Set<string>();
  for (const u of bundle.users) {
    const email = u.email.trim().toLowerCase();
    if (emails.has(email)) throw invalid('users: duplicate email', 'users');
    emails.add(email);
  }
  const refs = new Set<string>();
  const credentialKeys = new Set<string>();
  for (const c of bundle.credentials) {
    if (refs.has(c.ref)) throw invalid('credentials: duplicate ref', 'credentials');
    refs.add(c.ref);
    if (c.owner !== null && !emails.has(c.owner.trim().toLowerCase())) {
      throw invalid(`credentials: owner of "${c.ref}" is not in users`, 'credentials');
    }
    const key = credentialKey({ owner: c.owner?.trim().toLowerCase() ?? null, label: c.label.trim() });
    if (credentialKeys.has(key)) throw invalid('credentials: duplicate owner and label', 'credentials');
    credentialKeys.add(key);
  }
  const slugs = new Set<string>();
  const toolSet = new Set(catalog);
  const unknownTools = (tools: readonly string[] | null): string[] =>
    tools === null ? [] : tools.filter((t) => !toolSet.has(t));
  for (const p of bundle.projects) {
    if (!SLUG_RE.test(p.slug))
      throw invalid('projects: slug must be lowercase letters, digits and dashes', 'projects');
    if (slugs.has(p.slug)) throw invalid(`projects: duplicate slug "${p.slug}"`, 'projects');
    slugs.add(p.slug);
    if (!p.allowedAccountIds.includes(p.defaultAccountId)) {
      throw invalid(`projects: "${p.slug}" defaultAccountId must be one of allowedAccountIds`, 'projects');
    }
    const unknown = unknownTools(p.enabledTools);
    if (unknown.length > 0) {
      throw invalid(
        `projects: "${p.slug}" has unknown tool name(s) ${redact(unknown.slice(0, 5).join(', '))}`,
        'projects',
      );
    }
    if (p.defaultCredential !== null && !refs.has(p.defaultCredential)) {
      throw invalid(`projects: "${p.slug}" defaultCredential is not in credentials`, 'projects');
    }
  }
  const grantKeys = new Set<string>();
  for (const g of bundle.grants) {
    if (!slugs.has(g.project)) throw invalid(`grants: project "${g.project}" is not in projects`, 'grants');
    if (g.user === null && (g.label === null || g.label.trim() === '')) {
      throw invalid('grants: a service grant (no user) needs a label', 'grants');
    }
    if (g.user !== null && !emails.has(g.user.trim().toLowerCase())) {
      throw invalid(`grants: a user of project "${g.project}" is not in users`, 'grants');
    }
    if (g.credential !== null && !refs.has(g.credential)) {
      throw invalid(`grants: a credential of project "${g.project}" is not in credentials`, 'grants');
    }
    if (g.quota !== undefined && g.quota !== null && !isStoredQuota(g.quota)) {
      throw invalid(`grants: invalid quota for a grant of project "${g.project}"`, 'grants');
    }
    const unknown = unknownTools(g.tools);
    if (unknown.length > 0) {
      throw invalid(`grants: unknown tool name(s) ${redact(unknown.slice(0, 5).join(', '))}`, 'grants');
    }
    const key = grantKey({
      project: g.project,
      user: g.user?.trim().toLowerCase() ?? null,
      label: g.label?.trim() ?? null,
    });
    if (grantKeys.has(key)) throw invalid(`grants: duplicate grant for project "${g.project}"`, 'grants');
    grantKeys.add(key);
  }
}
