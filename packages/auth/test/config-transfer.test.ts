// SPDX-License-Identifier: Apache-2.0
// Config import/export (P7-06): the bundle, sealing New Relic keys, dry run, idempotence, owner boundary.
import { type Credential, ErrorCode, type Identity, RbError, Secret } from '@relic-bridge/core';
import { createMemoryStorage } from '@relic-bridge/storage';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGrant, createProject } from '../src/access/config.ts';
import { createCredential, type KeyValidator } from '../src/access/credentials.ts';
import { toBase64 } from '../src/crypto/bytes.ts';
import { generateMasterKey, Keyring } from '../src/crypto/keyring.ts';
import {
  type BundleKdf,
  type BundleProject,
  type ConfigBundle,
  deriveWrapKey,
  exportConfig,
  importConfig,
  KDF_ITERATIONS,
  MIN_KDF_ITERATIONS,
  newKdf,
  openCredentialKeys,
  validateBundle,
} from '../src/transfer/index.ts';
import { CATALOG, NOW } from './access-fixtures.ts';

const KEY_A = 'NRAK-AAAAAAAAAAAAAAAAAAAAAAAAAAA1';
const KEY_B = 'NRAK-BBBBBBBBBBBBBBBBBBBBBBBBBBB2';
const PASS = 'correct horse battery staple';
const clock = { now: () => NOW };

const validate: KeyValidator = (c: Credential): Promise<Identity> => {
  const known = [KEY_A, KEY_B].includes(c.apiKey.reveal());
  if (!known) return Promise.reject(new Error('unreachable: not a New Relic error'));
  return Promise.resolve({
    user: { id: 7, email: 'a@example.com', name: 'A' },
    accounts: [
      { id: 1, name: 'one' },
      { id: 2, name: 'two' },
    ],
  });
};

let kdf: BundleKdf;
let wrap: Uint8Array<ArrayBuffer>;
beforeAll(async () => {
  kdf = newKdf();
  wrap = await deriveWrapKey(PASS, kdf);
});

async function source() {
  const storage = createMemoryStorage({ now: () => NOW });
  const keyring = await Keyring.create({ current: generateMasterKey(1) });
  const owner = await storage.users.create({ id: 'usr_o', email: 'o@example.com', role: 'owner' });
  const member = await storage.users.create({
    id: 'usr_m',
    email: 'm@example.com',
    role: 'member',
    displayName: 'Em',
  });
  await storage.users.create({ id: 'usr_x', email: 'gone@example.com', role: 'member' });
  await storage.users.update('usr_x', { disabledAt: NOW });
  const shared = await createCredential(
    { storage, keyring, validate, clock },
    { label: 'shared', region: 'US', apiKey: new Secret(KEY_A) },
  );
  const personal = await createCredential(
    { storage, keyring, validate, clock },
    { label: 'mine', region: 'EU', apiKey: new Secret(KEY_B), ownerUserId: member.id },
  );
  const project = await createProject(
    storage,
    {
      slug: 'prod',
      name: 'Prod',
      defaultAccountId: 1,
      allowedAccountIds: [1, 2],
      enabledTools: ['run_nrql', 'list_accounts'],
      limits: { maxLimit: 50 },
      defaultCredentialId: shared.id,
    },
    CATALOG,
  );
  await createGrant(
    storage,
    { projectId: project.id, userId: member.id, credentialId: personal.id, tools: ['run_nrql'] },
    CATALOG,
    NOW,
  );
  await createGrant(storage, { projectId: project.id, userId: owner.id }, CATALOG, NOW);
  await createGrant(
    storage,
    { projectId: project.id, label: 'ci', rateLimit: { requests: 10, perSeconds: 60 } },
    CATALOG,
    NOW,
  );
  await storage.settings.set('oauth.registration', false);
  return { storage, keyring, shared, personal, project };
}

async function target() {
  const storage = createMemoryStorage({ now: () => NOW });
  const keyring = await Keyring.create({ current: generateMasterKey(1) });
  return { storage, keyring, deps: { storage, keyring, validate, catalog: CATALOG, clock } };
}

/** What the member `usr_m` exports: the shared key and their own personal one. */
const sealedOpts = () => ({ wrap: { key: wrap, kdf }, keyOwnerUserId: 'usr_m' });

const summary = (r: { summary: unknown }) => JSON.stringify(r.summary);

describe('wrap key derivation', () => {
  it('keeps the production cost at 600 000 iterations and refuses anything weaker', () => {
    expect(KDF_ITERATIONS).toBe(600_000);
    expect(MIN_KDF_ITERATIONS).toBe(600_000);
    expect(newKdf().iterations).toBe(600_000);
  });

  it('is PBKDF2-HMAC-SHA-256 over the NFC passphrase', async () => {
    const salt = new TextEncoder().encode('relic-bridge-tes');
    const key = await deriveWrapKey(PASS, {
      name: 'pbkdf2-sha256',
      iterations: 600_000,
      salt: toBase64(salt),
    });
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASS), 'PBKDF2', false, [
      'deriveBits',
    ]);
    const direct = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600_000 },
      base,
      256,
    );
    expect(toBase64(key)).toBe(toBase64(new Uint8Array(direct)));
    // Composed and decomposed spellings of one passphrase give one key.
    const a = await deriveWrapKey('caf\u00e9 au lait 2026', {
      name: 'pbkdf2-sha256',
      iterations: 600_000,
      salt: toBase64(salt),
    });
    const b = await deriveWrapKey('cafe\u0301 au lait 2026', {
      name: 'pbkdf2-sha256',
      iterations: 600_000,
      salt: toBase64(salt),
    });
    expect(toBase64(a)).toBe(toBase64(b));
  });
});

describe('exportConfig', () => {
  let s: Awaited<ReturnType<typeof source>>;
  beforeEach(async () => {
    s = await source();
  });

  it('exports metadata only by default: no keys, ciphertext, hints, tokens or disabled users', async () => {
    const { bundle } = await exportConfig({ ...s, clock });
    const text = JSON.stringify(bundle);
    expect(bundle.secrets).toBeUndefined();
    for (const needle of [
      KEY_A,
      KEY_B,
      'NRAK',
      'sealed',
      'keyHint',
      'tokenHash',
      'rb_',
      'idpSubject',
      'gone@',
    ]) {
      expect(text).not.toContain(needle);
    }
    expect(bundle.users.map((u) => u.email)).toEqual(['m@example.com', 'o@example.com']);
    expect(bundle.credentials.map((c) => [c.label, c.owner])).toEqual([
      ['shared', null],
      ['mine', 'm@example.com'],
    ]);
    expect(bundle.projects[0]).toMatchObject({
      slug: 'prod',
      defaultCredential: s.shared.id,
      disabled: false,
    });
    expect(bundle.grants).toHaveLength(3);
    expect(bundle.settings).toEqual({ 'oauth.registration': false });
  });

  it('is deterministic apart from the timestamp, and skips revoked grants and expired ones', async () => {
    const grants = await s.storage.grants.list();
    await s.storage.grants.update(grants[0]?.id as string, { revokedAt: NOW });
    const a = await exportConfig({ ...s, clock });
    const b = await exportConfig({ ...s, clock });
    expect(JSON.stringify(a.bundle)).toBe(JSON.stringify(b.bundle));
    expect(a.bundle.grants).toHaveLength(2);
  });

  it('seals keys under the wrap key: no plaintext, opens only with the right key', async () => {
    const { bundle } = await exportConfig({ ...s, clock }, sealedOpts());
    const text = JSON.stringify(bundle);
    expect(text).not.toContain(KEY_A);
    expect(text).not.toContain(KEY_B);
    expect(bundle.secrets?.kdf.iterations).toBe(600_000);
    const keys = await openCredentialKeys(wrap, bundle);
    expect(keys.get(s.shared.id)?.reveal()).toBe(KEY_A);
    expect(keys.get(s.personal.id)?.reveal()).toBe(KEY_B);
    const wrong = await deriveWrapKey('another passphrase entirely', kdf);
    await expect(openCredentialKeys(wrong, bundle)).rejects.toMatchObject({ code: 'not_permitted' });
  });

  it("never exports another user's personal key: the admin token (nobody) and other users get shared keys only", async () => {
    for (const keyOwnerUserId of [undefined, null, 'usr_o']) {
      const { bundle, warnings } = await exportConfig(
        { ...s, clock },
        { wrap: { key: wrap, kdf }, ...(keyOwnerUserId === undefined ? {} : { keyOwnerUserId }) },
      );
      const keys = await openCredentialKeys(wrap, bundle);
      expect([...keys.values()].map((k) => k.reveal())).toEqual([KEY_A]);
      expect(JSON.stringify(bundle)).not.toContain(KEY_B);
      expect(warnings.some((w) => w.includes('personal key of another user'))).toBe(true);
      // The metadata is still there, so the target can ask for the key again.
      expect(bundle.credentials).toHaveLength(2);
    }
  });

  it('binds the credential metadata: swapping a label or region is detected', async () => {
    const { bundle } = await exportConfig({ ...s, clock }, sealedOpts());
    const swapped: ConfigBundle = {
      ...bundle,
      credentials: bundle.credentials.map((c) =>
        c.label === 'shared' ? { ...c, label: 'mine2', region: 'EU' } : c,
      ),
    };
    await expect(openCredentialKeys(wrap, swapped)).rejects.toMatchObject({ code: 'not_permitted' });
    const flipped = bundle.secrets as NonNullable<ConfigBundle['secrets']>;
    const bytes = Uint8Array.from(atob(flipped.sealed), (ch) => ch.charCodeAt(0));
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    const tampered = { ...bundle, secrets: { ...flipped, sealed: toBase64(bytes) } };
    await expect(openCredentialKeys(wrap, tampered)).rejects.toMatchObject({ code: 'not_permitted' });
    // Editing a project (not credential metadata) does not break the seal: files can be hand-edited.
    const edited = { ...bundle, projects: bundle.projects.map((p) => ({ ...p, name: 'Renamed' })) };
    expect((await openCredentialKeys(wrap, edited)).size).toBe(2);
  });

  it('refuses weak or malformed KDF parameters and short passphrases', async () => {
    await expect(deriveWrapKey('short', kdf)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(deriveWrapKey(PASS, { ...kdf, iterations: 1000 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(deriveWrapKey(PASS, { ...kdf, salt: 'AAAA' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(deriveWrapKey(PASS, { ...kdf, iterations: 2 ** 40 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe('importConfig', () => {
  it('dry run changes nothing; apply creates everything; a second import is a no-op (round trip with keys)', async () => {
    const s = await source();
    const { bundle } = await exportConfig({ ...s, clock }, sealedOpts());
    const t = await target();

    const dry = await importConfig(t.deps, bundle, { apply: false, wrapKey: wrap });
    expect(dry.dryRun).toBe(true);
    expect(dry.failed).toBeNull();
    expect(dry.summary).toMatchObject({ create: 2 + 2 + 1 + 3, update: 1, unchanged: 0, skip: 0 });
    expect(await t.storage.users.list()).toHaveLength(0);
    expect(await t.storage.projects.list()).toHaveLength(0);
    expect(await t.storage.settings.get('oauth.registration')).toBeUndefined();

    const applied = await importConfig(t.deps, bundle, { apply: true, wrapKey: wrap });
    expect(applied.failed).toBeNull();
    expect(applied.summary.create).toBe(dry.summary.create);
    expect(applied.entries.map((e) => `${e.kind}:${e.action}`)).toEqual(
      dry.entries.map((e) => `${e.kind}:${e.action}`),
    );

    const users = await t.storage.users.list();
    expect(users.map((u) => u.email).sort()).toEqual(['m@example.com', 'o@example.com']);
    // Imported users have no sign-in identity bound, and the owner is capped at admin.
    expect(users.every((u) => u.idp === null && u.idpSubject === null)).toBe(true);
    expect(users.find((u) => u.email === 'o@example.com')?.role).toBe('admin');
    const credentials = await t.storage.credentials.list();
    expect(credentials).toHaveLength(2);
    const shared = credentials.find((c) => c.label === 'shared');
    expect(shared?.key.kind).toBe('encrypted');
    expect((await t.keyring.decryptCredentialKey(shared?.id as string, shared?.key as never)).reveal()).toBe(
      KEY_A,
    );
    const project = (await t.storage.projects.list())[0];
    expect(project).toMatchObject({
      slug: 'prod',
      allowedAccountIds: [1, 2],
      defaultCredentialId: shared?.id,
    });
    expect(await t.storage.grants.list()).toHaveLength(3);
    expect(await t.storage.settings.get('oauth.registration')).toBe(false);

    const again = await importConfig(t.deps, bundle, { apply: true, wrapKey: wrap });
    expect(summary(again)).toBe(
      JSON.stringify({ create: 0, update: 0, unchanged: again.entries.length, skip: 0 }),
    );
    expect(await t.storage.credentials.list()).toHaveLength(2);
    expect(await t.storage.grants.list()).toHaveLength(3);
  });

  it('without keys: credentials and the grants that need them are skipped, with reasons', async () => {
    const s = await source();
    const { bundle } = await exportConfig({ ...s, clock });
    const t = await target();
    const r = await importConfig(t.deps, bundle, { apply: true });
    const byKind = (k: string, a: string) => r.entries.filter((e) => e.kind === k && e.action === a).length;
    expect(byKind('credential', 'skip')).toBe(2);
    // The project is created without its default; every grant lacks a credential.
    expect(byKind('project', 'create')).toBe(1);
    expect(byKind('grant', 'skip')).toBe(3);
    expect(r.warnings.some((w) => w.includes('default credential is not available'))).toBe(true);
    expect((await t.storage.projects.list())[0]?.defaultCredentialId).toBeNull();
    expect(await t.storage.credentials.list()).toHaveLength(0);
  });

  it('warns when the file holds keys but no passphrase was given, and refuses a wrong one', async () => {
    const s = await source();
    const { bundle } = await exportConfig({ ...s, clock }, sealedOpts());
    const t = await target();
    const noPass = await importConfig(t.deps, bundle, { apply: false });
    expect(noPass.warnings.some((w) => w.includes('no passphrase'))).toBe(true);
    const wrong = await deriveWrapKey('a different passphrase!', kdf);
    await expect(importConfig(t.deps, bundle, { apply: true, wrapKey: wrong })).rejects.toMatchObject({
      code: 'not_permitted',
    });
    expect(await t.storage.users.list()).toHaveLength(0);
  });

  it('updates a changed project (diff lists fields), never modifies existing users, grants or stored keys', async () => {
    const s = await source();
    const { bundle } = await exportConfig({ ...s, clock }, sealedOpts());
    const t = await target();
    await importConfig(t.deps, bundle, { apply: true, wrapKey: wrap });

    const [project] = await t.storage.projects.list();
    await t.storage.projects.update(project?.id as string, { allowedAccountIds: [1], name: 'Local' });
    const member = await t.storage.users.getByEmail('m@example.com');
    await t.storage.users.update(member?.id as string, { role: 'admin', displayName: 'Changed' });
    const [grant] = (await t.storage.grants.list()).filter((g) => g.label === 'ci');
    await t.storage.grants.update(grant?.id as string, { rateLimit: { requests: 1, perSeconds: 1 } });

    const dry = await importConfig(t.deps, bundle, { apply: false, wrapKey: wrap });
    const proj = dry.entries.find((e) => e.kind === 'project');
    expect(proj).toMatchObject({ action: 'update', fields: ['name', 'allowedAccountIds'] });
    expect(dry.entries.find((e) => e.kind === 'grant' && e.action === 'skip')?.reason).toContain(
      'never changes existing grants',
    );
    expect(dry.entries.filter((e) => e.kind === 'user').every((e) => e.action === 'unchanged')).toBe(true);

    await importConfig(t.deps, bundle, { apply: true, wrapKey: wrap });
    expect((await t.storage.projects.get(project?.id as string))?.allowedAccountIds).toEqual([1, 2]);
    expect((await t.storage.users.get(member?.id as string))?.role).toBe('admin');
    expect((await t.storage.users.get(member?.id as string))?.displayName).toBe('Changed');
    expect((await t.storage.grants.get(grant?.id as string))?.rateLimit).toEqual({
      requests: 1,
      perSeconds: 1,
    });
  });

  it('keeps a stored key: an existing credential with the same owner and label is never overwritten', async () => {
    const s = await source();
    const { bundle } = await exportConfig({ ...s, clock }, sealedOpts());
    const t = await target();
    const existing = await createCredential(
      { ...t.deps },
      { label: 'shared', region: 'US', apiKey: new Secret(KEY_B) },
    );
    const r = await importConfig(t.deps, bundle, { apply: true, wrapKey: wrap });
    expect(r.entries.find((e) => e.kind === 'credential' && e.key.endsWith('shared'))?.action).toBe(
      'unchanged',
    );
    const stored = await t.storage.credentials.get(existing.id);
    expect((await t.keyring.decryptCredentialKey(existing.id, stored?.key as never)).reveal()).toBe(KEY_B);
  });

  it('makes a personal key a project default only when its owner imports, and never creates owners', async () => {
    const s = await source();
    const { bundle } = await exportConfig({ ...s, clock }, sealedOpts());
    const personalRef = bundle.credentials.find((c) => c.owner !== null)?.ref as string;
    const edited: ConfigBundle = {
      ...bundle,
      projects: bundle.projects.map((p) => ({ ...p, defaultCredential: personalRef })),
      users: bundle.users.map((u) => ({ ...u, role: 'owner' as const })),
    };

    // Another owner (or the admin token): the default is refused, like the admin API's guardProjectDefault (P4-18).
    const other = await target();
    const refused = await importConfig(other.deps, edited, { apply: true, wrapKey: wrap });
    expect(refused.warnings.some((w) => w.includes('only that user can make it a project default'))).toBe(
      true,
    );
    expect((await other.storage.projects.list())[0]?.defaultCredentialId).toBeNull();
    expect((await other.storage.users.list()).every((u) => u.role !== 'owner')).toBe(true);

    // The key's owner: allowed, and the plan says so.
    const t = await target();
    const member = await t.storage.users.create({ id: 'usr_m2', email: 'm@example.com', role: 'member' });
    const r = await importConfig(t.deps, edited, { apply: true, wrapKey: wrap, actorUserId: member.id });
    expect(r.warnings.some((w) => w.includes('your personal key becomes the project default'))).toBe(true);
    const mine = (await t.storage.credentials.list()).find((c) => c.label === 'mine');
    expect((await t.storage.projects.list())[0]?.defaultCredentialId).toBe(mine?.id);
  });

  it("cannot pull a colleague's stored personal key into a project as its default (phase 7 review H1)", async () => {
    // Target: a member with a personal key stored here. An owner crafts a bundle that names that key (owner + label
    // are visible metadata), a new project defaulting to it, and a grant for themselves riding on the default.
    const t = await target();
    const owner = await t.storage.users.create({ id: 'usr_o2', email: 'o@example.com', role: 'owner' });
    const victim = await t.storage.users.create({ id: 'usr_v', email: 'v@example.com', role: 'member' });
    const key = await createCredential(
      { ...t.deps },
      { label: 'victim-key', region: 'US', apiKey: new Secret(KEY_B), ownerUserId: victim.id },
    );
    const bundle: ConfigBundle = {
      format: 'relic-bridge-config',
      version: 1,
      exportedAt: new Date(NOW).toISOString(),
      users: [
        { email: 'o@example.com', displayName: null, role: 'owner' },
        { email: 'v@example.com', displayName: null, role: 'member' },
      ],
      credentials: [{ ref: 'c1', owner: 'v@example.com', label: 'victim-key', region: 'US' }],
      projects: [
        {
          slug: 'grab',
          name: null,
          defaultAccountId: 1,
          allowedAccountIds: [1],
          enabledTools: null,
          limits: {},
          defaultCredential: 'c1',
          disabled: false,
        },
      ],
      grants: [
        {
          project: 'grab',
          user: 'o@example.com',
          label: null,
          credential: null,
          tools: null,
          accountIds: null,
          limits: {},
          rateLimit: null,
          expiresAt: null,
        },
      ],
      settings: {},
    } as unknown as ConfigBundle;
    for (const actor of [owner.id, null]) {
      const r = await importConfig(t.deps, bundle, { apply: true, actorUserId: actor });
      expect(r.failed).toBeNull();
      const project = (await t.storage.projects.list()).find((p) => p.slug === 'grab');
      expect(project?.defaultCredentialId).not.toBe(key.id);
      expect(project?.defaultCredentialId).toBeNull();
      expect(r.entries.find((e) => e.kind === 'grant')).toMatchObject({ action: 'skip' });
      expect((await t.storage.grants.list()).some((g) => g.projectId === project?.id)).toBe(false);
    }
  });

  it('stops at the first failure with a code, applies nothing after it, and resumes on the next run', async () => {
    const s = await source();
    const { bundle } = await exportConfig({ ...s, clock }, sealedOpts());
    const t = await target();
    let reject = true;
    const flaky: KeyValidator = (c) =>
      reject && c.apiKey.reveal() === KEY_B
        ? Promise.reject(new RbError(ErrorCode.AuthInvalidKey, 'New Relic rejected the User API key.'))
        : validate(c);
    const r = await importConfig({ ...t.deps, validate: flaky }, bundle, { apply: true, wrapKey: wrap });
    expect(r.failed).toMatchObject({
      kind: 'credential',
      key: 'm@example.com|mine',
      code: ErrorCode.AuthInvalidKey,
    });
    expect(r.failed?.message).not.toContain(KEY_B);
    expect(await t.storage.credentials.list()).toHaveLength(1);
    expect(await t.storage.projects.list()).toHaveLength(0);
    expect(await t.storage.grants.list()).toHaveLength(0);
    reject = false;
    const ok = await importConfig(t.deps, bundle, { apply: true, wrapKey: wrap });
    expect(ok.failed).toBeNull();
    expect(ok.entries.find((e) => e.kind === 'credential' && e.key.endsWith('shared'))?.action).toBe(
      'unchanged',
    );
    expect(await t.storage.credentials.list()).toHaveLength(2);
    expect(await t.storage.grants.list()).toHaveLength(3);
  });

  it('refuses a bundle naming a tool this server does not have, before changing anything', async () => {
    const s = await source();
    const { bundle } = await exportConfig({ ...s, clock });
    const t = await target();
    await expect(
      importConfig({ ...t.deps, catalog: ['run_nrql'] }, bundle, { apply: true }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(await t.storage.users.list()).toHaveLength(0);
  });
});

describe('validateBundle', () => {
  const base: ConfigBundle = {
    format: 'relic-bridge-config',
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    users: [{ email: 'a@example.com', displayName: null, role: 'member' }],
    credentials: [],
    projects: [
      {
        slug: 'p',
        name: null,
        defaultAccountId: 1,
        allowedAccountIds: [1],
        enabledTools: null,
        limits: {},
        defaultCredential: null,
        disabled: false,
      },
    ],
    grants: [],
    settings: {},
  };
  const grant = {
    project: 'p',
    user: 'a@example.com',
    label: null,
    credential: null,
    tools: null,
    accountIds: null,
    limits: {},
    rateLimit: null,
    expiresAt: null,
  };
  const bad = (b: Partial<ConfigBundle>) =>
    expect(() => validateBundle({ ...base, ...b }, CATALOG)).toThrow();

  it('accepts a consistent bundle and rejects dangling references, duplicates, unknown tools and caps', () => {
    expect(() => validateBundle({ ...base, grants: [grant] }, CATALOG)).not.toThrow();
    bad({ grants: [{ ...grant, project: 'nope' }] });
    bad({ grants: [{ ...grant, user: 'x@example.com' }] });
    bad({ grants: [{ ...grant, credential: 'c1' }] });
    bad({ grants: [grant, grant] });
    bad({ grants: [{ ...grant, user: null, label: null }] });
    bad({ grants: [{ ...grant, tools: ['drop_database'] }] });
    bad({ projects: [...base.projects, ...base.projects] });
    bad({ projects: [{ ...(base.projects[0] as BundleProject), defaultAccountId: 9 }] });
    bad({ projects: [{ ...(base.projects[0] as BundleProject), enabledTools: ['nope'] }] });
    bad({ projects: [{ ...(base.projects[0] as BundleProject), slug: 'Bad Slug' }] });
    bad({ users: [...base.users, ...base.users] });
    bad({
      users: Array.from({ length: 201 }, (_, i) => ({
        email: `u${i}@example.com`,
        displayName: null,
        role: 'member' as const,
      })),
    });
    bad({ credentials: [{ ref: 'c', label: 'l', region: 'US', owner: 'ghost@example.com' }] });
  });
});
