// SPDX-License-Identifier: Apache-2.0
import { type Credential, ErrorCode, type Identity, RbError, Secret } from '@relic-bridge/core';
import { createMemoryStorage, type Storage } from '@relic-bridge/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import { createGrant, createProject } from '../src/access/config.ts';
import {
  createCredential,
  type KeyValidator,
  nerdGraphKeyValidator,
  revalidateCredential,
  revalidateCredentials,
} from '../src/access/credentials.ts';
import { listEffectivePermissions, openCredential, resolveAccess } from '../src/access/load.ts';
import { generateMasterKey, Keyring } from '../src/crypto/keyring.ts';
import { CATALOG, NOW } from './access-fixtures.ts';

const KEY_A = 'NRAK-AAAAAAAAAAAAAAAAAAAAAAAAAAA1';
const KEY_B = 'NRAK-BBBBBBBBBBBBBBBBBBBBBBBBBBB2';

/** A fake New Relic: which accounts each key reaches, or the error it answers with. */
function fakeValidator(
  world: Map<string, readonly number[] | RbError>,
): KeyValidator & { calls: Credential[] } {
  const calls: Credential[] = [];
  const fn = async (c: Credential): Promise<Identity> => {
    calls.push(c);
    const r = world.get(c.apiKey.reveal());
    if (r === undefined) throw new RbError(ErrorCode.AuthInvalidKey, 'New Relic rejected the User API key.');
    if (r instanceof RbError) throw r;
    return {
      user: { id: 7, email: 'a@example.com', name: 'A' },
      accounts: r.map((id) => ({ id, name: `acct ${id}` })),
    };
  };
  return Object.assign(fn, { calls });
}

let storage: Storage;
let keyring: Keyring;
let world: Map<string, readonly number[] | RbError>;
let validate: ReturnType<typeof fakeValidator>;
const clock = { now: () => NOW };

beforeEach(async () => {
  storage = createMemoryStorage({ now: () => NOW });
  keyring = await Keyring.create({ current: generateMasterKey(1) });
  world = new Map([
    [KEY_A, [1, 2, 3]],
    [KEY_B, [10, 11]],
  ]);
  validate = fakeValidator(world);
  await storage.users.create({ id: 'usr_a', email: 'a@example.com', role: 'owner' });
  await storage.users.create({ id: 'usr_b', email: 'b@example.com', role: 'member' });
});

const deps = () => ({ storage, keyring, validate, clock });

async function personalSetup() {
  const cred = await createCredential(deps(), {
    label: 'mine',
    region: 'US',
    apiKey: new Secret(KEY_A),
    ownerUserId: 'usr_a',
  });
  const proj = await createProject(
    storage,
    { slug: 'prod', defaultAccountId: 1, allowedAccountIds: [1, 2], defaultCredentialId: cred.id },
    CATALOG,
  );
  const { grant } = await createGrant(storage, { projectId: proj.id, userId: 'usr_a' }, CATALOG, NOW);
  return { cred, proj, grant };
}

describe('createCredential', () => {
  it('validates, encrypts and stores reachable accounts; never stores the plaintext', async () => {
    const cred = await createCredential(deps(), {
      label: ' mine ',
      region: 'US',
      apiKey: new Secret(` ${KEY_A} `),
    });
    expect(cred).toMatchObject({
      label: 'mine',
      region: 'US',
      keyHint: 'AAA1',
      validationStatus: 'valid',
      validatedAt: NOW,
      nrUserId: 7,
      nrUserEmail: 'a@example.com',
      reachableAccountIds: [1, 2, 3],
      ownerUserId: null,
    });
    expect(cred.id).toMatch(/^cred_[0-9a-f]{32}$/);
    expect(validate.calls[0]?.id).toBe(cred.id);
    if (cred.key.kind !== 'encrypted') throw new Error('not encrypted');
    expect((await keyring.decryptCredentialKey(cred.id, cred.key)).reveal()).toBe(KEY_A);
    expect(new TextDecoder().decode(cred.key.ciphertext)).not.toContain('AAAAAAAA');
  });

  it('stores nothing for a key New Relic refuses, or a malformed one', async () => {
    world.delete(KEY_A);
    await expect(
      createCredential(deps(), { label: 'x', region: 'US', apiKey: new Secret(KEY_A) }),
    ).rejects.toMatchObject({
      code: ErrorCode.AuthInvalidKey,
    });
    await expect(
      createCredential(deps(), { label: 'x', region: 'US', apiKey: new Secret('not-a-user-key') }),
    ).rejects.toMatchObject({ code: ErrorCode.AuthInvalidKey });
    expect(validate.calls.length).toBe(1); // the malformed key never reached New Relic
    expect(await storage.credentials.list()).toEqual([]);
  });

  it('refuses bad labels, regions and unknown owners', async () => {
    const k = new Secret(KEY_A);
    await expect(createCredential(deps(), { label: '', region: 'US', apiKey: k })).rejects.toMatchObject({
      field: 'label',
    });
    await expect(
      createCredential(deps(), { label: 'x', region: 'XX' as 'US', apiKey: k }),
    ).rejects.toMatchObject({
      field: 'region',
    });
    await expect(
      createCredential(deps(), { label: 'x', region: 'US', apiKey: k, ownerUserId: 'usr_zz' }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(validate.calls.length).toBe(0);
  });
});

describe('revalidateCredential(s)', () => {
  it('detects a key revoked in New Relic and access then fails closed', async () => {
    const { cred, grant } = await personalSetup();
    expect(
      (
        await resolveAccess({
          storage,
          projectSlug: 'prod',
          principal: { grantId: grant.id },
          catalog: CATALOG,
          now: NOW,
        })
      ).ok,
    ).toBe(true);
    world.delete(KEY_A);
    const r = await revalidateCredential(deps(), cred.id);
    expect(r).toMatchObject({ outcome: 'invalid', code: ErrorCode.AuthInvalidKey });
    expect(await storage.credentials.get(cred.id)).toMatchObject({
      validationStatus: 'invalid',
      validationErrorCode: ErrorCode.AuthInvalidKey,
      reachableAccountIds: null,
    });
    expect(
      await resolveAccess({
        storage,
        projectSlug: 'prod',
        principal: { grantId: grant.id },
        catalog: CATALOG,
        now: NOW,
      }),
    ).toEqual({
      ok: false,
      reason: 'credential_invalid',
    });
    // Restored key → valid again.
    world.set(KEY_A, [1]);
    expect(await revalidateCredential(deps(), cred.id)).toMatchObject({
      outcome: 'valid',
      accountsAdded: [1],
      accountsRemoved: [],
    });
  });

  it('refreshes reachable accounts, which narrows access', async () => {
    const { cred, grant } = await personalSetup();
    world.set(KEY_A, [2, 3, 4]);
    expect(await revalidateCredential(deps(), cred.id)).toMatchObject({
      outcome: 'valid',
      accountsAdded: [4],
      accountsRemoved: [1],
    });
    const r = await resolveAccess({
      storage,
      projectSlug: 'prod',
      principal: { grantId: grant.id },
      catalog: CATALOG,
      now: NOW,
    });
    expect(r.ok && r.access.accounts).toEqual({ allowed: [2], default: 2 });
  });

  it('wrong region and HTTP 403 count as refused; transient errors change nothing', async () => {
    const { cred } = await personalSetup();
    world.set(KEY_A, new RbError(ErrorCode.NerdGraphUnavailable, 'down'));
    expect(await revalidateCredential(deps(), cred.id)).toMatchObject({
      outcome: 'error',
      code: ErrorCode.NerdGraphUnavailable,
    });
    world.set(KEY_A, new RbError(ErrorCode.NerdGraphRateLimited, 'slow down'));
    expect(await revalidateCredential(deps(), cred.id)).toMatchObject({ outcome: 'error' });
    expect((await storage.credentials.get(cred.id))?.validationStatus).toBe('valid');
    for (const code of [ErrorCode.AuthWrongRegion, ErrorCode.AuthForbidden]) {
      world.set(KEY_A, new RbError(code, 'no'));
      expect(await revalidateCredential(deps(), cred.id)).toMatchObject({ outcome: 'invalid', code });
    }
  });

  it('a non-RbError from the validator propagates (programming error, not a verdict)', async () => {
    const { cred } = await personalSetup();
    const broken: KeyValidator = async () => {
      throw new TypeError('boom');
    };
    await expect(revalidateCredential({ ...deps(), validate: broken }, cred.id)).rejects.toThrow(TypeError);
    expect((await storage.credentials.get(cred.id))?.validationStatus).toBe('valid');
  });

  it('skips revoked credentials and reports decryption failures without touching the row', async () => {
    const { cred } = await personalSetup();
    const other = await Keyring.create({ current: generateMasterKey(1) });
    expect(await revalidateCredential({ ...deps(), keyring: other }, cred.id)).toMatchObject({
      outcome: 'error',
      code: 'decrypt_failed',
    });
    await storage.credentials.update(cred.id, { revokedAt: NOW });
    expect(await revalidateCredential(deps(), cred.id)).toMatchObject({
      outcome: 'skipped',
      code: 'revoked',
    });
    await expect(revalidateCredential(deps(), 'cred_missing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('never labels a key that was replaced while it was being checked', async () => {
    const { cred } = await personalSetup();
    const racing: KeyValidator = async (c) => {
      // The key is replaced (re-encrypted) between decryption and the write.
      await storage.credentials.update(cred.id, { key: await keyring.encryptCredentialKey(cred.id, KEY_B) });
      throw new RbError(ErrorCode.AuthInvalidKey, `rejected ${c.id}`);
    };
    expect(await revalidateCredential({ ...deps(), validate: racing }, cred.id)).toMatchObject({
      outcome: 'error',
      code: 'key_changed',
    });
    expect((await storage.credentials.get(cred.id))?.validationStatus).toBe('valid');
  });

  it('revalidates every credential', async () => {
    await personalSetup();
    await createCredential(deps(), { label: 'b', region: 'EU', apiKey: new Secret(KEY_B) });
    world.delete(KEY_B);
    const all = await revalidateCredentials(deps());
    expect(all.map((r) => r.outcome).sort()).toEqual(['invalid', 'valid']);
  });

  it('the NerdGraph validator sends one identity query with the key', async () => {
    const seen: { url: string; key: string | null; body: string }[] = [];
    const v = nerdGraphKeyValidator({
      fetch: async (url, init) => {
        seen.push({ url, key: new Headers(init.headers).get('API-Key'), body: String(init.body) });
        return new Response(
          JSON.stringify({
            data: {
              actor: { user: { id: 7, email: 'a@example.com', name: 'A' }, accounts: [{ id: 5, name: 'x' }] },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const id = await v({ id: 'cred_x', region: 'EU', apiKey: new Secret(KEY_A) });
    expect(id.accounts).toEqual([{ id: 5, name: 'x' }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toContain('eu.newrelic.com');
    expect(seen[0]?.key).toBe(KEY_A);
    expect(seen[0]?.body).toContain('"scope":"IN_REGION"');
  });
});

describe('createProject / createGrant', () => {
  it('validates projects', async () => {
    const base = { slug: 'p1', defaultAccountId: 1, allowedAccountIds: [1, 2] };
    await expect(createProject(storage, { ...base, slug: 'Bad Slug' }, CATALOG)).rejects.toMatchObject({
      field: 'slug',
    });
    await expect(createProject(storage, { ...base, defaultAccountId: 3 }, CATALOG)).rejects.toMatchObject({
      field: 'defaultAccountId',
    });
    await expect(createProject(storage, { ...base, allowedAccountIds: [] }, CATALOG)).rejects.toMatchObject({
      field: 'allowedAccountIds',
    });
    await expect(
      createProject(storage, { ...base, allowedAccountIds: [1, -2] }, CATALOG),
    ).rejects.toMatchObject({
      field: 'allowedAccountIds',
    });
    await expect(
      createProject(storage, { ...base, enabledTools: ['whoami', 'run_nrq'] }, CATALOG),
    ).rejects.toMatchObject({
      field: 'enabledTools',
    });
    await expect(createProject(storage, { ...base, limits: { maxLimit: 0 } }, CATALOG)).rejects.toMatchObject(
      {
        field: 'limits',
      },
    );
    await expect(
      createProject(storage, { ...base, defaultCredentialId: 'cred_none' }, CATALOG),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    const p = await createProject(
      storage,
      { ...base, allowedAccountIds: [1, 2, 2], name: ' Prod ' },
      CATALOG,
    );
    expect(p).toMatchObject({
      slug: 'p1',
      name: 'Prod',
      allowedAccountIds: [1, 2],
      enabledTools: null,
      limits: {},
    });
  });

  it('a grant asking for more than the project is stored with warnings and resolves to the intersection', async () => {
    const { proj } = await personalSetup();
    await storage.projects.update(proj.id, { enabledTools: ['whoami', 'list_accounts'] });
    const { grant, warnings } = await createGrant(
      storage,
      {
        projectId: proj.id,
        userId: 'usr_a',
        tools: ['whoami', 'run_nrql'],
        accountIds: [2, 3],
        limits: { maxLimit: 10 },
      },
      CATALOG,
      NOW,
    );
    expect(warnings).toEqual([
      'tools not enabled on the project (no effect): run_nrql',
      'accounts not allowed on the project (no effect): 3',
    ]);
    const r = await resolveAccess({
      storage,
      projectSlug: 'prod',
      principal: { grantId: grant.id },
      catalog: CATALOG,
      now: NOW,
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.access.tools).toEqual(['whoami']);
    expect(r.access.accounts).toEqual({ allowed: [2], default: 2 });
    expect(r.access.limits.maxLimit).toBe(10);
  });

  it('validates grants', async () => {
    const { proj } = await personalSetup();
    const g = (over: Record<string, unknown>) =>
      createGrant(storage, { projectId: proj.id, userId: 'usr_a', ...over }, CATALOG, NOW);
    await expect(g({ projectId: 'prj_none' })).rejects.toMatchObject({ field: 'projectId' });
    await expect(g({ userId: null })).rejects.toMatchObject({ field: 'label' });
    await expect(g({ userId: 'usr_none' })).rejects.toMatchObject({ field: 'userId' });
    await expect(g({ tools: ['nope'] })).rejects.toMatchObject({ field: 'tools' });
    await expect(g({ tools: [] })).rejects.toMatchObject({ field: 'tools' });
    await expect(g({ accountIds: [] })).rejects.toMatchObject({ field: 'accountIds' });
    await expect(g({ limits: { rawNrql: 'yes' } })).rejects.toMatchObject({ field: 'limits' });
    await expect(g({ rateLimit: { requests: 0, perSeconds: 60 } })).rejects.toMatchObject({
      field: 'rateLimit',
    });
    await expect(g({ expiresAt: NOW })).rejects.toMatchObject({ field: 'expiresAt' });
    await expect(g({ credentialId: 'cred_none' })).rejects.toMatchObject({ code: 'not_found' });
    const { grant: svc } = await createGrant(storage, { projectId: proj.id, label: 'ci' }, CATALOG, NOW);
    expect(svc).toMatchObject({ userId: null, label: 'ci', credentialId: null });
  });

  it("BYO key: a grant may use its own user's key, never another user's", async () => {
    const { proj } = await personalSetup();
    const keyB = await createCredential(deps(), {
      label: 'b',
      region: 'US',
      apiKey: new Secret(KEY_B),
      ownerUserId: 'usr_b',
    });
    await expect(
      createGrant(storage, { projectId: proj.id, userId: 'usr_a', credentialId: keyB.id }, CATALOG, NOW),
    ).rejects.toMatchObject({ code: 'not_permitted' });
    await expect(
      createGrant(storage, { projectId: proj.id, label: 'ci', credentialId: keyB.id }, CATALOG, NOW),
    ).rejects.toMatchObject({ code: 'not_permitted' });
    const { grant } = await createGrant(
      storage,
      { projectId: proj.id, userId: 'usr_b', credentialId: keyB.id },
      CATALOG,
      NOW,
    );
    // Key B reaches 10 and 11, the project allows 1 and 2: nothing in common.
    expect(
      await resolveAccess({
        storage,
        projectSlug: 'prod',
        principal: { grantId: grant.id },
        catalog: CATALOG,
        now: NOW,
      }),
    ).toEqual({
      ok: false,
      reason: 'no_accounts',
    });
    // A grant that needs the project default when there is none.
    const bare = await createProject(
      storage,
      { slug: 'bare', defaultAccountId: 1, allowedAccountIds: [1] },
      CATALOG,
    );
    await expect(
      createGrant(storage, { projectId: bare.id, userId: 'usr_a' }, CATALOG, NOW),
    ).rejects.toMatchObject({
      field: 'credentialId',
    });
  });
});

describe('resolveAccess', () => {
  it('team default key: disabling its owner stops it for every grant (and a service grant reads the owner)', async () => {
    const { proj } = await personalSetup();
    const { grant: bobs } = await createGrant(storage, { projectId: proj.id, userId: 'usr_b' }, CATALOG, NOW);
    const { grant: ci } = await createGrant(storage, { projectId: proj.id, label: 'ci' }, CATALOG, NOW);
    const r = (grantId: string) =>
      resolveAccess({ storage, projectSlug: 'prod', principal: { grantId }, catalog: CATALOG, now: NOW });
    expect((await r(bobs.id)).ok).toBe(true);
    expect((await r(ci.id)).ok).toBe(true);
    await storage.users.update('usr_a', { disabledAt: NOW });
    expect(await r(bobs.id)).toEqual({ ok: false, reason: 'credential_owner_disabled' });
    expect(await r(ci.id)).toEqual({ ok: false, reason: 'credential_owner_disabled' });
    const listed = await listEffectivePermissions({ storage, catalog: CATALOG, now: NOW });
    expect(listed.map((e) => (e.decision.ok ? 'ok' : e.decision.reason)).sort()).toEqual([
      'credential_owner_disabled',
      'credential_owner_disabled',
      'user_disabled',
    ]);
  });

  it('denies unknown and malformed slugs and grants without leaking which', async () => {
    const { grant } = await personalSetup();
    const r = (projectSlug: string, grantId: string) =>
      resolveAccess({ storage, projectSlug, principal: { grantId }, catalog: CATALOG, now: NOW });
    expect(await r('nope', grant.id)).toEqual({ ok: false, reason: 'project_not_found' });
    expect(await r('../prod', grant.id)).toEqual({ ok: false, reason: 'project_not_found' });
    expect(await r('prod', 'grt_none')).toEqual({ ok: false, reason: 'grant_not_found' });
    expect(await r('prod', '')).toEqual({ ok: false, reason: 'invalid_request' });
    expect(await r('prod', 'x'.repeat(500))).toEqual({ ok: false, reason: 'invalid_request' });
  });

  it('a grant of project A is refused on project B (T2), and B is not read further', async () => {
    const { grant, cred } = await personalSetup();
    await createProject(
      storage,
      { slug: 'other', defaultAccountId: 1, allowedAccountIds: [1], defaultCredentialId: cred.id },
      CATALOG,
    );
    expect(
      await resolveAccess({
        storage,
        projectSlug: 'other',
        principal: { grantId: grant.id },
        catalog: CATALOG,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'grant_wrong_project' });
  });

  it('revocation, expiry, disabling and deletion take effect on the next resolution', async () => {
    const { grant, proj, cred } = await personalSetup();
    const r = () =>
      resolveAccess({
        storage,
        projectSlug: 'prod',
        principal: { grantId: grant.id },
        catalog: CATALOG,
        now: NOW,
      });
    expect((await r()).ok).toBe(true);
    await storage.grants.update(grant.id, { expiresAt: NOW });
    expect(await r()).toEqual({ ok: false, reason: 'grant_expired' });
    await storage.grants.update(grant.id, { expiresAt: null });
    await storage.users.update('usr_a', { disabledAt: NOW });
    expect(await r()).toEqual({ ok: false, reason: 'user_disabled' });
    await storage.users.update('usr_a', { disabledAt: null });
    await storage.credentials.update(cred.id, { revokedAt: NOW });
    expect(await r()).toEqual({ ok: false, reason: 'credential_revoked' });
    await storage.credentials.update(cred.id, { revokedAt: null });
    await storage.projects.update(proj.id, { disabledAt: NOW });
    expect(await r()).toEqual({ ok: false, reason: 'project_disabled' });
    await storage.projects.update(proj.id, { disabledAt: null });
    await storage.grants.update(grant.id, { revokedAt: NOW });
    expect(await r()).toEqual({ ok: false, reason: 'grant_revoked' });
    await storage.grants.delete(grant.id);
    expect(await r()).toEqual({ ok: false, reason: 'grant_not_found' });
  });

  it('storage errors propagate (the caller fails closed)', async () => {
    const failing = {
      ...storage,
      projects: { ...storage.projects, getBySlug: async () => Promise.reject(new Error('db down')) },
    };
    await expect(
      resolveAccess({
        storage: failing,
        projectSlug: 'prod',
        principal: { grantId: 'grt_x' },
        catalog: CATALOG,
        now: NOW,
      }),
    ).rejects.toThrow('db down');
  });

  it('openCredential decrypts the resolved key into a Secret and refuses another record', async () => {
    const { grant } = await personalSetup();
    const r = await resolveAccess({
      storage,
      projectSlug: 'prod',
      principal: { grantId: grant.id },
      catalog: CATALOG,
      now: NOW,
    });
    if (!r.ok) throw new Error(r.reason);
    const c = await openCredential(r.access, r.credential, { keyring });
    expect(c.apiKey.reveal()).toBe(KEY_A);
    expect(JSON.stringify(c)).not.toContain(KEY_A);
    await expect(openCredential(r.access, r.credential, {})).rejects.toMatchObject({ field: 'keyring' });
    await expect(
      openCredential(r.access, { ...r.credential, id: 'cred_other' }, { keyring }),
    ).rejects.toMatchObject({
      field: 'credential',
    });
    // yaml references
    const envRec = { ...r.credential, key: { kind: 'env' as const, variable: 'NR_KEY' } };
    expect((await openCredential(r.access, envRec, { env: { NR_KEY: KEY_B } })).apiKey.reveal()).toBe(KEY_B);
    await expect(openCredential(r.access, envRec, { env: {} })).rejects.toMatchObject({ code: 'not_found' });
    const inline = { ...r.credential, key: { kind: 'inline' as const, reveal: () => KEY_B } };
    expect((await openCredential(r.access, inline, {})).apiKey.reveal()).toBe(KEY_B);
  });
});

describe('listEffectivePermissions', () => {
  it('lists each grant with its decision', async () => {
    const { proj } = await personalSetup();
    await createGrant(storage, { projectId: proj.id, userId: 'usr_b', tools: ['whoami'] }, CATALOG, NOW);
    const { grant: revoked } = await createGrant(storage, { projectId: proj.id, label: 'old' }, CATALOG, NOW);
    await storage.grants.update(revoked.id, { revokedAt: NOW });
    const all = await listEffectivePermissions({ storage, catalog: CATALOG, now: NOW });
    expect(all).toHaveLength(3);
    expect(all.every((e) => e.projectSlug === 'prod')).toBe(true);
    const byUser = await listEffectivePermissions({
      storage,
      filter: { userId: 'usr_b' },
      catalog: CATALOG,
      now: NOW,
    });
    expect(byUser).toHaveLength(1);
    expect(byUser[0]?.decision.ok && byUser[0].decision.access.tools).toEqual(['whoami']);
    const old = all.find((e) => e.grant.id === revoked.id);
    expect(old?.decision).toEqual({ ok: false, reason: 'grant_revoked' });
  });
});
