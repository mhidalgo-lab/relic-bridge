// SPDX-License-Identifier: Apache-2.0
// Base64 parsing (P8-99, CodeQL js/redos): the validity check must be linear on hostile input.
import { describe, expect, it } from 'vitest';
import { fromBase64, toBase64 } from '../src/crypto/bytes.ts';

describe('fromBase64', () => {
  it('accepts standard and URL-safe spellings, padded or not, and rejects mixed alphabets', () => {
    const bytes = new Uint8Array([251, 255, 190, 1, 2]);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(fromBase64(toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''))).toEqual(
      bytes,
    );
    expect(fromBase64('+/-_')).toBeNull();
    expect(fromBase64('')).toBeNull();
    expect(fromBase64('AAA=A')).toBeNull();
    expect(fromBase64('AA AA')).toBeNull();
  });

  it('rejects a long adversarial input quickly (no exponential backtracking)', () => {
    for (const hostile of [
      `${'0'.repeat(100_000)}!`,
      `${'A'.repeat(100_000)}=!`,
      `${'0'.repeat(100_000)}===`,
    ]) {
      const started = performance.now();
      expect(fromBase64(hostile)).toBeNull();
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});
