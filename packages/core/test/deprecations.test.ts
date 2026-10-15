// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  DEPRECATED_CONFIG,
  type DeprecatedConfig,
  deprecatedConfigInUse,
  deprecatedConfigWarnings,
  deprecationRegistryProblems,
  describeDeprecatedConfig,
  parseVersion,
  VERSION,
} from '../src/index.ts';

const entry = (over: Partial<DeprecatedConfig> = {}): DeprecatedConfig => ({
  name: 'RB_OLD_THING',
  kind: 'env',
  replacement: 'RB_NEW_THING',
  deprecatedIn: '0.1.0',
  removedIn: '999.0.0',
  docs: 'docs/guide/versioning.md',
  ...over,
});

describe('deprecated-config registry', () => {
  it('the shipped registry is sound for this version', () => {
    expect(deprecationRegistryProblems(DEPRECATED_CONFIG)).toEqual([]);
  });

  it('accepts a well-formed entry', () => {
    expect(deprecationRegistryProblems([entry()], '0.10.0')).toEqual([]);
  });

  it('refuses an entry whose removal version is at or below the current version', () => {
    expect(deprecationRegistryProblems([entry({ removedIn: '0.10.0' })], '0.10.0').join()).toContain(
      'at or below the current version',
    );
    expect(deprecationRegistryProblems([entry({ removedIn: '0.9.5' })], '0.10.0').join()).toContain(
      'at or below the current version',
    );
    expect(deprecationRegistryProblems([entry({ removedIn: '0.11.0' })], '0.10.0')).toEqual([]);
  });

  it('refuses missing replacement text, bad versions, bad docs, duplicates and dashed flags', () => {
    const problems = (e: DeprecatedConfig[]) => deprecationRegistryProblems(e, '0.10.0').join('\n');
    expect(problems([entry({ replacement: '  ' })])).toContain('no replacement text');
    expect(problems([entry({ removedIn: 'next' })])).toContain('x.y.z');
    expect(problems([entry({ deprecatedIn: '0.12.0', removedIn: '0.12.0' })])).toContain(
      'not after deprecatedIn',
    );
    expect(problems([entry({ deprecatedIn: '0.12.0', removedIn: '0.14.0' })])).toContain(
      'after the current version',
    );
    expect(problems([entry({ docs: 'http://example.com' })])).toContain('docs must be');
    expect(problems([entry(), entry()])).toContain('listed twice');
    expect(problems([entry({ kind: 'flag', name: '--old' })])).toContain('without dashes');
    expect(problems([entry({ name: ' RB_X' })])).toContain('padded');
  });

  it('compares versions numerically', () => {
    expect(parseVersion('0.10.0')).toEqual([0, 10, 0]);
    expect(parseVersion('1.2.3-rc.1')).toEqual([1, 2, 3]);
    expect(parseVersion('1.2')).toBeNull();
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.10.0', '0.10.0')).toBe(0);
    expect(() => compareVersions('x', '0.1.0')).toThrow();
    expect(parseVersion(VERSION)).not.toBeNull();
  });
});

describe('deprecatedConfigInUse', () => {
  const registry: DeprecatedConfig[] = [
    entry(),
    entry({ name: 'projects.*.oldKey', kind: 'yaml', replacement: 'newKey' }),
    entry({ name: 'old-flag', kind: 'flag', replacement: '--new-flag' }),
  ];

  it('finds environment variables set to a non-blank value', () => {
    expect(deprecatedConfigInUse({ env: { RB_OLD_THING: 'x' } }, registry)).toEqual([registry[0]]);
    expect(deprecatedConfigInUse({ env: { RB_OLD_THING: 30 } }, registry)).toEqual([registry[0]]);
    expect(deprecatedConfigInUse({ env: { RB_OLD_THING: '  ' } }, registry)).toEqual([]);
    expect(deprecatedConfigInUse({ env: { RB_OLD_THING: undefined } }, registry)).toEqual([]);
    expect(deprecatedConfigInUse({ env: {} }, registry)).toEqual([]);
  });

  it('finds YAML keys by dotted path with wildcards', () => {
    expect(deprecatedConfigInUse({ yaml: { projects: { a: { oldKey: 1 } } } }, registry)).toEqual([
      registry[1],
    ]);
    expect(deprecatedConfigInUse({ yaml: { projects: [{ a: 1 }, { oldKey: 1 }] } }, registry)).toEqual([
      registry[1],
    ]);
    expect(deprecatedConfigInUse({ yaml: { projects: { a: { newKey: 1 } } } }, registry)).toEqual([]);
    expect(deprecatedConfigInUse({ yaml: { projects: ['oldKey'] } }, registry)).toEqual([]);
    expect(deprecatedConfigInUse({ yaml: { oldKey: 1 } }, registry)).toEqual([]);
    expect(deprecatedConfigInUse({ yaml: null }, registry)).toEqual([]);
  });

  it('finds flags in argv, before a `--` separator only', () => {
    expect(deprecatedConfigInUse({ argv: ['serve', '--old-flag'] }, registry)).toEqual([registry[2]]);
    expect(deprecatedConfigInUse({ argv: ['serve', '--old-flag=1'] }, registry)).toEqual([registry[2]]);
    expect(deprecatedConfigInUse({ argv: ['serve', '--old-flagged'] }, registry)).toEqual([]);
    expect(deprecatedConfigInUse({ argv: ['--', '--old-flag'] }, registry)).toEqual([]);
  });

  it('warns with the name and replacement, never the value', () => {
    const secret = 'NRAK-SECRETVALUE1234567890ABCDEFG';
    const lines = deprecatedConfigWarnings({ env: { RB_OLD_THING: secret } }, registry);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('RB_OLD_THING');
    expect(lines[0]).toContain('RB_NEW_THING');
    expect(lines[0]).toContain('999.0.0');
    expect(lines[0]).not.toContain(secret);
    expect(describeDeprecatedConfig(registry[2] as DeprecatedConfig)).toContain('Flag --old-flag');
  });
});
