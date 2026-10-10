// SPDX-License-Identifier: Apache-2.0
// Known-answer tests. NIST vectors pin AES-256-GCM itself (through the same `seal`/`open` path the keyring uses);
// the relic-bridge vectors pin the storage format (HKDF labels, AAD layout, ciphertext layout). The relic-bridge
// vectors were cross-checked with an independent implementation (OpenSSL via `node:crypto` hkdfSync + aes-256-gcm).
// If one of those changes, every stored NR key becomes unreadable: that needs a new format version, not a new pin.
import { describe, expect, it } from 'vitest';
import { toHex } from '../src/crypto/bytes.ts';
import { credentialAad, deriveVersionKeys, Keyring, open, seal } from '../src/crypto/keyring.ts';

const hex = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from((s.match(/../g) ?? []).map((x) => Number.parseInt(x, 16)));

const aesKey = (k: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', hex(k), 'AES-GCM', false, ['encrypt', 'decrypt']);

// The Galois/Counter Mode of Operation (McGrew & Viega), test cases 13, 14 and 16 (AES-256, 96-bit IV).
const NIST = [
  {
    name: 'TC13 (empty)',
    key: '0000000000000000000000000000000000000000000000000000000000000000',
    iv: '000000000000000000000000',
    aad: '',
    pt: '',
    out: '530f8afbc74536b9a963b4f1c4cb738b',
  },
  {
    name: 'TC14 (one zero block)',
    key: '0000000000000000000000000000000000000000000000000000000000000000',
    iv: '000000000000000000000000',
    aad: '',
    pt: '00000000000000000000000000000000',
    out: 'cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919',
  },
  {
    name: 'TC16 (with AAD)',
    key: 'feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308', // gitleaks:allow (public NIST vector)
    iv: 'cafebabefacedbaddecaf888',
    aad: 'feedfacedeadbeeffeedfacedeadbeefabaddad2',
    pt: 'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39',
    out: '522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f66276fc6ece0f4e1768cddf8853bb2d551b',
  },
];

describe('AES-256-GCM known answers (NIST)', () => {
  for (const v of NIST) {
    it(v.name, async () => {
      const key = await aesKey(v.key);
      expect(toHex(await seal(key, hex(v.iv), hex(v.aad), hex(v.pt)))).toBe(v.out);
      expect(toHex(await open(key, hex(v.iv), hex(v.aad), hex(v.out)))).toBe(v.pt);
    });
  }
});

// Master key 00 01 02 … 1f, version 7, credential `cred_0123`, IV a0 a1 … ab.
const MASTER = Uint8Array.from({ length: 32 }, (_, i) => i);
const MASTER_TEXT = `v7:${btoa(String.fromCharCode(...MASTER))}`;
const KCV = '82a2eab6757bf6d8a6fb024b4ee21aa74940969d1d7c4c99d7df11487bcdfd26';
const AAD =
  '0000001e' + // len("relic-bridge/credential-key/v1") = 30
  '72656c69632d6272696467652f63726564656e7469616c2d6b65792f7631' +
  '00000009' + // len("cred_0123")
  '637265645f30313233' +
  '00000007'; // key version
const IV = 'a0a1a2a3a4a5a6a7a8a9aaab';
const PLAINTEXT = 'NRAK-TESTVECTOR0000000000000000';
const CIPHERTEXT =
  '81777afa80b9e6b05cda43cf144071e04a6827695bf13503fa3dc7d7a7729477bf98df3f945007da8082f434afd475';

describe('relic-bridge format known answers', () => {
  it('derives the pinned key check value', async () => {
    const keys = await deriveVersionKeys(new Uint8Array(MASTER));
    expect(toHex(keys.check)).toBe(KCV);
    const ring = await Keyring.create({ current: MASTER_TEXT });
    expect(toHex(ring.keyCheckValue(7))).toBe(KCV);
  });

  it('lays out the AAD as length-prefixed purpose, credential id and version', () => {
    expect(toHex(credentialAad('cred_0123', 7))).toBe(AAD);
  });

  it('produces and reads the pinned credential ciphertext', async () => {
    const keys = await deriveVersionKeys(new Uint8Array(MASTER));
    const sealed = await seal(
      keys.aes,
      hex(IV),
      credentialAad('cred_0123', 7),
      new TextEncoder().encode(PLAINTEXT),
    );
    expect(toHex(sealed)).toBe(CIPHERTEXT);
    // The public API reads the pinned row.
    const ring = await Keyring.create({ current: MASTER_TEXT });
    const secret = await ring.decryptCredentialKey('cred_0123', {
      kind: 'encrypted',
      ciphertext: hex(CIPHERTEXT),
      iv: hex(IV),
      keyVersion: 7,
    });
    expect(secret.reveal()).toBe(PLAINTEXT);
  });

  it('zeroes the master key bytes after derivation', async () => {
    const bytes = new Uint8Array(MASTER);
    await deriveVersionKeys(bytes);
    expect(bytes.every((b) => b === 0)).toBe(true);
  });
});
