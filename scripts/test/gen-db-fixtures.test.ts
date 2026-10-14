// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../packages/storage/src/migrations.generated.ts';
import {
  buildDump,
  checkAgainstBuild,
  type DbFixture,
  latestPerMinor,
  literal,
  parseGeneratedMigrations,
  parseTags,
} from '../gen-db-fixtures.ts';

describe('gen-db-fixtures', () => {
  it('reads published tags from 0.7 on, newest patch per minor', () => {
    const releases = parseTags([
      'v0.1.0',
      'v0.9.1',
      'v0.7.0',
      'v0.10.0-rc.1',
      'v0.9.0',
      'v0.8.0',
      'v0.10.0',
      'x',
    ]);
    expect(releases.map((r) => r.tag)).toEqual(['v0.7.0', 'v0.8.0', 'v0.9.0', 'v0.9.1', 'v0.10.0']);
    expect(latestPerMinor(releases).map((r) => r.tag)).toEqual(['v0.7.0', 'v0.8.0', 'v0.9.1', 'v0.10.0']);
  });

  it('parses the embedded migrations of a generated module', () => {
    const source = readFileSync(
      new URL('../../packages/storage/src/migrations.generated.ts', import.meta.url),
      'utf8',
    );
    expect(parseGeneratedMigrations(source)).toEqual(JSON.parse(JSON.stringify(MIGRATIONS)));
    expect(() => parseGeneratedMigrations('export const x = 1;')).toThrow(/not a migrations/);
  });

  it('writes SQL literals', () => {
    expect([null, 7, "it's", Uint8Array.of(0, 255)].map(literal)).toEqual([
      'NULL',
      '7',
      "'it''s'",
      "X'00ff'",
    ]);
    expect(() => literal(true)).toThrow(/unsupported/);
  });

  it('dumps a loadable, deterministic database', async () => {
    const a = await buildDump(MIGRATIONS);
    expect(await buildDump(MIGRATIONS)).toEqual(a);
    expect(a.findIndex((s) => s.startsWith('INSERT'))).toBeGreaterThan(
      a.findLastIndex((s) => s.startsWith('CREATE')),
    );
    const parents = a.findIndex((s) => s.startsWith('INSERT INTO `grants`'));
    expect(a.findIndex((s) => s.startsWith('INSERT INTO `projects`'))).toBeLessThan(parents);
    expect(a.findIndex((s) => s.startsWith('INSERT INTO `access_tokens`'))).toBeGreaterThan(parents);
  });

  it('flags a shipped migration that this build changed or dropped', () => {
    const fixture: DbFixture = {
      minor: '0.7',
      tag: 'v0.7.0',
      generatedBy: '',
      migrations: MIGRATIONS,
      dump: [],
    };
    expect(checkAgainstBuild(fixture, MIGRATIONS)).toEqual([]);
    const edited = MIGRATIONS.map((m, i) => (i === 1 ? { ...m, checksum: '0'.repeat(64) } : m));
    expect(checkAgainstBuild(fixture, edited)).toEqual([
      expect.stringMatching(/0001_audit_auth_kind .* changed/),
    ]);
    expect(checkAgainstBuild(fixture, MIGRATIONS.slice(0, 2))).toHaveLength(MIGRATIONS.length - 2);
  });
});
