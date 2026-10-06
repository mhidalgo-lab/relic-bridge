// SPDX-License-Identifier: Apache-2.0
// P7-12: the quota in the access model: validated on create and set, carried by the resolver, exported and imported.
import { type Credential, type Identity, Secret } from '@relic-bridge/core';
import { createMemoryStorage } from '@relic-bridge/storage';
import { describe, expect, it } from 'vitest';
import { checkQuota, createGrant, createProject, setGrantQuota } from '../src/access/config.ts';
import { createCredential, type KeyValidator } from '../src/access/credentials.ts';
import { AccessError } from '../src/access/errors.ts';
import { computeAccess } from '../src/access/resolve.ts';
import { generateMasterKey, Keyring } from '../src/crypto/keyring.ts';
import { deriveWrapKey, exportConfig, importConfig, newKdf, validateBundle } from '../src/transfer/index.ts';
import { CATALOG, grant, input, NOW } from './access-fixtures.ts';

const clock = { now: () => NOW };
const KEY = 'NRAK-AAAAAAAAAAAAAAAAAAAAAAAAAAA1';
const validate: KeyValidator = (_c: Credential): Promise<Identity> =>
  Promise.resolve({
    user: { id: 7, email: 'a@example.com', name: 'A' },
    accounts: [{ id: 1, name: 'one' }],
  });

describe('checkQuota', () => {
  it('accepts day, month and a warning percentage, and keeps only known fields', () => {
    expect(
      checkQuota({ day: { queries: 5 }, month: { inspectedEvents: 1_000 }, warnPercent: 50 }, 'q'),
    ).toEqual({
      day: { queries: 5 },
      month: { inspectedEvents: 1_000 },
      warnPercent: 50,
    });
    expect(checkQuota(null, 'q')).toBeNull();
    expect(checkQuota(undefined, 'q')).toBeNull();
  });

  it.each([
    {},
    { day: {} },
    { day: { queries: 0 } },
    { day: { queries: 1.5 } },
    { day: { queries: Number.MAX_SAFE_INTEGER } },
    { day: { queries: '5' } },
    { day: { queries: 5, bogus: 1 } },
    { week: { queries: 5 } },
    { day: { queries: 5 }, warnPercent: 100 },
    { day: { queries: 5 }, warnPercent: 0 },
    { day: { queries: 5 }, warnPercent: 1.5 },
    { day: null },
    [],
    'x',
  ])('refuses %j', (bad) => {
    expect(() => checkQuota(bad, 'quota')).toThrow(AccessError);
  });
});

describe('resolver', () => {
  it('carries the grant quota (frozen) and none when the grant has none', () => {
    const none = computeAccess(input());
    expect(none.ok && none.access.quota).toBeNull();
    const d = computeAccess(input({ grant: grant({ quota: { day: { queries: 3 }, warnPercent: 70 } }) }));
    if (!d.ok) throw new Error(d.reason);
    expect(d.access.quota).toEqual({ day: { queries: 3 }, warnPercent: 70 });
    expect(Object.isFrozen(d.access.quota)).toBe(true);
    expect(Object.isFrozen(d.access.quota?.day)).toBe(true);
  });

  it('fails closed on a stored quota that is not well formed', () => {
    for (const bad of [
      { day: { queries: -1 } },
      { day: {} },
      { nope: 1 },
      { day: { queries: 1 }, warnPercent: 500 },
    ]) {
      const d = computeAccess(input({ grant: grant({ quota: bad as never }) }));
      expect(d).toEqual({ ok: false, reason: 'invalid_config' });
    }
  });
});

describe('services', () => {
  async function seeded() {
    const storage = createMemoryStorage({ now: () => NOW });
    await storage.credentials.create({
      id: 'c',
      label: 'k',
      region: 'US',
      key: { kind: 'encrypted', ciphertext: new Uint8Array(32), iv: new Uint8Array(12), keyVersion: 1 },
    });
    const project = await createProject(
      storage,
      { slug: 'prod', defaultAccountId: 1, allowedAccountIds: [1], defaultCredentialId: 'c' },
      CATALOG,
    );
    return { storage, project };
  }

  it('createGrant stores a validated quota and refuses a bad one', async () => {
    const { storage, project } = await seeded();
    const { grant: g } = await createGrant(
      storage,
      { projectId: project.id, label: 'ci', quota: { month: { queries: 10 } } },
      CATALOG,
      NOW,
    );
    expect(g.quota).toEqual({ month: { queries: 10 } });
    await expect(
      createGrant(
        storage,
        { projectId: project.id, label: 'bad', quota: { day: { queries: 0 } } },
        CATALOG,
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input', field: 'quota' });
  });

  it('setGrantQuota sets, replaces and clears; an unknown grant is not found', async () => {
    const { storage, project } = await seeded();
    const { grant: g } = await createGrant(storage, { projectId: project.id, label: 'ci' }, CATALOG, NOW);
    expect((await setGrantQuota(storage, g.id, { day: { queries: 2 } })).quota).toEqual({
      day: { queries: 2 },
    });
    expect((await setGrantQuota(storage, g.id, { month: { queries: 9 } })).quota).toEqual({
      month: { queries: 9 },
    });
    expect((await setGrantQuota(storage, g.id, null)).quota).toBeNull();
    await expect(setGrantQuota(storage, 'ghost', null)).rejects.toMatchObject({ code: 'not_found' });
    await expect(setGrantQuota(storage, g.id, { day: {} } as never)).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe('import and export', () => {
  async function world() {
    const storage = createMemoryStorage({ now: () => NOW });
    const keyring = await Keyring.create({ current: generateMasterKey(1) });
    await storage.users.create({ id: 'usr_o', email: 'o@example.com', role: 'owner' });
    const cred = await createCredential(
      { storage, keyring, validate, clock },
      { label: 'shared', region: 'US', apiKey: new Secret(KEY) },
    );
    const project = await createProject(
      storage,
      { slug: 'prod', defaultAccountId: 1, allowedAccountIds: [1], defaultCredentialId: cred.id },
      CATALOG,
    );
    await createGrant(
      storage,
      { projectId: project.id, label: 'ci', quota: { day: { queries: 7 }, warnPercent: 60 } },
      CATALOG,
      NOW,
    );
    await createGrant(storage, { projectId: project.id, label: 'plain' }, CATALOG, NOW);
    return { storage, keyring };
  }

  it('exports the quota and imports it into an empty instance, then a second run changes nothing', async () => {
    const src = await world();
    const kdf = newKdf();
    const wrap = await deriveWrapKey('correct horse battery staple', kdf);
    const { bundle } = await exportConfig({ ...src, clock }, { wrap: { key: wrap, kdf } });
    const quotas = Object.fromEntries(bundle.grants.map((g) => [g.label, g.quota ?? null]));
    expect(quotas).toEqual({ ci: { day: { queries: 7 }, warnPercent: 60 }, plain: null });
    validateBundle(bundle, CATALOG);

    const dst = createMemoryStorage({ now: () => NOW });
    const deps = {
      storage: dst,
      keyring: await Keyring.create({ current: generateMasterKey(1) }),
      validate,
      catalog: CATALOG,
      clock,
    };
    const first = await importConfig(deps, bundle, { apply: true, wrapKey: wrap });
    expect(first.failed).toBeNull();
    const imported = (await dst.grants.list()).find((g) => g.label === 'ci');
    expect(imported?.quota).toEqual({ day: { queries: 7 }, warnPercent: 60 });
    const second = await importConfig(deps, bundle, { apply: true, wrapKey: wrap });
    expect(second.summary).toMatchObject({ create: 0 });
    expect((await dst.grants.list()).filter((g) => g.label === 'ci')).toHaveLength(1);
  });

  it('a file from before quotas (no quota field) imports as no quota; a malformed quota is refused', async () => {
    const src = await world();
    const { bundle } = await exportConfig({ ...src, clock });
    const old = {
      ...bundle,
      grants: bundle.grants.map(({ quota: _q, ...rest }) => rest),
    };
    validateBundle(old, CATALOG);
    const bad = {
      ...bundle,
      grants: bundle.grants.map((g) => ({ ...g, quota: { day: { queries: -3 } } })),
    };
    expect(() => validateBundle(bad, CATALOG)).toThrow(AccessError);
    expect(() => validateBundle(bad, CATALOG)).toThrow(/invalid quota/);
  });
});
