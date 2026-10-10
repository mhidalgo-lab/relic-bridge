// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createMemoryStorage, decodeCursor, encodeCursor, kvExpiry } from '../src/memory.ts';
import { fakeEncryptedKey, runStorageContract } from '../src/testing.ts';

runStorageContract({ name: 'memory', create: async (clock) => createMemoryStorage({ now: clock.now }) });

describe('memory adapter', () => {
  it('keeps state per instance (no module-level state, T21)', async () => {
    const a = createMemoryStorage();
    const b = createMemoryStorage();
    await a.settings.set('k', 1);
    expect(await b.settings.get('k')).toBeUndefined();
  });

  it('copies records in and out', async () => {
    const s = createMemoryStorage();
    const ids = [1, 2];
    await s.credentials.create({ id: 'c', label: 'x', region: 'US', key: fakeEncryptedKey() });
    await s.projects.create({ id: 'p', slug: 'p', defaultAccountId: 1, allowedAccountIds: ids });
    ids.push(3);
    expect((await s.projects.get('p'))?.allowedAccountIds).toEqual([1, 2]);
  });

  it('round-trips list cursors and computes KV expiry', () => {
    for (const k of ['', 'grant:1', 'ünïcödé/+=', 'a'.repeat(300)])
      expect(decodeCursor(encodeCursor(k))).toBe(k);
    expect(decodeCursor('%%%')).toBe('');
    expect(kvExpiry({}, 1000)).toBeNull();
    expect(kvExpiry({ expirationTtl: 60 }, 1000)).toBe(61_000);
    expect(kvExpiry({ expiration: 5, expirationTtl: 60 }, 1000)).toBe(5000);
  });
});
