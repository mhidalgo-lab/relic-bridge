// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../packages/storage/src/migrations.generated.ts';
import {
  buildDump,
  checkAgainstBuild,
  checkRelease,
  type DbFixture,
  fixtureMinors,
  latestPerMinor,
  literal,
  nextReleaseMinor,
  parseGeneratedMigrations,
  parseTags,
  renderIndex,
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

  it('lists fixture files in numeric minor order and imports them all (P8-84)', () => {
    const minors = fixtureMinors([
      'v0.10.json',
      'v0.7.json',
      'README.md',
      'v0.9.json',
      'v1.0.json',
      'x.json',
    ]);
    expect(minors).toEqual(['0.7', '0.9', '0.10', '1.0']);
    const index = renderIndex(minors);
    expect(index).toMatch(/^\/\/ SPDX-License-Identifier: Apache-2.0\n/);
    expect(index).toContain("import v0_10 from './fixtures/db/v0.10.json' with { type: 'json' };");
    expect(index).toContain('export const FIXTURES = [v0_7, v0_9, v0_10, v1_0] as const;');
  });

  it('a version PR adds the fixture of a new stable minor only (P8-84)', () => {
    expect(nextReleaseMinor('0.11.0', ['0.7', '0.10'])).toBe('0.11');
    expect(nextReleaseMinor('1.0.0', ['0.11'])).toBe('1.0');
    expect(nextReleaseMinor('0.11.0', ['0.11'])).toBeUndefined(); // already there
    expect(nextReleaseMinor('0.11.1', ['0.10'])).toBeUndefined(); // patch: its minor already shipped
    expect(nextReleaseMinor('1.0.0-rc.1', [])).toBeUndefined(); // prereleases have no fixture
    expect(nextReleaseMinor('0.6.0', [])).toBeUndefined(); // before the first published minor
  });

  it("a release needs its minor's fixture with exactly this build's migrations (P8-84)", () => {
    const fixture = (migrations: DbFixture['migrations']): DbFixture => ({
      minor: '0.11',
      tag: 'v0.11.0',
      generatedBy: '',
      migrations,
      dump: [],
    });
    const plain = JSON.parse(JSON.stringify(MIGRATIONS)) as DbFixture['migrations'];
    expect(checkRelease('0.11.0', fixture(plain), MIGRATIONS)).toEqual([]);
    expect(checkRelease('0.11.3', fixture(plain), MIGRATIONS)).toEqual([]);
    expect(checkRelease('0.11.0', undefined, MIGRATIONS)).toEqual([
      expect.stringMatching(/v0\.11\.json is missing.*version-packages/),
    ]);
    // A patch (or a version PR merged with a stale fixture) that adds a migration is refused.
    expect(checkRelease('0.11.1', fixture(plain.slice(0, -1)), MIGRATIONS)).toEqual([
      expect.stringMatching(/a patch release must not add migrations/),
    ]);
    expect(checkRelease('1.0.0-rc.1', undefined, MIGRATIONS)).toEqual([]);
    expect(checkRelease('0.6.0', undefined, MIGRATIONS)).toEqual([]);
    expect(checkRelease('nope', undefined, MIGRATIONS)).toEqual([expect.stringMatching(/not a release/)]);
  });
});
