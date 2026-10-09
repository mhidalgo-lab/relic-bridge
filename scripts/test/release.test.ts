// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  decideMode,
  extractNotes,
  pendingChangesets,
  readVersionConst,
  SEMVER_RE,
  writeVersionConst,
} from '../release.ts';

describe('pendingChangesets / decideMode', () => {
  it('ignores the changeset README and config', () => {
    expect(pendingChangesets(['README.md', 'config.json', 'brave-cats.md'])).toEqual(['brave-cats.md']);
    expect(pendingChangesets(['README.md', 'config.json'])).toEqual([]);
  });

  it('versions first, then publishes only unpublished versions', () => {
    expect(decideMode(2, false)).toBe('version');
    expect(decideMode(1, true)).toBe('version');
    expect(decideMode(0, false)).toBe('publish');
    expect(decideMode(0, true)).toBe('none');
  });
});

describe('extractNotes', () => {
  const changelog = '# relic-bridge\n\n## 0.2.0\n\n- second\n\n## 0.1.0\n\n### Minor Changes\n\n- first\n';

  it('returns the body of one version section', () => {
    expect(extractNotes(changelog, '0.2.0')).toBe('- second');
    expect(extractNotes(changelog, '0.1.0')).toBe('### Minor Changes\n\n- first');
  });

  it('is undefined for a missing or empty section', () => {
    expect(extractNotes(changelog, '9.9.9')).toBeUndefined();
    expect(extractNotes('## 1.0.0\n\n## 0.9.0\n- x\n', '1.0.0')).toBeUndefined();
  });

  it('does not match a version prefix', () => {
    expect(extractNotes('## 0.1.0-beta.1\n- beta\n', '0.1.0')).toBeUndefined();
  });
});

describe('version constant', () => {
  const source = "// x\nexport const VERSION = '0.0.0';\nexport const OTHER = 1;\n";

  it('reads and rewrites only the VERSION constant', () => {
    expect(readVersionConst(source)).toBe('0.0.0');
    const next = writeVersionConst(source, '0.1.0');
    expect(readVersionConst(next)).toBe('0.1.0');
    expect(next).toContain('export const OTHER = 1;');
  });

  it('refuses non-SemVer input (it ends up in tags and workflow outputs)', () => {
    expect(() => writeVersionConst(source, "0.1.0'; evil()")).toThrow(/SemVer/);
    expect(() => writeVersionConst('no constant here', '0.1.0')).toThrow(/VERSION/);
    expect(SEMVER_RE.test('1.2.3-rc.1')).toBe(true);
    expect(SEMVER_RE.test('1.2.3\nmode=publish')).toBe(false);
  });
});
