// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { AccessCache, type CachedAccess } from '../src/access-cache.ts';

const entry = (tokenId: string): Omit<CachedAccess, 'expiresAt'> =>
  ({ tokenId, access: {}, credential: {} }) as unknown as Omit<CachedAccess, 'expiresAt'>;

describe('AccessCache', () => {
  it('expires entries at the TTL, or earlier at the token/grant expiry', () => {
    const c = new AccessCache(30_000);
    c.set('a', entry('a'), 0, [null, null]);
    c.set('b', entry('b'), 0, [10_000, null]);
    c.set('c', entry('c'), 0, [null, 20_000]);
    expect(c.get('a', 29_999)?.tokenId).toBe('a');
    expect(c.get('a', 30_000)).toBeUndefined();
    expect(c.get('b', 9_999)?.tokenId).toBe('b');
    expect(c.get('b', 10_000)).toBeUndefined();
    expect(c.get('c', 20_000)).toBeUndefined();
  });

  it('stores nothing with TTL 0 or for an already-expired limit', () => {
    const off = new AccessCache(0);
    off.set('a', entry('a'), 0, []);
    expect(off.get('a', 0)).toBeUndefined();
    expect(off.enabled).toBe(false);
    const on = new AccessCache(1000);
    on.set('a', entry('a'), 5, [5]);
    expect(on.size).toBe(0);
  });

  it('is bounded: the oldest entry goes first', () => {
    const c = new AccessCache(1000, 2);
    c.set('a', entry('a'), 0, []);
    c.set('b', entry('b'), 0, []);
    c.set('c', entry('c'), 0, []);
    expect(c.size).toBe(2);
    expect(c.get('a', 1)).toBeUndefined();
    expect(c.get('c', 1)?.tokenId).toBe('c');
  });

  it('refuses TTLs above 60 s and bad sizes', () => {
    expect(() => new AccessCache(60_001)).toThrow(RangeError);
    expect(() => new AccessCache(1.5)).toThrow(RangeError);
    expect(() => new AccessCache(1000, 0)).toThrow(RangeError);
  });
});
