// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { buildMigrations, renderModule, splitStatements } from '../gen-migrations.ts';

describe('gen-migrations', () => {
  it('splits drizzle-kit statements', () => {
    expect(
      splitStatements(
        'CREATE TABLE a (x int);\n--> statement-breakpoint\nCREATE INDEX i ON a (x);--> statement-breakpoint\n',
      ),
    ).toEqual(['CREATE TABLE a (x int);', 'CREATE INDEX i ON a (x);']);
  });

  it('numbers migrations from the journal and checksums them', () => {
    const files: Record<string, string> = {
      '0000_init': 'A;',
      '0001_more': 'B;--> statement-breakpoint\nC;',
    };
    const m = buildMigrations(
      [
        { idx: 1, tag: '0001_more' },
        { idx: 0, tag: '0000_init' },
      ],
      (tag) => files[tag] as string,
    );
    expect(m.map((x) => [x.version, x.name, x.statements.length])).toEqual([
      [1, '0000_init', 1],
      [2, '0001_more', 2],
    ]);
    expect(m[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(m[0]?.checksum).not.toBe(m[1]?.checksum);
    expect(renderModule(m)).toContain('export const MIGRATIONS');
  });

  it('refuses gaps and empty migrations', () => {
    expect(() => buildMigrations([{ idx: 1, tag: 'x' }], () => 'A;')).toThrow(/contiguous/);
    expect(() => buildMigrations([{ idx: 0, tag: 'x' }], () => '  ')).toThrow(/empty/);
  });
});
