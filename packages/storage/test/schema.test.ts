// SPDX-License-Identifier: Apache-2.0
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/migrations.generated.ts';
import { tables, toBytes } from '../src/schema.ts';

describe('schema', () => {
  it('has no plaintext secret columns (T7) and stores tokens only as hashes', () => {
    const { kv: _kv, settings: _settings, ...entities } = tables; // `key` there is a name, not a secret
    const columns = Object.values(entities).flatMap((t) => getTableConfig(t).columns.map((c) => c.name));
    for (const name of columns) expect(name).not.toMatch(/(^|_)(api_key|key|token|secret|password)$/);
    const creds = getTableConfig(tables.credentials).columns.map((c) => c.name);
    expect(creds).toEqual(expect.arrayContaining(['key_ciphertext', 'key_iv', 'key_version']));
    const toks = getTableConfig(tables.accessTokens).columns.map((c) => c.name);
    expect(toks).toEqual(expect.arrayContaining(['token_hash', 'prefix']));
  });

  it('keeps the audit log free of foreign keys (rows outlive what they mention)', () => {
    expect(getTableConfig(tables.auditLog).foreignKeys).toHaveLength(0);
  });

  it('embeds contiguous migrations with checksums', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    for (const m of MIGRATIONS) expect(m.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads BLOBs from every driver shape', () => {
    expect([...toBytes(new Uint8Array([1, 2]))]).toEqual([1, 2]);
    expect([...toBytes(new Uint8Array([1, 2]).buffer)]).toEqual([1, 2]);
    expect([...toBytes([3, 4])]).toEqual([3, 4]);
    expect(() => toBytes('x')).toThrow(TypeError);
  });
});
