// SPDX-License-Identifier: Apache-2.0
// Admin token strength (P3-13, T14): predictable values are refused at boot, hand-made ones are warned about, and
// generated ones (any common generator) pass without a warning.
import { describe, expect, it } from 'vitest';
import {
  ADMIN_TOKEN_ADVICE,
  adminTokenLooksWeak,
  checkAdminToken,
  describeAdminTokenProblem,
} from '../src/index.ts';

const random = (bytes: number): Uint8Array => crypto.getRandomValues(new Uint8Array(bytes));
const hex = (bytes: number): string =>
  Array.from(random(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
const base64 = (bytes: number): string => btoa(String.fromCharCode(...random(bytes)));
const base64url = (bytes: number): string =>
  base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('checkAdminToken', () => {
  it.each([
    ['a single repeated character', 'a'.repeat(32)],
    ['two characters', 'ab'.repeat(20)],
    ['a repeated block', 'Xy7#kP2q'.repeat(5)],
    ['a repeated block with a partial tail', `${'Q9z!w8'.repeat(6)}Q9z`],
    ['an alphabet run', 'abcdefghijklmnopqrstuvwxyz0123456789'],
    ['runs of the same character', 'aaaabbbbccccddddeeeeffffgggghhhh'],
    ['keyboard-ish steps', '0123456789:;<=>?@ABCDEFGHIJKLMNOPQ'],
  ])('refuses %s as low_entropy', (_name, value) => {
    expect(checkAdminToken(value)).toBe('low_entropy');
  });

  it.each([
    'changeme-Hq3x9Lw2Zp7Rt5Vb1Nc8Md4Kf6Gj0Ys',
    'CHANGE_ME_Hq3x9Lw2Zp7Rt5Vb1Nc8Md4Kf6Gj0',
    'replace-me-with-Hq3x9Lw2Zp7Rt5Vb1Nc8Md4K',
    'your-admin-token-Hq3x9Lw2Zp7Rt5Vb1Nc8Md4',
    'Hq3x9Lw2Zp7Rt5Vb1Nc8Md4Kf6Gj0Ys-example',
    'super-Password-Hq3x9Lw2Zp7Rt5Vb1Nc8Md4Kf',
  ])('refuses the placeholder %s', (value) => {
    expect(checkAdminToken(value)).toBe('placeholder');
  });

  it('keeps the length and character checks', () => {
    expect(checkAdminToken('Hq3x9Lw2Zp7Rt5Vb')).toBe('too_short');
    expect(checkAdminToken(base64url(400))).toBe('too_long');
    expect(checkAdminToken(`${base64url(32)} x`)).toBe('invalid_characters');
  });

  it('accepts and does not warn about generated tokens (base64, base64url, hex; 1,000 samples each)', () => {
    for (const make of [() => base64(32), () => base64url(32), () => hex(32), () => base64url(24)]) {
      let warned = 0;
      for (let i = 0; i < 1000; i++) {
        const value = make();
        expect(checkAdminToken(value), value).toBeNull();
        if (adminTokenLooksWeak(value)) warned++;
      }
      // Best effort: random base64 lacks a digit about once in 1,700 tokens, or holds a word like "test".
      expect(warned).toBeLessThanOrEqual(10);
    }
  });

  // Best effort: a long passphrase of mixed-case words is not recognised (no dictionary is shipped).
  it('accepts but warns about hand-made tokens', () => {
    for (const value of [
      'my-relic-bridge-admin-for-the-house-2026',
      'qwertyuiopasdfghjklzxcvbnm-qwertyuiop',
      'kitchen-window-garden-sofa-lamp-river',
    ]) {
      expect(checkAdminToken(value), value).toBeNull();
      expect(adminTokenLooksWeak(value), value).toBe(true);
    }
  });

  it('describes every problem without the token and points at a generator', () => {
    for (const problem of [
      'too_short',
      'too_long',
      'invalid_characters',
      'low_entropy',
      'placeholder',
    ] as const) {
      expect(describeAdminTokenProblem(problem)).toMatch(/\w/);
    }
    expect(ADMIN_TOKEN_ADVICE).toMatch(/openssl rand -base64 32/);
  });
});
