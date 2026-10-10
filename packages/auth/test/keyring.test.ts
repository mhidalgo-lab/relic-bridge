// SPDX-License-Identifier: Apache-2.0
import type { EncryptedKey } from '@relic-bridge/storage';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fromBase64, timingSafeEqual, toBase64 } from '../src/crypto/bytes.ts';
import { CryptoError, type CryptoErrorCode } from '../src/crypto/errors.ts';
import { generateMasterKey, Keyring, parseMasterKey } from '../src/crypto/keyring.ts';

const NR_KEY = 'NRAK-ABCDEFGHIJKLMNOPQRSTUVWXYZ0';
const K1 = generateMasterKey(1);
const K2 = generateMasterKey(2);
const ring1 = await Keyring.create({ current: K1 });
const ring21 = await Keyring.create({ current: K2, previous: K1 });

async function fails(p: Promise<unknown>, code: CryptoErrorCode): Promise<CryptoError> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoError);
    expect((error as CryptoError).code).toBe(code);
    return error as CryptoError;
  }
  throw new Error(`expected ${code}`);
}

const flip = (bytes: Uint8Array, bit: number): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(bytes);
  out[bit >> 3] = (out[bit >> 3] ?? 0) ^ (1 << (bit & 7));
  return out;
};

describe('bytes', () => {
  it('decodes strict base64 (standard or URL-safe, padding optional) and refuses the rest', () => {
    const raw = Uint8Array.from({ length: 32 }, (_, i) => i * 8 + 3);
    const std = toBase64(raw);
    const url = std.replaceAll('+', '-').replaceAll('/', '_');
    for (const text of [std, std.replace(/=+$/, ''), url, url.replace(/=+$/, '')]) {
      expect([...(fromBase64(text) ?? [])]).toEqual([...raw]);
    }
    for (const bad of ['', 'a', 'ab=c', 'a b', '+-ab', 'abc==', 'YQ===', 'YR==']) {
      expect(fromBase64(bad)).toBeNull();
    }
  });

  it('timingSafeEqual compares content and length', () => {
    expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 0))).toBe(false);
    expect(timingSafeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
    expect(timingSafeEqual(new Uint8Array(0), Uint8Array.of(0))).toBe(false);
  });
});

describe('master keys', () => {
  it('generates distinct v<N>: keys of 32 random bytes', () => {
    const a = generateMasterKey(3);
    expect(a).toMatch(/^v3:[A-Za-z0-9+/]{43}=$/);
    expect(generateMasterKey()).toMatch(/^v1:/);
    expect(a).not.toBe(generateMasterKey(3));
    expect(parseMasterKey(a).version).toBe(3);
    expect(() => generateMasterKey(0)).toThrow(CryptoError);
    expect(() => generateMasterKey(1.5)).toThrow(CryptoError);
  });

  it('reads a bare base64 key as version 1', () => {
    const bare = K1.slice('v1:'.length);
    expect(parseMasterKey(bare).version).toBe(1);
    expect(parseMasterKey(`  ${bare}\n`).version).toBe(1);
  });

  it('refuses malformed keys without echoing them', () => {
    const short = toBase64(crypto.getRandomValues(new Uint8Array(16)));
    const long = toBase64(crypto.getRandomValues(new Uint8Array(48)));
    const zeros = toBase64(new Uint8Array(32));
    const cases = [
      '',
      'not a key',
      short,
      long,
      zeros,
      `v0:${K1.slice(3)}`,
      `v1000000:${K1.slice(3)}`,
      `v01:${K1.slice(3)}`,
      `x1:${K1.slice(3)}`,
    ];
    for (const text of cases) {
      let error: unknown;
      try {
        parseMasterKey(text, 'RB_MASTER_KEY');
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(CryptoError);
      expect((error as CryptoError).code).toBe('master_key_invalid');
      const message = `${(error as CryptoError).message} ${(error as CryptoError).hint ?? ''}`;
      expect(message).toContain('RB_MASTER_KEY');
      if (text.length > 8) expect(message).not.toContain(text.replace(/^v\d+:/, '').slice(0, 12));
    }
  });

  it('builds keyrings only with a lower, different previous key', async () => {
    await fails(Keyring.create({ current: K1, previous: K2 }), 'master_key_invalid');
    await fails(Keyring.create({ current: K1, previous: generateMasterKey(1) }), 'master_key_invalid');
    const same = await fails(
      Keyring.create({ current: `v2:${K1.slice(3)}`, previous: K1 }),
      'master_key_invalid',
    );
    expect(same.message).toContain('same key');
    await fails(Keyring.create({ current: K2, previous: 'nope' }), 'master_key_invalid');
    expect(ring21.currentVersion).toBe(2);
    expect(ring21.versions).toEqual([2, 1]);
    expect(ring21.has(1) && ring21.has(2) && !ring21.has(3)).toBe(true);
  });

  it('never serialises key material', () => {
    const json = JSON.stringify({ ring21 });
    expect(json).toContain('"currentVersion":2');
    for (const k of [K1, K2]) expect(json).not.toContain(k.slice(3, 15));
    expect(String(ring21)).toBe('Keyring(v2)');
  });
});

describe('credential cipher', () => {
  it('round-trips and returns a Secret', async () => {
    const enc = await ring1.encryptCredentialKey('cred_a', NR_KEY);
    expect(enc).toMatchObject({ kind: 'encrypted', keyVersion: 1 });
    expect(enc.iv.byteLength).toBe(12);
    expect(enc.ciphertext.byteLength).toBe(NR_KEY.length + 16);
    const secret = await ring1.decryptCredentialKey('cred_a', enc);
    expect(secret.reveal()).toBe(NR_KEY);
    expect(JSON.stringify({ secret })).not.toContain(NR_KEY);
  });

  it('round-trips arbitrary ids and keys, with a fresh IV every time (property)', async () => {
    const seen = new Set<string>();
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.string({ minLength: 1, maxLength: 200, unit: 'binary' }),
        async (id, key) => {
          const enc = await ring21.encryptCredentialKey(id, key);
          const iv = toBase64(enc.iv);
          expect(seen.has(iv)).toBe(false);
          seen.add(iv);
          expect((await ring21.decryptCredentialKey(id, enc)).reveal()).toBe(key);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('fails on any single flipped bit in the ciphertext, tag or IV (property)', async () => {
    const enc = await ring1.encryptCredentialKey('cred_a', NR_KEY);
    const ctBits = enc.ciphertext.byteLength * 8;
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: ctBits + 96 - 1 }), async (bit) => {
        const tampered: EncryptedKey =
          bit < ctBits
            ? { ...enc, ciphertext: flip(enc.ciphertext, bit) }
            : { ...enc, iv: flip(enc.iv, bit - ctBits) };
        await fails(ring1.decryptCredentialKey('cred_a', tampered), 'decrypt_failed');
      }),
      { numRuns: 300 },
    );
  });

  it('fails when a ciphertext is moved to another credential (swapped AAD, property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 1, maxLength: 40 }),
        async (a, b) => {
          fc.pre(a !== b);
          const enc = await ring1.encryptCredentialKey(a, NR_KEY);
          await fails(ring1.decryptCredentialKey(b, enc), 'decrypt_failed');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('fails when the key version is relabelled or unknown', async () => {
    const v1 = await ring1.encryptCredentialKey('cred_a', NR_KEY);
    // Same bytes under both versions can't be built (refused above), so relabel with a keyring that maps v2 to the
    // v1 key bytes: only the AAD differs, and it must still fail.
    const sameBytesAsV2 = await Keyring.create({ current: `v2:${K1.slice(3)}` });
    await fails(sameBytesAsV2.decryptCredentialKey('cred_a', { ...v1, keyVersion: 2 }), 'decrypt_failed');
    // Relabelled onto a version the keyring holds with another key.
    await fails(ring21.decryptCredentialKey('cred_a', { ...v1, keyVersion: 2 }), 'decrypt_failed');
    const unknown = await fails(
      ring1.decryptCredentialKey('cred_a', { ...v1, keyVersion: 3 }),
      'key_version_unknown',
    );
    expect(unknown.message).toContain('version 3');
    // The genuine row still reads under a keyring that has v1 as its previous key.
    expect((await ring21.decryptCredentialKey('cred_a', v1)).reveal()).toBe(NR_KEY);
  });

  it('fails with the wrong master key for the same version', async () => {
    const enc = await ring1.encryptCredentialKey('cred_a', NR_KEY);
    const other = await Keyring.create({ current: generateMasterKey(1) });
    const e = await fails(other.decryptCredentialKey('cred_a', enc), 'decrypt_failed');
    expect(e.message).toContain('cred_a');
    expect(`${e.message}${e.hint}`).not.toContain(NR_KEY);
  });

  it('validates inputs', async () => {
    const enc = await ring1.encryptCredentialKey('cred_a', NR_KEY);
    await fails(ring1.encryptCredentialKey('', NR_KEY), 'invalid_input');
    await fails(ring1.encryptCredentialKey('x'.repeat(257), NR_KEY), 'invalid_input');
    await fails(ring1.encryptCredentialKey('cred_a', ''), 'invalid_input');
    await fails(ring1.encryptCredentialKey('cred_a', 'x'.repeat(4097)), 'invalid_input');
    await fails(ring1.decryptCredentialKey('cred_a', { ...enc, iv: new Uint8Array(16) }), 'decrypt_failed');
    await fails(
      ring1.decryptCredentialKey('cred_a', { ...enc, ciphertext: enc.ciphertext.slice(0, 16) }),
      'decrypt_failed',
    );
    await fails(
      ring1.decryptCredentialKey('cred_a', { kind: 'env', variable: 'X' } as never),
      'invalid_input',
    );
    await fails(ring1.decryptCredentialKey('cred_a', { ...enc, keyVersion: 1.5 }), 'key_version_unknown');
  });

  it('accepts ciphertext views from storage (offset Uint8Array)', async () => {
    const enc = await ring1.encryptCredentialKey('cred_a', NR_KEY);
    const backing = new Uint8Array(enc.ciphertext.byteLength + 8);
    backing.set(enc.ciphertext, 8);
    const view = backing.subarray(8);
    expect((await ring1.decryptCredentialKey('cred_a', { ...enc, ciphertext: view })).reveal()).toBe(NR_KEY);
  });
});
