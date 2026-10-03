// SPDX-License-Identifier: Apache-2.0
// Regression tests for the P2-03 second security review (THREAT_MODEL T7).
import { createMemoryStorage } from '@relic-bridge/storage';
import { describe, expect, it } from 'vitest';
import { toBase64 } from '../src/crypto/bytes.ts';
import { generateMasterKey, Keyring } from '../src/crypto/keyring.ts';
import { keyCheckSettingKey, rotateCredentialKeys, verifyKeyChecks } from '../src/crypto/rotate.ts';

describe('security review (P2-03)', () => {
  it('SR-1: refuses a current key whose version is below an already registered version (downgrade)', async () => {
    const s = createMemoryStorage();
    const k1 = generateMasterKey(1);
    const k2 = generateMasterKey(2);
    await verifyKeyChecks(s, await Keyring.create({ current: k1 }));
    await verifyKeyChecks(s, await Keyring.create({ current: k2, previous: k1 }));
    // Rolling back to the retired v1 key would encrypt new credentials under it.
    await expect(verifyKeyChecks(s, await Keyring.create({ current: k1 }))).rejects.toMatchObject({
      code: 'key_version_retired',
    });
    // Rotation refuses too, before touching a row.
    await expect(rotateCredentialKeys(s, await Keyring.create({ current: k1 }))).rejects.toMatchObject({
      code: 'key_version_retired',
    });
    // The registered current key still passes.
    await expect(verifyKeyChecks(s, await Keyring.create({ current: k2 }))).resolves.toBeDefined();
  });

  it('SR-1: refuses a current key when rows already use a higher version', async () => {
    const s = createMemoryStorage();
    const k1 = generateMasterKey(1);
    const r2 = await Keyring.create({ current: generateMasterKey(2), previous: k1 });
    await s.credentials.create({
      id: 'c1',
      label: 'c1',
      region: 'US',
      key: await r2.encryptCredentialKey('c1', 'NRAK-X'),
    });
    await expect(verifyKeyChecks(s, await Keyring.create({ current: k1 }))).rejects.toMatchObject({
      code: 'key_version_retired',
    });
  });

  it('SR-2: refuses a master key already registered under another version (key reuse)', async () => {
    const s = createMemoryStorage();
    const k1 = generateMasterKey(1);
    await verifyKeyChecks(s, await Keyring.create({ current: k1 }));
    const reused = `v3:${k1.slice(3)}`;
    await expect(verifyKeyChecks(s, await Keyring.create({ current: reused }))).rejects.toMatchObject({
      code: 'key_mismatch',
    });
    expect(await s.settings.get(keyCheckSettingKey(3))).toBeUndefined();
  });

  it('SR-3: refuses to encrypt a string that does not round-trip through UTF-8 (lone surrogate)', async () => {
    const ring = await Keyring.create({ current: generateMasterKey(1) });
    await expect(ring.encryptCredentialKey('c1', 'NRAK-\uD800')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(ring.encryptCredentialKey('c1', 'NRAK-\uDC00x')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    // Well-formed astral characters are fine.
    const enc = await ring.encryptCredentialKey('c1', 'NRAK-\u{1F511}');
    expect((await ring.decryptCredentialKey('c1', enc)).reveal()).toBe('NRAK-\u{1F511}');
  });

  it('SR-4: detects a concurrent registration of a different key for the same version', async () => {
    const s = createMemoryStorage();
    const mine = await Keyring.create({ current: generateMasterKey(1) });
    const theirs = await Keyring.create({ current: generateMasterKey(1) });
    // Another process registers its key between our read and our write.
    const realSet = s.settings.set.bind(s.settings);
    let raced = false;
    s.settings.set = async (key, value) => {
      await realSet(key, value);
      if (!raced && key === keyCheckSettingKey(1)) {
        raced = true;
        await verifyKeyChecks(s, theirs).catch(() => undefined);
        await realSet(key, toBase64(theirs.keyCheckValue(1)));
      }
    };
    await expect(verifyKeyChecks(s, mine)).rejects.toMatchObject({ code: 'key_mismatch' });
  });
});
