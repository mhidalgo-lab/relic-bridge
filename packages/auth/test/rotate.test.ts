// SPDX-License-Identifier: Apache-2.0
import { createMemoryStorage, type EncryptedKey, type Storage } from '@relic-bridge/storage';
import { describe, expect, it } from 'vitest';
import { loadKeyringFromEnv } from '../src/crypto/env.ts';
import type { CryptoError } from '../src/crypto/errors.ts';
import { generateMasterKey, Keyring } from '../src/crypto/keyring.ts';
import {
  describeUnreadableKeys,
  keyCheckSettingKey,
  MAX_ROTATION_BATCH,
  rotateCredentialKeys,
  rotateCredentialKeysBatch,
  verifyKeyChecks,
} from '../src/crypto/rotate.ts';

const K1 = generateMasterKey(1);
const K2 = generateMasterKey(2);
const K3 = generateMasterKey(3);
const nrKey = (i: number): string => `NRAK-ROTATIONTEST${String(i).padStart(14, '0')}`;

async function seed(s: Storage, ring: Keyring, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const id = `cred_${i}`;
    await s.credentials.create({
      id,
      label: id,
      region: 'US',
      key: await ring.encryptCredentialKey(id, nrKey(i)),
    });
  }
}

async function readAll(s: Storage, ring: Keyring): Promise<string[]> {
  const out: string[] = [];
  for (const c of await s.credentials.list()) {
    if (c.key.kind !== 'encrypted') throw new Error('unexpected');
    out.push((await ring.decryptCredentialKey(c.id, c.key)).reveal());
  }
  return out;
}

const versions = async (s: Storage): Promise<number[]> =>
  (await s.credentials.list()).map((c) => (c.key.kind === 'encrypted' ? c.key.keyVersion : 0));

describe('loadKeyringFromEnv (boot check)', () => {
  it('requires RB_MASTER_KEY and reads RB_MASTER_KEY_PREVIOUS', async () => {
    await expect(loadKeyringFromEnv({})).rejects.toMatchObject({ code: 'master_key_missing' });
    await expect(loadKeyringFromEnv({ RB_MASTER_KEY: '  ' })).rejects.toMatchObject({
      code: 'master_key_missing',
    });
    await expect(loadKeyringFromEnv({ RB_MASTER_KEY: 42 })).rejects.toMatchObject({
      code: 'master_key_invalid',
    });
    const bad = 'c2hvcnQta2V5LXZhbHVlLXNob3VsZC1ub3QtbGVhaw';
    const e = (await loadKeyringFromEnv({ RB_MASTER_KEY: bad }).catch((x: unknown) => x)) as CryptoError;
    expect(e.code).toBe('master_key_invalid');
    expect(`${e.message}${e.hint}`).not.toContain(bad);
    const ring = await loadKeyringFromEnv({ RB_MASTER_KEY: K2, RB_MASTER_KEY_PREVIOUS: K1 });
    expect(ring.versions).toEqual([2, 1]);
    expect((await loadKeyringFromEnv({ RB_MASTER_KEY: K1, RB_MASTER_KEY_PREVIOUS: '' })).versions).toEqual([
      1,
    ]);
  });
});

describe('verifyKeyChecks', () => {
  it('registers new versions, accepts the same key and refuses a different one', async () => {
    const s = createMemoryStorage();
    const ring = await Keyring.create({ current: K1 });
    expect((await verifyKeyChecks(s, ring)).registered).toEqual([1]);
    expect(typeof (await s.settings.get(keyCheckSettingKey(1)))).toBe('string');
    expect((await verifyKeyChecks(s, ring)).registered).toEqual([]);
    const other = await Keyring.create({ current: generateMasterKey(1) });
    await expect(verifyKeyChecks(s, other)).rejects.toMatchObject({ code: 'key_mismatch' });
    await s.settings.set(keyCheckSettingKey(1), 'garbage');
    await expect(verifyKeyChecks(s, ring)).rejects.toMatchObject({ code: 'key_mismatch' });
    const fresh = createMemoryStorage();
    expect((await verifyKeyChecks(fresh, ring, { register: false })).registered).toEqual([]);
    expect(await fresh.settings.get(keyCheckSettingKey(1))).toBeUndefined();
  });

  it('registers a version only when existing rows prove the key, and never a previous key on trust', async () => {
    const r1 = await Keyring.create({ current: K1 });
    // Rows under v1 but no key check value yet (e.g. written before the check existed).
    const s = createMemoryStorage();
    await seed(s, r1, 2);
    const wrongPrev = await Keyring.create({ current: K2, previous: generateMasterKey(1) });
    await expect(verifyKeyChecks(s, wrongPrev)).rejects.toMatchObject({ code: 'key_mismatch' });
    expect(await s.settings.get(keyCheckSettingKey(1))).toBeUndefined();
    expect(await s.settings.get(keyCheckSettingKey(2))).toBeUndefined();
    const wrongCur = await Keyring.create({ current: generateMasterKey(1) });
    await expect(verifyKeyChecks(s, wrongCur)).rejects.toMatchObject({ code: 'key_mismatch' });
    // One tampered row does not block a correct key.
    const c1 = await s.credentials.get('cred_1');
    if (c1?.key.kind !== 'encrypted') throw new Error('unexpected');
    await s.credentials.update('cred_0', { key: c1.key });
    const ok = await Keyring.create({ current: K2, previous: K1 });
    expect((await verifyKeyChecks(s, ok)).registered).toEqual([2, 1]);
    // A previous version with no rows is not registered.
    const empty = createMemoryStorage();
    expect((await verifyKeyChecks(empty, ok)).registered).toEqual([2]);
    expect(await empty.settings.get(keyCheckSettingKey(1))).toBeUndefined();
  });
});

describe('rotateCredentialKeys', () => {
  it('re-encrypts every row (revoked included) under the new version', async () => {
    const s = createMemoryStorage();
    const r1 = await Keyring.create({ current: K1 });
    await seed(s, r1, 5);
    await s.credentials.update('cred_3', { revokedAt: 1 });
    const r21 = await Keyring.create({ current: K2, previous: K1 });
    const progress: number[] = [];
    const report = await rotateCredentialKeys(s, r21, { onProgress: (d) => progress.push(d) });
    expect(report).toMatchObject({ currentVersion: 2, total: 5, alreadyCurrent: 0, failed: [] });
    expect(report.reencrypted).toHaveLength(5);
    expect(report.versionsInUse).toEqual([2]);
    expect(progress).toEqual([1, 2, 3, 4, 5]);
    expect(await versions(s)).toEqual([2, 2, 2, 2, 2]);
    // Readable with the new key alone: the old one can be retired.
    const r2 = await Keyring.create({ current: K2 });
    expect(await readAll(s, r2)).toEqual([0, 1, 2, 3, 4].map(nrKey));
    // Old key alone no longer reads anything.
    await expect(readAll(s, r1)).rejects.toMatchObject({ code: 'key_version_unknown' });
  });

  it('is idempotent and resumes after a partial run', async () => {
    const s = createMemoryStorage();
    const r1 = await Keyring.create({ current: K1 });
    await seed(s, r1, 4);
    const r21 = await Keyring.create({ current: K2, previous: K1 });
    // Simulate a crash after two rows: rotate only those by hand, the way rotateCredentialKeys does.
    for (const id of ['cred_0', 'cred_1']) {
      const row = await s.credentials.get(id);
      if (row?.key.kind !== 'encrypted') throw new Error('unexpected');
      const plain = await r21.decryptCredentialKey(id, row.key);
      await s.credentials.update(id, {
        key: await r21.encryptCredentialKey(id, plain.reveal()),
        ifKey: row.key,
      });
    }
    expect(await versions(s)).toEqual([2, 2, 1, 1]);
    expect(await readAll(s, r21)).toEqual([0, 1, 2, 3].map(nrKey));
    const resumed = await rotateCredentialKeys(s, r21);
    expect(resumed).toMatchObject({ alreadyCurrent: 2, reencrypted: ['cred_2', 'cred_3'], failed: [] });
    const again = await rotateCredentialKeys(s, r21);
    expect(again).toMatchObject({ alreadyCurrent: 4, reencrypted: [], failed: [], versionsInUse: [2] });
  });

  it('chains rotations (1 -> 2 -> 3)', async () => {
    const s = createMemoryStorage();
    await seed(s, await Keyring.create({ current: K1 }), 2);
    await rotateCredentialKeys(s, await Keyring.create({ current: K2, previous: K1 }));
    const r32 = await Keyring.create({ current: K3, previous: K2 });
    const report = await rotateCredentialKeys(s, r32);
    expect(report).toMatchObject({ reencrypted: ['cred_0', 'cred_1'], versionsInUse: [3] });
    expect(await readAll(s, await Keyring.create({ current: K3 }))).toEqual([0, 1].map(nrKey));
  });

  it('reports rows it cannot read and leaves them untouched', async () => {
    const s = createMemoryStorage();
    await seed(s, await Keyring.create({ current: K2, previous: K1 }), 2);
    // An older version that is no longer loaded (a higher one is refused outright: key_version_retired).
    const stranger = await Keyring.create({ current: K1 });
    await s.credentials.create({
      id: 'cred_old',
      label: 'x',
      region: 'US',
      key: await stranger.encryptCredentialKey('cred_old', nrKey(9)),
    });
    // Swap cred_1's ciphertext onto cred_0's row (stolen-row attack): AAD makes it fail.
    const c1 = await s.credentials.get('cred_1');
    const c0 = await s.credentials.get('cred_0');
    if (c1?.key.kind !== 'encrypted' || c0?.key.kind !== 'encrypted') throw new Error('unexpected');
    await s.credentials.update('cred_0', { key: c1.key });
    const r32 = await Keyring.create({ current: K3, previous: K2 });
    const report = await rotateCredentialKeys(s, r32);
    expect(report.reencrypted).toEqual(['cred_1']);
    expect(report.failed).toEqual([
      { id: 'cred_0', code: 'decrypt_failed' },
      { id: 'cred_old', code: 'key_version_unknown' },
    ]);
    expect(report.versionsInUse).toEqual([1, 2, 3]);
    const after = await s.credentials.get('cred_0');
    expect(after?.key.kind === 'encrypted' && after.key.keyVersion).toBe(2);
  });

  it('never overwrites a key replaced while rotating (compare-and-swap)', async () => {
    const base = createMemoryStorage();
    const r1 = await Keyring.create({ current: K1 });
    await seed(base, r1, 1);
    const r21 = await Keyring.create({ current: K2, previous: K1 });
    const replaced: EncryptedKey = await r21.encryptCredentialKey('cred_0', 'NRAK-REPLACEDDURINGROTATION000');
    // A storage whose update races with an admin replacing the key just before rotation writes.
    const racing: Storage = {
      ...base,
      credentials: {
        ...base.credentials,
        async update(id, patch) {
          if (patch.ifKey !== undefined) await base.credentials.update(id, { key: replaced });
          return base.credentials.update(id, patch);
        },
      },
    };
    const report = await rotateCredentialKeys(racing, r21);
    expect(report.failed).toEqual([{ id: 'cred_0', code: 'conflict' }]);
    expect(await readAll(base, r21)).toEqual(['NRAK-REPLACEDDURINGROTATION000']);
  });

  it('refuses to start with a mismatched key and touches nothing', async () => {
    const s = createMemoryStorage();
    const r1 = await Keyring.create({ current: K1 });
    await seed(s, r1, 2);
    await verifyKeyChecks(s, r1);
    const wrongPrevious = await Keyring.create({ current: K2, previous: generateMasterKey(1) });
    await expect(rotateCredentialKeys(s, wrongPrevious)).rejects.toMatchObject({ code: 'key_mismatch' });
    expect(await versions(s)).toEqual([1, 1]);
  });

  it('puts the old ciphertext back when a written row does not read back', async () => {
    const base = createMemoryStorage();
    await seed(base, await Keyring.create({ current: K1 }), 1);
    const r21 = await Keyring.create({ current: K2, previous: K1 });
    const garbled: EncryptedKey = await r21.encryptCredentialKey('cred_0', 'NRAK-SOMETHING-ELSE');
    // An adapter that corrupts what it stores on the rotation write.
    const broken: Storage = {
      ...base,
      credentials: {
        ...base.credentials,
        update: (id, patch) =>
          base.credentials.update(id, patch.key?.keyVersion === 2 ? { ...patch, key: garbled } : patch),
      },
    };
    const report = await rotateCredentialKeys(broken, r21);
    expect(report.failed).toEqual([{ id: 'cred_0', code: 'decrypt_failed' }]);
    expect(await versions(base)).toEqual([1]);
    expect(await readAll(base, r21)).toEqual([nrKey(0)]);
  });

  it('propagates unexpected storage errors (run again to resume)', async () => {
    const base = createMemoryStorage();
    await seed(base, await Keyring.create({ current: K1 }), 1);
    const broken: Storage = {
      ...base,
      credentials: {
        ...base.credentials,
        update: async () => {
          throw new Error('disk full');
        },
      },
    };
    await expect(
      rotateCredentialKeys(broken, await Keyring.create({ current: K2, previous: K1 })),
    ).rejects.toThrow('disk full');
    expect(await versions(base)).toEqual([1]);
  });
});

describe('rotateCredentialKeysBatch (P3-11)', () => {
  it('visits every row once in bounded batches, each row readable after every batch', async () => {
    const s = createMemoryStorage();
    const r1 = await Keyring.create({ current: K1 });
    await seed(s, r1, 7);
    const r21 = await Keyring.create({ current: K2, previous: K1 });
    const cursors: (string | null)[] = [];
    let after: string | null = null;
    const rotated: string[] = [];
    for (let i = 0; i < 10; i++) {
      const report = await rotateCredentialKeysBatch(s, r21, { after, limit: 3 });
      expect(report.reencrypted.length).toBeLessThanOrEqual(3);
      expect(report.failed).toEqual([]);
      rotated.push(...report.reencrypted);
      expect(await readAll(s, r21)).toEqual([0, 1, 2, 3, 4, 5, 6].map(nrKey));
      expect(report.pending).toBe(7 - rotated.length);
      cursors.push(report.nextCursor);
      if (report.nextCursor === null) break;
      after = report.nextCursor;
    }
    expect(cursors).toEqual(['cred_2', 'cred_5', null]);
    expect(rotated).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => `cred_${i}`));
    expect(await versions(s)).toEqual([2, 2, 2, 2, 2, 2, 2]);
    // Idempotent: a new run changes nothing and finishes in one call.
    const again = await rotateCredentialKeysBatch(s, r21, { limit: 3 });
    expect(again).toMatchObject({
      reencrypted: [],
      alreadyCurrent: 7,
      nextCursor: null,
      pending: 0,
      versionsInUse: [2],
    });
  });

  it('resumes from the start after an interruption, skipping finished rows without counting them', async () => {
    const s = createMemoryStorage();
    await seed(s, await Keyring.create({ current: K1 }), 5);
    const r21 = await Keyring.create({ current: K2, previous: K1 });
    const first = await rotateCredentialKeysBatch(s, r21, { limit: 2 });
    expect(first).toMatchObject({ reencrypted: ['cred_0', 'cred_1'], nextCursor: 'cred_1', pending: 3 });
    // The client lost the cursor: start over.
    const second = await rotateCredentialKeysBatch(s, r21, { limit: 2 });
    expect(second).toMatchObject({
      reencrypted: ['cred_2', 'cred_3'],
      alreadyCurrent: 2,
      nextCursor: 'cred_3',
      pending: 1,
    });
    const third = await rotateCredentialKeysBatch(s, r21, { after: 'cred_3', limit: 2 });
    expect(third).toMatchObject({
      reencrypted: ['cred_4'],
      nextCursor: null,
      pending: 0,
      versionsInUse: [2],
    });
  });

  it('moves past rows it cannot rotate instead of retrying them forever', async () => {
    const s = createMemoryStorage();
    await seed(s, await Keyring.create({ current: K1 }), 3);
    const r2 = await Keyring.create({ current: K2 });
    // No previous key: nothing can be decrypted, every row is reported and the cursor still advances.
    const a = await rotateCredentialKeysBatch(s, r2, { limit: 2 });
    expect(a.failed).toEqual([
      { id: 'cred_0', code: 'key_version_unknown' },
      { id: 'cred_1', code: 'key_version_unknown' },
    ]);
    expect(a.nextCursor).toBe('cred_1');
    const b = await rotateCredentialKeysBatch(s, r2, { after: a.nextCursor, limit: 2 });
    expect(b).toMatchObject({ failed: [{ id: 'cred_2', code: 'key_version_unknown' }], nextCursor: null });
    expect(b.pending).toBe(3);
    expect(await versions(s)).toEqual([1, 1, 1]);
  });

  it('reports a concurrent change as a conflict and never overwrites it', async () => {
    const base = createMemoryStorage();
    await seed(base, await Keyring.create({ current: K1 }), 2);
    const r21 = await Keyring.create({ current: K2, previous: K1 });
    const replaced = await r21.encryptCredentialKey('cred_0', 'NRAK-REPLACEDDURINGROTATION000');
    const racing: Storage = {
      ...base,
      credentials: {
        ...base.credentials,
        async update(id, patch) {
          if (id === 'cred_0' && patch.ifKey !== undefined)
            await base.credentials.update(id, { key: replaced });
          return base.credentials.update(id, patch);
        },
      },
    };
    const report = await rotateCredentialKeysBatch(racing, r21, { limit: 10 });
    expect(report.failed).toEqual([{ id: 'cred_0', code: 'conflict' }]);
    expect(report.reencrypted).toEqual(['cred_1']);
    expect(await readAll(base, r21)).toEqual(['NRAK-REPLACEDDURINGROTATION000', nrKey(1)]);
  });

  it('verifies key checks first: wrong previous key or a retired current key touches nothing', async () => {
    const s = createMemoryStorage();
    const r1 = await Keyring.create({ current: K1 });
    await seed(s, r1, 2);
    await verifyKeyChecks(s, r1);
    const wrong = await Keyring.create({ current: K2, previous: generateMasterKey(1) });
    await expect(rotateCredentialKeysBatch(s, wrong, { limit: 5 })).rejects.toMatchObject({
      code: 'key_mismatch',
    });
    expect(await versions(s)).toEqual([1, 1]);
    // Rotate to v2, then try to run on the retired v1 key (SR-1).
    await rotateCredentialKeysBatch(s, await Keyring.create({ current: K2, previous: K1 }), { limit: 5 });
    await expect(rotateCredentialKeysBatch(s, r1, { limit: 5 })).rejects.toMatchObject({
      code: 'key_version_retired',
    });
    expect(await versions(s)).toEqual([2, 2]);
  });

  it('refuses a batch size out of bounds', async () => {
    const s = createMemoryStorage();
    const r1 = await Keyring.create({ current: K1 });
    for (const limit of [0, -1, 1.5, MAX_ROTATION_BATCH + 1, Number.NaN]) {
      await expect(rotateCredentialKeysBatch(s, r1, { limit })).rejects.toMatchObject({
        code: 'invalid_input',
      });
    }
  });
});

describe('unreadable rows report (P3-15)', () => {
  it('counts credentials under a version the keyring lacks, per version, without ids', async () => {
    const s = createMemoryStorage();
    const k1 = await Keyring.create({ current: K1 });
    await seed(s, k1, 3);
    const k2 = await Keyring.create({ current: K2, previous: K1 });
    expect((await verifyKeyChecks(s, k2)).unreadable).toEqual([]);
    // Previous key removed before the rotation finished.
    const onlyK2 = await Keyring.create({ current: K2 });
    const result = await verifyKeyChecks(s, onlyK2, { register: false });
    expect(result.unreadable).toEqual([{ version: 1, rows: 3 }]);
    const text = describeUnreadableKeys(result.unreadable) ?? '';
    expect(text).toContain('3 under version 1');
    expect(text).not.toContain('cred_');
    expect(describeUnreadableKeys([])).toBeUndefined();
  });
});
