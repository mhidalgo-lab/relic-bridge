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
  LAST_OWNER_CONSTRAINT,
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
  /**
   * The adapter implements the optional `loadAccessRecords` (P3-09; required of the SQL adapters). Its contract is
   * then checked too, and its absence fails.
   */
  readonly accessRecords?: boolean;
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
            s.users.bind('u', 'google', 's'),
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
            s.auditLog.purgeBefore(1, 1),
            s.settings.set('k', 1),
            s.settings.setIfAbsent('k', 1),
            s.settings.delete('k'),
            s.kv.put('k', 'v'),
            s.kv.delete('k'),
            s.kv.take('k'),
            s.kv.purgeExpired(),
            s.kv.deletePrefix('k'),
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
          role: 'admin',
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

      it('binds an identity only while the row is unbound and enabled (P4-16 compare-and-set)', async () => {
        const { s, clock } = await fresh();
        await s.users.create({ id: 'u1', email: 'a@x.io', role: 'member' });
        clock.advance(5);
        const bound = await s.users.bind('u1', 'google', 'g-1', { displayName: 'A', role: 'owner' });
        expect(bound).toMatchObject({
          idp: 'google',
          idpSubject: 'g-1',
          displayName: 'A',
          role: 'owner',
          updatedAt: clock.t,
        });
        expect(await s.users.getByIdentity('google', 'g-1')).toEqual(bound);
        // Already bound (to this or any identity): nothing changes.
        expect(await s.users.bind('u1', 'github', 'h-1')).toBeNull();
        expect(await s.users.bind('u1', 'google', 'g-1')).toBeNull();
        expect(await s.users.get('u1')).toEqual(bound);
        // Missing and disabled rows are not bound.
        expect(await s.users.bind('missing', 'google', 'g-2')).toBeNull();
        await s.users.create({ id: 'u2', email: 'b@x.io', role: 'member' });
        await s.users.update('u2', { disabledAt: clock.t });
        expect(await s.users.bind('u2', 'google', 'g-2')).toBeNull();
        expect((await s.users.get('u2'))?.idp).toBeNull();
        // An identity another user holds is a conflict; without a patch the name and role stay.
        await s.users.create({ id: 'u3', email: 'c@x.io', displayName: 'C', role: 'admin' });
        await rejects(s.users.bind('u3', 'google', 'g-1'), ConflictError);
        expect(await s.users.bind('u3', 'github', 'h-3')).toMatchObject({ displayName: 'C', role: 'admin' });
        await rejects(s.users.bind('u2', 'google', 'g-9', { role: 'root' as never }), InvalidInputError);
        await s.close();
      });

      it('lets exactly one of two concurrent first bindings win (P4-16)', async () => {
        const { s } = await fresh();
        for (let i = 0; i < 5; i++) {
          await s.users.create({ id: `r${i}`, email: `r${i}@x.io`, role: 'member' });
          const results = await Promise.all([
            s.users.bind(`r${i}`, 'google', `g-${i}`),
            s.users.bind(`r${i}`, 'github', `h-${i}`),
          ]);
          const winners = results.filter((r) => r !== null);
          expect(winners).toHaveLength(1);
          expect(await s.users.get(`r${i}`)).toEqual(winners[0]);
        }
        await s.close();
      });

      it('never demotes or disables the last enabled owner (P4-16)', async () => {
        const { s, clock } = await fresh();
        await s.users.create({ id: 'o1', email: 'o1@x.io', role: 'owner' });
        await s.users.create({ id: 'a1', email: 'a1@x.io', role: 'admin' });
        const lastOwner = async (p: Promise<unknown>): Promise<void> => {
          const e = await p.catch((x: unknown) => x);
          expect(e).toBeInstanceOf(ConflictError);
          expect((e as ConflictError).constraint).toBe(LAST_OWNER_CONSTRAINT);
        };
        await lastOwner(s.users.update('o1', { role: 'admin' }));
        await lastOwner(s.users.update('o1', { disabledAt: clock.t }));
        await lastOwner(s.users.update('o1', { role: 'member', displayName: 'x' }));
        // Nothing was written by a refused update.
        expect(await s.users.get('o1')).toMatchObject({ role: 'owner', disabledAt: null, displayName: null });
        // Other changes to the last owner, and any change to non-owners, pass.
        await s.users.update('o1', { displayName: 'Owner', role: 'owner', disabledAt: null });
        await s.users.update('a1', { role: 'member', disabledAt: clock.t });
        // A disabled owner does not count; with a second enabled owner the first may step down.
        await s.users.create({ id: 'o2', email: 'o2@x.io', role: 'owner' });
        await s.users.update('o2', { disabledAt: clock.t });
        await lastOwner(s.users.update('o1', { role: 'admin' }));
        await s.users.update('o2', { disabledAt: null });
        expect(await s.users.update('o1', { role: 'admin' })).toMatchObject({ role: 'admin' });
        await lastOwner(s.users.update('o2', { disabledAt: clock.t }));
        // With no enabled owner at all (made outside this guard), promoting and editing still work.
        expect(await s.users.update('o1', { role: 'owner' })).toMatchObject({ role: 'owner' });
        await rejects(s.users.update('missing', { role: 'admin' }), NotFoundError);
        await s.close();
      });

      it('leaves one owner when two owners demote or disable each other at once (P4-16)', async () => {
        for (let i = 0; i < 4; i++) {
          const { s, clock } = await fresh();
          await s.users.create({ id: 'a', email: 'a@x.io', role: 'owner' });
          await s.users.create({ id: 'b', email: 'b@x.io', role: 'owner' });
          const settled = await Promise.allSettled([
            s.users.update('a', i % 2 === 0 ? { role: 'admin' } : { disabledAt: clock.t }),
            s.users.update('b', i < 2 ? { role: 'member' } : { disabledAt: clock.t }),
          ]);
          expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
          const refused = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult;
          expect((refused.reason as ConflictError).constraint).toBe(LAST_OWNER_CONSTRAINT);
          const owners = (await s.users.list()).filter((u) => u.role === 'owner' && u.disabledAt === null);
          expect(owners).toHaveLength(1);
          await s.close();
        }
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

    // Optional capability: only adapters that declare it (an empty describe would fail the run).
    describe.runIf(options.accessRecords === true)('access records (one call)', () => {
      /** Fixture + users, personal keys and grants covering every branch of the `AccessRecords` contract. */
      const world = async (): Promise<Storage> => {
        const { s } = await fresh();
        await seedFixture(s);
        await s.users.create({ id: 'u1', email: 'u1@example.com', role: 'member' });
        await s.users.create({ id: 'u2', email: 'u2@example.com', role: 'member' });
        await s.credentials.create({
          id: 'c-u1',
          ownerUserId: 'u1',
          label: 'u1',
          region: 'US',
          key: fakeEncryptedKey(5),
        });
        await s.credentials.create({
          id: 'c-u2',
          ownerUserId: 'u2',
          label: 'u2',
          region: 'US',
          key: fakeEncryptedKey(6),
        });
        await s.projects.create({ id: 'bare', slug: 'bare', defaultAccountId: 1, allowedAccountIds: [1] });
        const grants: [string, string, string | null, string | null][] = [
          ['g-default', 'acme-prod', 'u1', null],
          ['g-shared', 'acme-prod', 'u1', 'c-u2'],
          ['g-own', 'acme-prod', 'u1', 'c-u1'],
          ['g-service', 'side-eu', null, 'c-u2'],
          ['g-bare', 'bare', 'u2', null],
        ];
        let n = 100;
        for (const [id, projectId, userId, credentialId] of grants) {
          await s.grants.create({
            id,
            projectId,
            userId,
            label: userId === null ? 'svc' : null,
            credentialId,
          });
          await s.accessTokens.create({
            id: `t-${id}`,
            grantId: id,
            prefix: 'rb_x',
            tokenHash: fakeTokenHash(n++),
            label: 'd',
          });
        }
        return s;
      };
      const hashOf = (grant: string): string =>
        fakeTokenHash(100 + ['g-default', 'g-shared', 'g-own', 'g-service', 'g-bare'].indexOf(grant));
      const load = (s: Storage, grant: string, projectSlug: string | null) => {
        if (s.loadAccessRecords === undefined) throw new Error('loadAccessRecords is missing');
        return s.loadAccessRecords({ tokenHash: hashOf(grant), projectSlug });
      };

      it('is implemented', async () => {
        const { s } = await fresh();
        expect(typeof s.loadAccessRecords).toBe('function');
        await s.close();
      });

      it('loads token, project, grant, user and the project default credential, equal to the repositories', async () => {
        const s = await world();
        const r = await load(s, 'g-default', 'acme-prod');
        expect(r.token).toEqual(await s.accessTokens.get('t-g-default'));
        expect(r.project).toEqual(await s.projects.getBySlug('acme-prod'));
        expect(r.grant).toEqual(await s.grants.get('g-default'));
        expect(r.user).toEqual(await s.users.get('u1'));
        expect(r.credential).toEqual(await s.credentials.get('project:acme-prod'));
        expect(r.credentialOwner).toBeNull(); // shared key: no owner
        for (const v of [r, r.token, r.project, r.grant, r.user, r.credential])
          expect(Object.isFrozen(v)).toBe(true);
        await s.close();
      });

      it("loads the grant's own key and its owner only when the owner is not the grant's user", async () => {
        const s = await world();
        const shared = await load(s, 'g-shared', 'acme-prod');
        expect(shared.credential?.id).toBe('c-u2');
        expect(shared.credentialOwner).toEqual(await s.users.get('u2'));
        const own = await load(s, 'g-own', 'acme-prod');
        expect(own.credential?.id).toBe('c-u1');
        expect(own.user?.id).toBe('u1');
        expect(own.credentialOwner).toBeNull();
        const service = await load(s, 'g-service', 'side-eu');
        expect(service.user).toBeNull();
        expect(service.credential?.id).toBe('c-u2');
        expect(service.credentialOwner?.id).toBe('u2');
        const bare = await load(s, 'g-bare', 'bare');
        expect(bare.user?.id).toBe('u2');
        expect(bare.credential).toBeNull(); // no grant key, no project default
        await s.close();
      });

      it('reads nothing else of a grant bound to another project (T2)', async () => {
        const s = await world();
        const r = await load(s, 'g-service', 'acme-prod');
        expect(r.token?.id).toBe('t-g-service');
        expect(r.project?.id).toBe('acme-prod');
        expect(r.grant?.projectId).toBe('side-eu');
        expect([r.user, r.credential, r.credentialOwner]).toEqual([null, null, null]);
        await s.close();
      });

      it('returns the token and grant only for an unknown or absent slug', async () => {
        const s = await world();
        for (const slug of ['nope', null]) {
          const r = await load(s, 'g-shared', slug);
          expect(r.token?.id).toBe('t-g-shared');
          expect(r.grant?.id).toBe('g-shared');
          expect([r.project, r.user, r.credential, r.credentialOwner]).toEqual([null, null, null, null]);
        }
        await s.close();
      });

      it('returns nothing at all for an unknown token hash', async () => {
        const s = await world();
        const r = await s.loadAccessRecords?.({ tokenHash: fakeTokenHash(1), projectSlug: 'acme-prod' });
        expect(r).toEqual({
          token: null,
          project: null,
          grant: null,
          user: null,
          credential: null,
          credentialOwner: null,
        });
        await s.close();
      });

      it('returns revoked, expired and disabled rows as stored (the caller decides)', async () => {
        const s = await world();
        await s.accessTokens.revoke('t-g-shared', 5);
        await s.grants.update('g-shared', { revokedAt: 6, expiresAt: 7 });
        await s.users.update('u2', { disabledAt: 8 });
        await s.credentials.update('c-u2', { revokedAt: 9 });
        await s.projects.update('acme-prod', { disabledAt: 10 });
        const r = await load(s, 'g-shared', 'acme-prod');
        expect(r.token?.revokedAt).toBe(5);
        expect([r.grant?.revokedAt, r.grant?.expiresAt]).toEqual([6, 7]);
        expect(r.credentialOwner?.disabledAt).toBe(8);
        expect(r.credential?.revokedAt).toBe(9);
        expect(r.project?.disabledAt).toBe(10);
        await s.close();
      });

      it('binds the slug and hash as values, never as SQL', async () => {
        const s = await world();
        const evil = "acme-prod' OR '1'='1";
        const r = await load(s, 'g-default', evil);
        expect(r.project).toBeNull();
        const none = await s.loadAccessRecords?.({ tokenHash: "x' OR '1'='1", projectSlug: 'acme-prod' });
        expect(none?.token).toBeNull();
        await s.close();
      });
    });

    describe('audit log', () => {
      it('refuses a non-finite limit (P3-15)', async () => {
        const { s } = await fresh();
        await rejects(s.auditLog.list({ limit: Number.NaN }), InvalidInputError);
        await rejects(s.auditLog.purgeBefore(1, Number.NaN), InvalidInputError);
        await rejects(s.auditLog.purgeBefore(1, Number.POSITIVE_INFINITY), InvalidInputError);
        await s.close();
      });

      it('is append-only: the repository has no update or delete besides retention purge', async () => {
        const { s } = await fresh();
        expect(Object.keys(s.auditLog).sort()).toEqual(['append', 'list', 'purgeBefore', 'stats']);
        await s.close();
      });

      it('aggregates tool calls in a bounded window, and lists the slowest', async () => {
        const { s } = await fresh();
        const day = 86_400_000;
        const row = (
          ts: number,
          action: string,
          status: 'ok' | 'error' | 'denied',
          ms: number | null,
          extra = {},
        ) =>
          s.auditLog.append({
            ts,
            kind: 'tool_call',
            action,
            status,
            durationMs: ms,
            inspectedCount: ms === null ? null : 10,
            projectId: 'p1',
            tokenId: 't1',
            ...extra,
          });
        await row(day + 1, 'run_nrql', 'ok', 100);
        await row(day + 2, 'run_nrql', 'error', 300);
        await row(2 * day + 3, 'run_nrql', 'ok', 200, { projectId: 'p2', tokenId: null });
        await row(2 * day + 4, 'list_accounts', 'denied', null);
        await s.auditLog.append({ ts: day + 5, kind: 'admin', action: 'token.create', status: 'ok' });
        await row(9 * day, 'run_nrql', 'ok', 5); // outside the window
        const w = { since: day, until: 3 * day };
        expect(await s.auditLog.stats({ ...w, groupBy: 'action' })).toEqual([
          {
            key: 'run_nrql',
            calls: 3,
            errors: 1,
            denied: 0,
            durationSumMs: 600,
            durationCount: 3,
            maxDurationMs: 300,
            inspectedCount: 30,
          },
          {
            key: 'list_accounts',
            calls: 1,
            errors: 0,
            denied: 1,
            durationSumMs: 0,
            durationCount: 0,
            maxDurationMs: null,
            inspectedCount: 0,
          },
        ]);
        expect((await s.auditLog.stats({ ...w, groupBy: 'day' })).map((r) => [r.key, r.calls])).toEqual([
          ['1970-01-03', 2],
          ['1970-01-02', 2],
        ]);
        expect((await s.auditLog.stats({ ...w, groupBy: 'project' })).map((r) => [r.key, r.calls])).toEqual([
          ['p1', 3],
          ['p2', 1],
        ]);
        expect(
          (await s.auditLog.stats({ ...w, groupBy: 'token', action: 'run_nrql' })).map((r) => [
            r.key,
            r.calls,
          ]),
        ).toEqual([
          ['t1', 2],
          [null, 1],
        ]);
        expect(await s.auditLog.stats({ ...w, groupBy: 'action', projectId: 'p2' })).toHaveLength(1);
        expect(await s.auditLog.stats({ ...w, groupBy: 'action', limit: 1 })).toHaveLength(1);
        // An unbounded or inverted window is refused (D1 row reads).
        await rejects(s.auditLog.stats({ since: 0, until: 91 * day, groupBy: 'action' }), InvalidInputError);
        await rejects(s.auditLog.stats({ since: 5, until: 5, groupBy: 'action' }), InvalidInputError);
        await rejects(s.auditLog.stats({ ...w, groupBy: 'action', limit: Number.NaN }), InvalidInputError);

        expect(
          (await s.auditLog.list({ kind: 'tool_call', order: 'slowest', limit: 3 })).map((r) => r.durationMs),
        ).toEqual([300, 200, 100]);
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
          keyId: null,
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
        await s.auditLog.append({
          ts: 600,
          kind: 'auth',
          action: 'auth.denied',
          status: 'denied',
          errorCode: 'missing_token',
        });
        expect((await s.auditLog.list({ kind: 'auth' })).map((r) => r.action)).toEqual(['auth.denied']);
        await s.auditLog.append({
          ts: 650,
          kind: 'tool_call',
          action: 'whoami',
          status: 'error',
          grantId: 'g1',
          tokenId: 't1',
        });
        expect((await s.auditLog.list({ action: 'token.create' })).map((r) => r.ts)).toEqual([400, 200]);
        expect((await s.auditLog.list({ status: 'denied' })).map((r) => r.ts)).toEqual([600]);
        expect((await s.auditLog.list({ status: 'error' })).map((r) => r.ts)).toEqual([650]);
        expect((await s.auditLog.list({ grantId: 'g1' })).map((r) => r.ts)).toEqual([650]);
        expect((await s.auditLog.list({ tokenId: 't1', kind: 'tool_call' })).map((r) => r.ts)).toEqual([650]);
        expect(await s.auditLog.list({ grantId: 'g2' })).toEqual([]);
        // pass-through rows (P2-16): a key fingerprint id instead of a grant and token
        await s.auditLog.append({
          ts: 660,
          kind: 'tool_call',
          action: 'run_nrql',
          status: 'ok',
          keyId: 'pt_aaaaaaaaaaaa',
        });
        await s.auditLog.append({
          ts: 670,
          kind: 'tool_call',
          action: 'whoami',
          status: 'ok',
          keyId: 'pt_bbbbbbbbbbbb',
        });
        expect((await s.auditLog.list({ keyId: 'pt_aaaaaaaaaaaa' })).map((r) => r.ts)).toEqual([660]);
        expect((await s.auditLog.list({ passthrough: true })).map((r) => r.ts)).toEqual([670, 660]);
        expect(await s.auditLog.list({ keyId: 'pt_cccccccccccc' })).toEqual([]);
        expect((await s.auditLog.list({ keyId: 'pt_aaaaaaaaaaaa' }))[0]?.grantId).toBeNull();
        // A limit deletes the oldest matching rows first; the rest wait for the next call.
        expect(await s.auditLog.purgeBefore(300, 1)).toBe(1);
        expect((await s.auditLog.list()).map((r) => r.ts)).toEqual([670, 660, 650, 600, 500, 400, 300, 200]);
        expect(await s.auditLog.purgeBefore(300, 5)).toBe(1);
        expect(await s.auditLog.purgeBefore(300, 5)).toBe(0);
        expect((await s.auditLog.list()).map((r) => r.ts)).toEqual([670, 660, 650, 600, 500, 400, 300]);
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
      it('refuses a non-finite expiry or limit instead of storing "never expires" (P3-15)', async () => {
        const { s } = await fresh();
        for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
          await rejects(s.kv.put('k', 'v', { expirationTtl: bad }), InvalidInputError);
          await rejects(s.kv.put('k', 'v', { expiration: bad }), InvalidInputError);
          await rejects(s.kv.list({ limit: bad }), InvalidInputError);
        }
        expect(await s.kv.get('k')).toBeNull();
        await s.close();
      });

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

      it('take returns a live value once and removes it (P4-01 single-use state)', async () => {
        const { s, clock } = await fresh();
        await s.kv.put('once', 'v1', { expirationTtl: 60 });
        expect(await s.kv.take('once')).toBe('v1');
        expect(await s.kv.take('once')).toBeNull();
        expect(await s.kv.get('once')).toBeNull();
        expect(await s.kv.take('never-written')).toBeNull();
        // Concurrent takes of one key: exactly one wins.
        await s.kv.put('race', 'v2');
        const results = await Promise.all([1, 2, 3, 4, 5].map(() => s.kv.take('race')));
        expect(results.filter((r) => r === 'v2')).toHaveLength(1);
        expect(results.filter((r) => r === null)).toHaveLength(4);
        // An expired value is not returned (and is gone afterwards).
        await s.kv.put('stale', 'v3', { expirationTtl: 60 });
        clock.advance(60_000);
        expect(await s.kv.take('stale')).toBeNull();
        expect((await s.kv.list({ prefix: 'stale' })).keys).toEqual([]);
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

      it('deletePrefix removes exactly the rows under one prefix in one call (P4-17)', async () => {
        const { s } = await fresh();
        for (const k of ['sess:u1:a', 'sess:u1:b', 'sess-seen:u1:a', 'sess:u12:a', 'sess:u2:a'])
          await s.kv.put(k, 'x');
        expect(await s.kv.deletePrefix('sess:u1:')).toBe(2);
        expect((await s.kv.list()).keys.map((k) => k.name)).toEqual([
          'sess-seen:u1:a',
          'sess:u12:a',
          'sess:u2:a',
        ]);
        expect(await s.kv.deletePrefix('sess:u1:')).toBe(0);
        // LIKE wildcards in a prefix are literal.
        await s.kv.put('a%b', 'x');
        await s.kv.put('axb', 'x');
        expect(await s.kv.deletePrefix('a%')).toBe(1);
        expect((await s.kv.list({ prefix: 'a' })).keys.map((k) => k.name)).toEqual(['axb']);
        await rejects(s.kv.deletePrefix(''), InvalidInputError);
        await s.close();
      });

      it('purgeExpired removes only expired rows, in bounded batches (P4-09)', async () => {
        const { s, clock } = await fresh();
        for (const k of ['e1', 'e2', 'e3']) await s.kv.put(`login:${k}`, 'x', { expirationTtl: 60 });
        await s.kv.put('live', 'y', { expirationTtl: 600 });
        await s.kv.put('forever', 'z');
        expect(await s.kv.purgeExpired()).toBe(0);
        clock.advance(60_000);
        expect(await s.kv.purgeExpired(2)).toBe(2);
        expect(await s.kv.purgeExpired(2)).toBe(1);
        expect(await s.kv.purgeExpired(2)).toBe(0);
        expect((await s.kv.list()).keys.map((k) => k.name)).toEqual(['forever', 'live']);
        for (const bad of [Number.NaN, Number.POSITIVE_INFINITY])
          await rejects(s.kv.purgeExpired(bad), InvalidInputError);
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
