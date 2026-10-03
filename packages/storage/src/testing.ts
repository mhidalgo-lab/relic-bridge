// SPDX-License-Identifier: Apache-2.0
// Shared contract suite every `Storage` adapter must pass (P2-01). Use it from an adapter's test file:
//
//   runStorageContract({ name: 'sqlite', create: ({ now }) => openTestDb({ now }) });
//
// Read paths run against a seeded fixture for every adapter. Writable adapters (`create`) also get the write,
// constraint, append-only audit and KV-expiry checks; read-only adapters must reject every write.
import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
  ReadOnlyStorageError,
  StorageError,
} from './errors.ts';
import type { EncryptedKey, NrRegion, Storage, StoredLimits } from './types.ts';

export interface ContractClock {
  now(): number;
}

export interface ContractFixtureProject {
  readonly slug: string;
  readonly name: string | null;
  readonly region: NrRegion;
  readonly defaultAccountId: number;
  readonly allowedAccountIds: readonly number[];
  readonly enabledTools: readonly string[] | null;
  readonly limits: StoredLimits;
  /** Plaintext stand-in for the NR key. It must never appear in a serialised record. */
  readonly secret: string;
}

export interface ContractFixture {
  readonly projects: readonly ContractFixtureProject[];
}

/** Two projects, one credential each. Project ids are the slugs; credential ids are `project:<slug>`. */
export const CONTRACT_FIXTURE: ContractFixture = Object.freeze({
  projects: Object.freeze([
    Object.freeze({
      slug: 'acme-prod',
      name: 'Acme production',
      region: 'US' as const,
      defaultAccountId: 1001,
      allowedAccountIds: Object.freeze([1001, 1002]),
      enabledTools: Object.freeze(['run_nrql', 'whoami']),
      limits: Object.freeze({ maxLimit: 200, rawNrql: false }),
      secret: 'NRAK-CONTRACTFIXTUREAAAAAAAAAAAAAAA',
    }),
    Object.freeze({
      slug: 'side-eu',
      name: null,
      region: 'EU' as const,
      defaultAccountId: 2001,
      allowedAccountIds: Object.freeze([2001]),
      enabledTools: null,
      limits: Object.freeze({}),
      secret: 'NRAK-CONTRACTFIXTUREBBBBBBBBBBBBBBB',
    }),
  ]),
});

export interface StorageContractOptions {
  readonly name: string;
  /** A fresh, empty, writable storage using `clock`. Omit for read-only adapters. */
  readonly create?: (clock: ContractClock) => Promise<Storage>;
  /** A storage holding `fixture`. Defaults to `create` plus writes through the API. Required when `create` is absent. */
  readonly createSeeded?: (fixture: ContractFixture, clock: ContractClock) => Promise<Storage>;
}

/** Deterministic, never-the-secret ciphertext for fixtures. */
export function fakeEncryptedKey(seed = 1, keyVersion = 1): EncryptedKey {
  return {
    kind: 'encrypted',
    ciphertext: Uint8Array.from({ length: 40 }, (_, i) => (i * 7 + seed) % 256),
    iv: Uint8Array.from({ length: 12 }, (_, i) => (i + seed) % 256),
    keyVersion,
  };
}

export function fakeTokenHash(n: number): string {
  return n.toString(16).padStart(64, '0');
}

/** Write `fixture` through the public API (used for writable adapters). */
export async function seedFixture(
  storage: Storage,
  fixture: ContractFixture = CONTRACT_FIXTURE,
): Promise<void> {
  let seed = 1;
  for (const p of fixture.projects) {
    const credentialId = `project:${p.slug}`;
    await storage.credentials.create({
      id: credentialId,
      label: p.slug,
      region: p.region,
      key: fakeEncryptedKey(seed++),
    });
    await storage.projects.create({
      id: p.slug,
      slug: p.slug,
      name: p.name,
      defaultAccountId: p.defaultAccountId,
      allowedAccountIds: p.allowedAccountIds,
      enabledTools: p.enabledTools,
      limits: p.limits,
      defaultCredentialId: credentialId,
    });
  }
}

class ManualClock implements ContractClock {
  t = 1_800_000_000_000;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

async function rejects(
  promise: Promise<unknown>,
  type: abstract new (...args: never[]) => Error,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(type);
}

export function runStorageContract(options: StorageContractOptions): void {
  const { create } = options;
  const seeded = async (clock: ContractClock): Promise<Storage> => {
    if (options.createSeeded) return options.createSeeded(CONTRACT_FIXTURE, clock);
    if (!create) throw new Error('runStorageContract needs create or createSeeded');
    const s = await create(clock);
    await seedFixture(s);
    return s;
  };

  describe(`Storage contract: ${options.name}`, () => {
    describe('read paths (seeded fixture)', () => {
      it('finds projects by slug and id, with every field', async () => {
        const s = await seeded(new ManualClock());
        for (const f of CONTRACT_FIXTURE.projects) {
          const p = await s.projects.getBySlug(f.slug);
          expect(p).not.toBeNull();
          expect(p).toMatchObject({
            id: f.slug,
            slug: f.slug,
            name: f.name,
            defaultAccountId: f.defaultAccountId,
            allowedAccountIds: f.allowedAccountIds,
            enabledTools: f.enabledTools,
            limits: f.limits,
            defaultCredentialId: `project:${f.slug}`,
            disabledAt: null,
          });
          expect(await s.projects.get(f.slug)).toEqual(p);
        }
        expect(await s.projects.getBySlug('missing')).toBeNull();
        expect(await s.projects.get('missing')).toBeNull();
        const slugs = (await s.projects.list()).map((p) => p.slug).sort();
        expect(slugs).toEqual(CONTRACT_FIXTURE.projects.map((p) => p.slug).sort());
        await s.close();
      });

      it('finds each project credential, never exposing the key in serialised form', async () => {
        const s = await seeded(new ManualClock());
        for (const f of CONTRACT_FIXTURE.projects) {
          const c = await s.credentials.get(`project:${f.slug}`);
          expect(c).toMatchObject({ id: `project:${f.slug}`, region: f.region, revokedAt: null });
          expect(['encrypted', 'env', 'inline']).toContain(c?.key.kind);
          expect(JSON.stringify(c)).not.toContain(f.secret);
          expect(JSON.stringify(await s.credentials.list())).not.toContain(f.secret);
        }
        expect(await s.credentials.get('missing')).toBeNull();
        expect((await s.credentials.list()).length).toBe(CONTRACT_FIXTURE.projects.length);
        await s.close();
      });

      it('returns frozen records', async () => {
        const s = await seeded(new ManualClock());
        const p = await s.projects.getBySlug('acme-prod');
        expect(Object.isFrozen(p)).toBe(true);
        expect(Object.isFrozen(p?.allowedAccountIds)).toBe(true);
        expect(Object.isFrozen(await s.projects.list())).toBe(true);
        await s.close();
      });

      it('answers lookups on other repositories without failing', async () => {
        const s = await seeded(new ManualClock());
        expect(await s.users.get('missing')).toBeNull();
        expect(await s.users.getByEmail('nobody@example.com')).toBeNull();
        expect(await s.users.getByIdentity('google', 'nobody')).toBeNull();
        expect(await s.grants.get('missing')).toBeNull();
        expect(await s.grants.list({ projectId: 'acme-prod' })).toEqual([]);
        expect(await s.accessTokens.getByHash(fakeTokenHash(999))).toBeNull();
        expect(await s.accessTokens.get('missing')).toBeNull();
        expect(await s.settings.get('missing')).toBeUndefined();
        expect(await s.kv.get('missing')).toBeNull();
        await s.close();
      });
    });

    if (!create) {
      describe('read-only', () => {
        it('reports readOnly and rejects every write', async () => {
          const s = await seeded(new ManualClock());
          expect(s.readOnly).toBe(true);
          const writes: Promise<unknown>[] = [
            s.users.create({ id: 'u', email: 'a@b.c', role: 'owner' }),
            s.users.update('u', {}),
            s.credentials.create({ id: 'c', label: 'x', region: 'US', key: fakeEncryptedKey() }),
            s.credentials.update('project:acme-prod', { label: 'x' }),
            s.credentials.delete('project:acme-prod'),
            s.projects.create({ id: 'p', slug: 'p', defaultAccountId: 1, allowedAccountIds: [1] }),
            s.projects.update('acme-prod', { name: 'x' }),
            s.projects.delete('acme-prod'),
            s.grants.create({ id: 'g', projectId: 'acme-prod', label: 'svc' }),
            s.grants.update('g', {}),
            s.grants.delete('g'),
            s.accessTokens.create({
              id: 't',
              grantId: 'g',
              prefix: 'rb_x',
              tokenHash: fakeTokenHash(1),
              label: 'd',
            }),
            s.accessTokens.markUsed('t', 1),
            s.accessTokens.revoke('t', 1),
            s.auditLog.append({ ts: 1, kind: 'admin', action: 'x', status: 'ok' }),
            s.auditLog.purgeBefore(1),
            s.settings.set('k', 1),
            s.settings.setIfAbsent('k', 1),
            s.settings.delete('k'),
            s.kv.put('k', 'v'),
            s.kv.delete('k'),
          ];
          for (const w of writes) await rejects(w, ReadOnlyStorageError);
          expect((await s.projects.list()).length).toBe(CONTRACT_FIXTURE.projects.length);
          await s.close();
        });
      });
      return;
    }

    const fresh = async (clock = new ManualClock()): Promise<{ s: Storage; clock: ManualClock }> => ({
      s: await create(clock),
      clock,
    });

    describe('users', () => {
      it('creates, finds (email case-insensitive) and updates', async () => {
        const { s, clock } = await fresh();
        expect(s.readOnly).toBe(false);
        const u = await s.users.create({
          id: 'u1',
          email: 'Owner@Example.COM',
          idp: 'google',
          idpSubject: 'sub-1',
          role: 'owner',
        });
        expect(u).toMatchObject({
          email: 'owner@example.com',
          displayName: null,
          createdAt: clock.t,
          updatedAt: clock.t,
          disabledAt: null,
        });
        expect(await s.users.getByEmail('OWNER@example.com')).toEqual(u);
        expect(await s.users.getByIdentity('google', 'sub-1')).toEqual(u);
        clock.advance(10);
        const v = await s.users.update('u1', { displayName: 'Owner', disabledAt: clock.t });
        expect(v).toMatchObject({
          displayName: 'Owner',
          disabledAt: clock.t,
          updatedAt: clock.t,
          createdAt: u.createdAt,
        });
        expect(await s.users.list()).toHaveLength(1);
        await s.close();
      });

      it('enforces unique id, email and identity, and valid roles', async () => {
        const { s } = await fresh();
        await s.users.create({ id: 'u1', email: 'a@x.io', idp: 'github', idpSubject: '1', role: 'owner' });
        await rejects(s.users.create({ id: 'u1', email: 'b@x.io', role: 'member' }), ConflictError);
        await rejects(s.users.create({ id: 'u2', email: 'A@X.IO', role: 'member' }), ConflictError);
        await rejects(
          s.users.create({ id: 'u3', email: 'c@x.io', idp: 'github', idpSubject: '1', role: 'member' }),
          ConflictError,
        );
        await rejects(
          s.users.create({ id: 'u4', email: 'd@x.io', role: 'root' as never }),
          InvalidInputError,
        );
        await s.users.create({ id: 'u5', email: 'e@x.io', role: 'member' });
        await rejects(s.users.update('u5', { email: 'a@x.io' }), ConflictError);
        await rejects(s.users.update('missing', { displayName: 'x' }), NotFoundError);
        await s.close();
      });
    });

    describe('credentials', () => {
      it('stores only the encrypted key, copied, and starts unvalidated', async () => {
        const { s } = await fresh();
        const key = fakeEncryptedKey(3);
        const c = await s.credentials.create({ id: 'c1', label: 'me', region: 'EU', key, keyHint: 'ABCD' });
        key.ciphertext[0] = 255;
        const got = await s.credentials.get('c1');
        expect(got?.key.kind).toBe('encrypted');
        if (got?.key.kind !== 'encrypted') throw new Error('unreachable');
        expect([...got.key.ciphertext]).toEqual([...fakeEncryptedKey(3).ciphertext]);
        expect([...got.key.iv]).toEqual([...fakeEncryptedKey(3).iv]);
        expect(got.key.keyVersion).toBe(1);
        expect(c).toMatchObject({
          ownerUserId: null,
          keyHint: 'ABCD',
          validationStatus: 'unvalidated',
          reachableAccountIds: null,
          validatedAt: null,
        });
        await s.close();
      });

      it('rejects bad key material, unknown owners and duplicate ids', async () => {
        const { s } = await fresh();
        const bad = (k: Partial<EncryptedKey>) =>
          s.credentials.create({ id: 'c', label: 'x', region: 'US', key: { ...fakeEncryptedKey(), ...k } });
        await rejects(bad({ iv: new Uint8Array(16) }), InvalidInputError);
        await rejects(bad({ ciphertext: new Uint8Array(0) }), InvalidInputError);
        await rejects(bad({ keyVersion: 0 }), InvalidInputError);
        await rejects(
          s.credentials.create({ id: 'c', label: 'x', region: 'APAC' as never, key: fakeEncryptedKey() }),
          InvalidInputError,
        );
        await rejects(
          s.credentials.create({
            id: 'c',
            label: 'x',
            region: 'US',
            key: fakeEncryptedKey(),
            keyHint: '12345',
          }),
          InvalidInputError,
        );
        await rejects(
          s.credentials.create({
            id: 'c',
            label: 'x',
            region: 'US',
            key: fakeEncryptedKey(),
            ownerUserId: 'ghost',
          }),
          ConflictError,
        );
        await s.credentials.create({ id: 'c', label: 'x', region: 'US', key: fakeEncryptedKey() });
        await rejects(
          s.credentials.create({ id: 'c', label: 'y', region: 'US', key: fakeEncryptedKey() }),
          ConflictError,
        );
        expect(await s.credentials.list()).toHaveLength(1);
        await s.close();
      });

      it('records validation, re-encryption and revocation; filters by owner', async () => {
        const { s, clock } = await fresh();
        await s.users.create({ id: 'u1', email: 'a@x.io', role: 'owner' });
        await s.credentials.create({
          id: 'c1',
          label: 'a',
          region: 'US',
          key: fakeEncryptedKey(),
          ownerUserId: 'u1',
        });
        await s.credentials.create({ id: 'c2', label: 'b', region: 'US', key: fakeEncryptedKey(2) });
        clock.advance(5);
        const v = await s.credentials.update('c1', {
          validation: {
            validationStatus: 'valid',
            validatedAt: clock.t,
            nrUserId: 42,
            nrUserEmail: 'me@x.io',
            reachableAccountIds: [1, 2],
          },
        });
        expect(v).toMatchObject({
          validationStatus: 'valid',
          validationErrorCode: null,
          validatedAt: clock.t,
          nrUserId: 42,
          nrUserEmail: 'me@x.io',
          reachableAccountIds: [1, 2],
          updatedAt: clock.t,
        });
        const r = await s.credentials.update('c1', { key: fakeEncryptedKey(9, 2), revokedAt: clock.t });
        expect(r.key.kind === 'encrypted' && r.key.keyVersion).toBe(2);
        expect(r.revokedAt).toBe(clock.t);
        const inv = await s.credentials.update('c1', {
          validation: {
            validationStatus: 'invalid',
            validationErrorCode: 'RB_AUTH_INVALID_KEY',
            validatedAt: 1,
          },
        });
        expect(inv).toMatchObject({
          validationStatus: 'invalid',
          validationErrorCode: 'RB_AUTH_INVALID_KEY',
        });
        expect(inv.reachableAccountIds).toEqual([1, 2]);
        expect((await s.credentials.list({ ownerUserId: 'u1' })).map((c) => c.id)).toEqual(['c1']);
        await rejects(s.credentials.update('missing', { label: 'x' }), NotFoundError);
        await rejects(
          s.credentials.update('c2', { key: { ...fakeEncryptedKey(), iv: new Uint8Array(1) } }),
          InvalidInputError,
        );
        await s.close();
      });

      it('applies a key compare-and-swap (ifKey) only when the stored key is unchanged', async () => {
        const { s } = await fresh();
        await s.credentials.create({ id: 'c1', label: 'a', region: 'US', key: fakeEncryptedKey(1) });
        const swapped = await s.credentials.update('c1', {
          key: fakeEncryptedKey(2, 2),
          ifKey: fakeEncryptedKey(1),
        });
        expect(swapped.key.kind === 'encrypted' && swapped.key.keyVersion).toBe(2);
        // Stale guards: old key, same IV with another version, same version with other ciphertext.
        for (const ifKey of [
          fakeEncryptedKey(1),
          fakeEncryptedKey(2, 1),
          { ...fakeEncryptedKey(2, 2), ciphertext: fakeEncryptedKey(3, 2).ciphertext },
        ]) {
          await rejects(s.credentials.update('c1', { key: fakeEncryptedKey(4, 3), ifKey }), ConflictError);
        }
        const still = await s.credentials.get('c1');
        expect(still?.key.kind === 'encrypted' && [...still.key.iv]).toEqual([...fakeEncryptedKey(2).iv]);
        expect(still?.key.kind === 'encrypted' && still.key.keyVersion).toBe(2);
        await rejects(
          s.credentials.update('missing', { key: fakeEncryptedKey(), ifKey: fakeEncryptedKey() }),
          NotFoundError,
        );
        await s.close();
      });

      it('refuses to delete a credential a project or grant still uses', async () => {
        const { s } = await fresh();
        await seedFixture(s);
        await rejects(s.credentials.delete('project:acme-prod'), ConflictError);
        await s.credentials.create({ id: 'c9', label: 'x', region: 'US', key: fakeEncryptedKey() });
        await s.grants.create({ id: 'g1', projectId: 'acme-prod', label: 'svc', credentialId: 'c9' });
        await rejects(s.credentials.delete('c9'), ConflictError);
        await s.grants.delete('g1');
        await s.credentials.delete('c9');
        expect(await s.credentials.get('c9')).toBeNull();
        await rejects(s.credentials.delete('c9'), NotFoundError);
        await s.close();
      });
    });

    describe('projects', () => {
      it('enforces unique slugs and known default credentials', async () => {
        const { s } = await fresh();
        await seedFixture(s);
        const base = { defaultAccountId: 1, allowedAccountIds: [1] };
        await rejects(s.projects.create({ id: 'p2', slug: 'acme-prod', ...base }), ConflictError);
        await rejects(s.projects.create({ id: 'acme-prod', slug: 'other', ...base }), ConflictError);
        await rejects(
          s.projects.create({ id: 'p3', slug: 'p3', ...base, defaultCredentialId: 'ghost' }),
          ConflictError,
        );
        const p = await s.projects.create({ id: 'p4', slug: 'p4', ...base });
        expect(p).toMatchObject({ name: null, enabledTools: null, limits: {}, defaultCredentialId: null });
        await rejects(s.projects.update('p4', { slug: 'side-eu' }), ConflictError);
        await rejects(s.projects.update('p4', { defaultCredentialId: 'ghost' }), ConflictError);
        await rejects(s.projects.update('missing', { name: 'x' }), NotFoundError);
        const u = await s.projects.update('p4', {
          name: 'Four',
          enabledTools: ['whoami'],
          limits: { maxWindowDays: 1, eventTypes: { deny: ['Secret'] } },
        });
        expect(u).toMatchObject({ name: 'Four', enabledTools: ['whoami'], limits: { maxWindowDays: 1 } });
        expect(await s.projects.getBySlug('p4')).toEqual(u);
        await s.close();
      });

      it('deleting a project deletes its grants and their tokens', async () => {
        const { s } = await fresh();
        await seedFixture(s);
        await s.grants.create({ id: 'g1', projectId: 'acme-prod', label: 'svc' });
        await s.grants.create({ id: 'g2', projectId: 'side-eu', label: 'svc' });
        await s.accessTokens.create({
          id: 't1',
          grantId: 'g1',
          prefix: 'rb_a',
          tokenHash: fakeTokenHash(1),
          label: 'mac',
        });
        await s.accessTokens.create({
          id: 't2',
          grantId: 'g2',
          prefix: 'rb_b',
          tokenHash: fakeTokenHash(2),
          label: 'pc',
        });
        await s.projects.delete('acme-prod');
        expect(await s.projects.getBySlug('acme-prod')).toBeNull();
        expect(await s.grants.get('g1')).toBeNull();
        expect(await s.accessTokens.getByHash(fakeTokenHash(1))).toBeNull();
        expect(await s.grants.get('g2')).not.toBeNull();
        expect(await s.accessTokens.get('t2')).not.toBeNull();
        expect(await s.credentials.get('project:acme-prod')).not.toBeNull();
        await rejects(s.projects.delete('acme-prod'), NotFoundError);
        await s.close();
      });
    });

    describe('grants', () => {
      it('creates user and service grants with defaults, filters, and updates', async () => {
        const { s, clock } = await fresh();
        await seedFixture(s);
        await s.users.create({ id: 'u1', email: 'a@x.io', role: 'member' });
        const g = await s.grants.create({ id: 'g1', projectId: 'acme-prod', userId: 'u1' });
        expect(g).toMatchObject({
          label: null,
          credentialId: null,
          tools: null,
          accountIds: null,
          limits: {},
          rateLimit: null,
          expiresAt: null,
          revokedAt: null,
          createdAt: clock.t,
        });
        await s.grants.create({
          id: 'g2',
          projectId: 'side-eu',
          label: 'ci',
          credentialId: 'project:side-eu',
          tools: ['whoami'],
          accountIds: [2001],
          limits: { maxLimit: 10 },
          rateLimit: { requests: 60, perSeconds: 60 },
          expiresAt: clock.t + 1000,
        });
        expect((await s.grants.list({ projectId: 'side-eu' })).map((x) => x.id)).toEqual(['g2']);
        expect((await s.grants.list({ userId: 'u1' })).map((x) => x.id)).toEqual(['g1']);
        expect((await s.grants.list()).length).toBe(2);
        clock.advance(1);
        const r = await s.grants.update('g2', { revokedAt: clock.t, tools: [] });
        expect(r).toMatchObject({
          revokedAt: clock.t,
          tools: [],
          rateLimit: { requests: 60, perSeconds: 60 },
        });
        await s.close();
      });

      it('rejects unknown references and grants without a principal', async () => {
        const { s } = await fresh();
        await seedFixture(s);
        await rejects(s.grants.create({ id: 'g', projectId: 'ghost', label: 'x' }), ConflictError);
        await rejects(s.grants.create({ id: 'g', projectId: 'acme-prod', userId: 'ghost' }), ConflictError);
        await rejects(
          s.grants.create({ id: 'g', projectId: 'acme-prod', label: 'x', credentialId: 'ghost' }),
          ConflictError,
        );
        await rejects(s.grants.create({ id: 'g', projectId: 'acme-prod' }), InvalidInputError);
        await s.grants.create({ id: 'g', projectId: 'acme-prod', label: 'x' });
        await rejects(s.grants.create({ id: 'g', projectId: 'acme-prod', label: 'y' }), ConflictError);
        await rejects(s.grants.update('g', { credentialId: 'ghost' }), ConflictError);
        await rejects(s.grants.update('g', { label: null }), InvalidInputError);
        await rejects(s.grants.update('missing', { label: 'x' }), NotFoundError);
        await rejects(s.grants.delete('missing'), NotFoundError);
        await s.close();
      });
    });

    describe('access tokens', () => {
      it('stores only the hash, finds by hash, marks use and revokes once', async () => {
        const { s, clock } = await fresh();
        await seedFixture(s);
        await s.grants.create({ id: 'g1', projectId: 'acme-prod', label: 'svc' });
        const t = await s.accessTokens.create({
          id: 't1',
          grantId: 'g1',
          prefix: 'rb_abcd',
          tokenHash: fakeTokenHash(7),
          label: 'MacBook',
          expiresAt: clock.t + 90 * 86_400_000,
        });
        expect(Object.keys(t).sort()).toEqual(
          [
            'createdAt',
            'expiresAt',
            'grantId',
            'id',
            'label',
            'lastUsedAt',
            'prefix',
            'revokedAt',
            'tokenHash',
          ].sort(),
        );
        expect(await s.accessTokens.getByHash(fakeTokenHash(7))).toEqual(t);
        await s.accessTokens.markUsed('t1', clock.t + 5);
        expect((await s.accessTokens.get('t1'))?.lastUsedAt).toBe(clock.t + 5);
        const r = await s.accessTokens.revoke('t1', clock.t + 10);
        expect(r.revokedAt).toBe(clock.t + 10);
        expect((await s.accessTokens.revoke('t1', clock.t + 20)).revokedAt).toBe(clock.t + 10);
        expect((await s.accessTokens.list({ grantId: 'g1' })).map((x) => x.id)).toEqual(['t1']);
        await rejects(s.accessTokens.markUsed('missing', 1), NotFoundError);
        await rejects(s.accessTokens.revoke('missing', 1), NotFoundError);
        await s.close();
      });

      it('rejects non-hash values, duplicate hashes and unknown grants', async () => {
        const { s } = await fresh();
        await seedFixture(s);
        await s.grants.create({ id: 'g1', projectId: 'acme-prod', label: 'svc' });
        const tok = (id: string, tokenHash: string, grantId = 'g1', prefix = 'rb_x') =>
          s.accessTokens.create({ id, grantId, prefix, tokenHash, label: 'd' });
        await rejects(tok('a', 'rb_live_plaintexttoken'), InvalidInputError);
        await rejects(tok('a', fakeTokenHash(1).toUpperCase().replace('0', 'A')), InvalidInputError);
        await rejects(tok('a', fakeTokenHash(1).slice(1)), InvalidInputError);
        await rejects(tok('a', fakeTokenHash(1), 'g1', 'rb_much_too_long_prefix'), InvalidInputError);
        await rejects(tok('a', fakeTokenHash(1), 'ghost'), ConflictError);
        await tok('a', fakeTokenHash(1));
        await rejects(tok('b', fakeTokenHash(1)), ConflictError);
        await rejects(tok('a', fakeTokenHash(2)), ConflictError);
        await s.close();
      });

      it('deleting a grant deletes its tokens', async () => {
        const { s } = await fresh();
        await seedFixture(s);
        await s.grants.create({ id: 'g1', projectId: 'acme-prod', label: 'svc' });
        await s.accessTokens.create({
          id: 't1',
          grantId: 'g1',
          prefix: 'rb_a',
          tokenHash: fakeTokenHash(1),
          label: 'd',
        });
        await s.grants.delete('g1');
        expect(await s.accessTokens.get('t1')).toBeNull();
        await s.close();
      });
    });

    describe('audit log', () => {
      it('is append-only: the repository has no update or delete besides retention purge', async () => {
        const { s } = await fresh();
        expect(Object.keys(s.auditLog).sort()).toEqual(['append', 'list', 'purgeBefore']);
        await s.close();
      });

      it('appends, lists newest first with filters and pagination, and purges by age', async () => {
        const { s } = await fresh();
        for (let i = 1; i <= 5; i++) {
          await s.auditLog.append({
            ts: i * 100,
            kind: i % 2 === 0 ? 'admin' : 'tool_call',
            action: i % 2 === 0 ? 'token.create' : 'run_nrql',
            status: 'ok',
            projectId: i <= 3 ? 'p1' : 'p2',
            userId: 'u1',
            accountIds: [1, 2],
            nrql: 'SELECT count(*) FROM Transaction WHERE name = ?',
            durationMs: i,
            details: { n: i },
          });
        }
        const all = await s.auditLog.list();
        expect(all.map((r) => r.ts)).toEqual([500, 400, 300, 200, 100]);
        expect(all[0]).toMatchObject({
          kind: 'tool_call',
          action: 'run_nrql',
          accountIds: [1, 2],
          details: { n: 5 },
          grantId: null,
          tokenId: null,
          clientId: null,
          errorCode: null,
          inspectedCount: null,
          requestId: null,
          targetType: null,
          targetId: null,
        });
        expect((await s.auditLog.list({ projectId: 'p1' })).map((r) => r.ts)).toEqual([300, 200, 100]);
        expect((await s.auditLog.list({ kind: 'admin' })).map((r) => r.ts)).toEqual([400, 200]);
        expect((await s.auditLog.list({ since: 200, until: 400 })).map((r) => r.ts)).toEqual([300, 200]);
        const page1 = await s.auditLog.list({ limit: 2 });
        expect(page1.map((r) => r.ts)).toEqual([500, 400]);
        const page2 = await s.auditLog.list({ limit: 2, beforeId: page1.at(-1)?.id as number });
        expect(page2.map((r) => r.ts)).toEqual([300, 200]);
        expect(await s.auditLog.purgeBefore(300)).toBe(2);
        expect((await s.auditLog.list()).map((r) => r.ts)).toEqual([500, 400, 300]);
        await s.close();
      });
    });

    describe('settings', () => {
      it('round-trips JSON values', async () => {
        const { s } = await fresh();
        await s.settings.set('audit.retentionDays', 30);
        await s.settings.set('nested', { a: [1, 'two', null, true] });
        expect(await s.settings.get('audit.retentionDays')).toBe(30);
        expect(await s.settings.get('nested')).toEqual({ a: [1, 'two', null, true] });
        await s.settings.set('audit.retentionDays', 90);
        expect(await s.settings.list()).toEqual({
          'audit.retentionDays': 90,
          nested: { a: [1, 'two', null, true] },
        });
        await s.settings.delete('nested');
        await s.settings.delete('never-set');
        expect(await s.settings.get('nested')).toBeUndefined();
        await s.close();
      });

      it('setIfAbsent writes once and never overwrites', async () => {
        const { s } = await fresh();
        expect(await s.settings.setIfAbsent('once', 'first')).toBe(true);
        expect(await s.settings.setIfAbsent('once', 'second')).toBe(false);
        expect(await s.settings.get('once')).toBe('first');
        await s.settings.set('existing', 1);
        expect(await s.settings.setIfAbsent('existing', 2)).toBe(false);
        expect(await s.settings.get('existing')).toBe(1);
        // Racing writers: exactly one wins.
        const results = await Promise.all([1, 2, 3, 4].map((n) => s.settings.setIfAbsent('race', n)));
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(results.indexOf(true) + 1).toBe(await s.settings.get('race'));
        await s.settings.delete('once');
        expect(await s.settings.setIfAbsent('once', 'again')).toBe(true);
        await s.close();
      });
    });

    describe('kv', () => {
      it('gets, puts, overwrites and deletes', async () => {
        const { s } = await fresh();
        await s.kv.put('a', '1');
        await s.kv.put('a', '2');
        expect(await s.kv.get('a')).toBe('2');
        await s.kv.delete('a');
        await s.kv.delete('a');
        expect(await s.kv.get('a')).toBeNull();
        await s.close();
      });

      it('hides expired keys (expirationTtl and absolute expiration)', async () => {
        const { s, clock } = await fresh();
        await s.kv.put('ttl', 'x', { expirationTtl: 60 });
        await s.kv.put('abs', 'y', { expiration: Math.floor(clock.t / 1000) + 120 });
        await s.kv.put('forever', 'z');
        expect(await s.kv.get('ttl')).toBe('x');
        const listed = await s.kv.list();
        expect(listed.keys.find((k) => k.name === 'abs')?.expiration).toBe(Math.floor(clock.t / 1000) + 120);
        expect(listed.keys.find((k) => k.name === 'forever')?.expiration).toBeUndefined();
        clock.advance(60_000);
        expect(await s.kv.get('ttl')).toBeNull();
        expect(await s.kv.get('abs')).toBe('y');
        clock.advance(60_000);
        expect(await s.kv.get('abs')).toBeNull();
        expect((await s.kv.list()).keys.map((k) => k.name)).toEqual(['forever']);
        await s.close();
      });

      it('lists by prefix in key order with cursor pagination', async () => {
        const { s } = await fresh();
        for (const k of ['grant:3', 'grant:1', 'client:1', 'grant:2', 'grant:4']) await s.kv.put(k, k);
        const p1 = await s.kv.list({ prefix: 'grant:', limit: 3 });
        expect(p1.keys.map((k) => k.name)).toEqual(['grant:1', 'grant:2', 'grant:3']);
        expect(p1.complete).toBe(false);
        const p2 = await s.kv.list({
          prefix: 'grant:',
          limit: 3,
          ...(p1.cursor ? { cursor: p1.cursor } : {}),
        });
        expect(p2.keys.map((k) => k.name)).toEqual(['grant:4']);
        expect(p2.complete).toBe(true);
        expect(p2.cursor).toBeUndefined();
        expect((await s.kv.list()).keys).toHaveLength(5);
        await s.close();
      });
    });

    describe('errors', () => {
      it('uses the StorageError hierarchy', async () => {
        const { s } = await fresh();
        const e = await s.users.update('missing', {}).catch((x: unknown) => x);
        expect(e).toBeInstanceOf(StorageError);
        expect((e as StorageError).code).toBe('not_found');
        await s.close();
      });
    });
  });
}
