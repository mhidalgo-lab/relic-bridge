// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { REDACTED, Secret } from '../src/index.ts';

describe('Secret', () => {
  const s = new Secret('NRAK-ABCDEFGHIJKLMNOPQRSTUVWXYZ0');

  it('only reveals through reveal()', () => {
    expect(s.reveal()).toBe('NRAK-ABCDEFGHIJKLMNOPQRSTUVWXYZ0');
    expect(String(s)).toBe(REDACTED);
    expect(`${s}`).toBe(REDACTED);
    expect(JSON.stringify({ s })).toBe(`{"s":"${REDACTED}"}`);
    expect(Object.keys(s)).toEqual([]);
  });

  it('is redacted by util.inspect', () => {
    const inspect = (s as unknown as Record<symbol, () => string>)[Symbol.for('nodejs.util.inspect.custom')];
    expect(inspect?.()).toBe(REDACTED);
  });
});
