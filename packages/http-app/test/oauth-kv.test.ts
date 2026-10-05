// SPDX-License-Identifier: Apache-2.0
// The provider's KV namespace over the storage `kv` table (P5-01, ADR-0011): prefix isolation, JSON reads, expiry
// pass-through and paging. The `kv` contract itself is the storage suite's (memory, SQLite, D1).
import { createMemoryStorage } from '@relic-bridge/storage';
import { describe, expect, it } from 'vitest';
import { OAUTH_KV_PREFIX, oauthKvNamespace } from '../src/index.ts';

describe('oauthKvNamespace', () => {
  it('stores every key under oauth: and never sees the table’s other keys', async () => {
    const s = createMemoryStorage();
    const ns = oauthKvNamespace(s.kv);
    await s.kv.put('session:abc', 'secret-session');
    await s.kv.put('grant:x', 'not-a-provider-key');
    await ns.put('grant:u:g', JSON.stringify({ a: 1 }));
    expect(await s.kv.get(`${OAUTH_KV_PREFIX}grant:u:g`)).toBe('{"a":1}');
    expect(await ns.get('grant:u:g', { type: 'json' })).toEqual({ a: 1 });
    expect(await ns.get('grant:u:g')).toBe('{"a":1}');
    expect(await ns.get('session:abc')).toBeNull();
    const listed = await ns.list({ prefix: 'grant:' });
    expect(listed).toEqual({ keys: [{ name: 'grant:u:g' }], list_complete: true });
    expect((await ns.list()).keys.map((k) => k.name)).toEqual(['grant:u:g']);
    await ns.delete('grant:u:g');
    expect(await s.kv.get(`${OAUTH_KV_PREFIX}grant:u:g`)).toBeNull();
    expect(await s.kv.get('grant:x')).toBe('not-a-provider-key');
  });

  it('passes expiry through, drops metadata, and pages with the cursor', async () => {
    let now = 1_000_000;
    const s = createMemoryStorage({ now: () => now });
    const ns = oauthKvNamespace(s.kv);
    await ns.put('token:a', 'x', { expirationTtl: 60, metadata: { clientId: 'c' } });
    await ns.put('token:b', 'y', { expiration: Math.floor(now / 1000) + 120 });
    expect((await ns.list({ prefix: 'token:' })).keys).toEqual([
      { name: 'token:a', expiration: 1060 },
      { name: 'token:b', expiration: 1120 },
    ]);
    now += 61_000;
    expect(await ns.get('token:a')).toBeNull();
    expect(await ns.get('token:b')).toBe('y');
    for (let i = 0; i < 5; i++) await ns.put(`client:${i}`, String(i));
    const first = await ns.list({ prefix: 'client:', limit: 2 });
    expect(first.list_complete).toBe(false);
    const second = await ns.list({ prefix: 'client:', limit: 10, cursor: first.cursor as string });
    expect([...first.keys, ...second.keys].map((k) => k.name)).toEqual(
      [0, 1, 2, 3, 4].map((i) => `client:${i}`),
    );
    expect(second.list_complete).toBe(true);
  });

  it('refuses what Workers KV would refuse instead of storing something else', async () => {
    const ns = oauthKvNamespace(createMemoryStorage().kv);
    await expect(ns.put('', 'x')).rejects.toThrow(TypeError);
    await expect(ns.put('k', 1 as unknown as string)).rejects.toThrow(TypeError);
    await ns.put('k', 'v');
    await expect(ns.get('k', { type: 'arrayBuffer' as 'text' })).rejects.toThrow(TypeError);
  });
});
