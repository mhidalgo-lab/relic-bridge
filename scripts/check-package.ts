// SPDX-License-Identifier: Apache-2.0
// P1-15: verify the publishable `relic-bridge` tarball (THREAT_MODEL T18). Run after `pnpm build`.
//
//   node scripts/check-package.ts [--out <dir>] [--skip-install]
//
// Packs apps/cli with `pnpm pack` (the same tarball the release job publishes), then checks the file list, the
// manifest, LICENSE/NOTICE, the bin, secret-shaped strings and local paths, the version, and finally installs the
// tarball into a temporary prefix and runs it (`--version`, and test hooks must be refused).
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_DIR, PACKAGE_NAME, readVersionConst, VERSION_FILE } from './release.ts';

/** Exactly these files ship. Anything else (tests, sources, maps, configs) fails the check. */
export const EXPECTED_FILES: readonly string[] = [
  'LICENSE',
  'NOTICE',
  'README.md',
  'dist/index.mjs',
  'package.json',
];

export const BIN_PATH = 'dist/index.mjs';

/** Secret-shaped strings that must never be in a published file (same families as core `redact()`, plus CI tokens). */
export const SECRET_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['New Relic key', /\b(?:NRAK|NRAA|NRII|NRIK|NRIQ|NRJS|NRBR|NRSP)-[A-Za-z0-9_-]{16,}/],
  ['relic-bridge token', /\brb_[A-Za-z0-9_]{16,}/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  // P8-07. New Relic license (ingest) key: 40 hex characters + `NRAL`.
  ['New Relic license key', /\b[A-Fa-f0-9]{40}NRAL\b/],
  // A master key assigned a value (`RB_MASTER_KEY=<32 random bytes, base64>`, optionally `v<N>:`-prefixed). The bundle
  // legitimately mentions the variable name, never a value.
  ['master key', /\bRB_MASTER_KEY(?:_PREVIOUS)?["']?\s*[=:]\s*["']?(?:v\d+:)?[A-Za-z0-9+/]{43}=/],
  ['AWS access key id', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/],
  ['AWS secret access key', /\baws_secret_access_key["']?\s*[=:]\s*["']?[A-Za-z0-9+/]{40}\b/i],
  // Cloudflare: the newer prefixed tokens, and the classic 40-character API token / 37-hex global key when assigned.
  ['Cloudflare token', /\bcf(?:ut|at|k)_[A-Za-z0-9]{40,}/],
  ['Cloudflare token', /\bCLOUDFLARE_API_TOKEN["']?\s*[=:]\s*["']?[A-Za-z0-9_-]{40}\b/],
  ['Cloudflare global API key', /\b(?:CLOUDFLARE_API_KEY|X-Auth-Key)["']?\s*[=:]\s*["']?[a-f0-9]{37}\b/i],
];

/** Absolute paths of the build machine leaking into the bundle. */
const LOCAL_PATH_RE =
  /(?:\/home\/[a-z_][\w-]*\/|\/Users\/[\w.-]+\/|(?<![\w.])\/root\/|[A-Z]:\\{1,2}Users\\{1,2}[\w.-]+\\)/;

export function checkFileList(files: readonly string[]): string[] {
  const actual = [...files].sort();
  const errors: string[] = [];
  for (const f of actual) if (!EXPECTED_FILES.includes(f)) errors.push(`unexpected file in tarball: ${f}`);
  for (const f of EXPECTED_FILES) if (!actual.includes(f)) errors.push(`missing file in tarball: ${f}`);
  return errors;
}

interface Manifest {
  name?: unknown;
  version?: unknown;
  license?: unknown;
  private?: unknown;
  bin?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  main?: unknown;
  module?: unknown;
  types?: unknown;
  exports?: unknown;
  publishConfig?: Record<string, unknown>;
  bundledDependencies?: unknown;
  bundleDependencies?: unknown;
}

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];

/** A pinned registry version (`1.2.3`, `1.2.3-rc.1`): no range, tag, `x`, `latest` or URL. */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Every file path an entry point (`main`, `exports`...) refers to, however deeply nested. */
function entryTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(entryTargets);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(entryTargets);
  return [];
}

export function checkManifest(pkg: Manifest): string[] {
  const errors: string[] = [];
  if (pkg.name !== PACKAGE_NAME) errors.push(`name is ${String(pkg.name)}, expected ${PACKAGE_NAME}`);
  if (pkg.license !== 'Apache-2.0') errors.push(`license is ${String(pkg.license)}, expected Apache-2.0`);
  if (pkg.private === true) errors.push('package is private');
  const bin = pkg.bin as Record<string, unknown> | undefined;
  if (bin === undefined || bin[PACKAGE_NAME] !== `./${BIN_PATH}` || Object.keys(bin).length !== 1) {
    errors.push(`bin must be exactly { "${PACKAGE_NAME}": "./${BIN_PATH}" }`);
  }
  for (const s of INSTALL_SCRIPTS) {
    if (pkg.scripts?.[s] !== undefined) errors.push(`install-time script "${s}" is not allowed`);
  }
  // Entry points must point at files that ship (the bin-only package has none today; a stray one would not resolve).
  for (const field of ['main', 'module', 'types', 'exports'] as const) {
    for (const target of entryTargets(pkg[field])) {
      const file = target.replace(/^\.\//, '');
      if (!EXPECTED_FILES.includes(file))
        errors.push(`${field} points at a file that is not shipped: ${target}`);
    }
  }
  if (pkg.publishConfig?.['access'] !== 'public') errors.push('publishConfig.access must be "public"');
  if (pkg.publishConfig?.['provenance'] !== true) errors.push('publishConfig.provenance must be true');
  for (const field of ['bundledDependencies', 'bundleDependencies'] as const) {
    if (pkg[field] !== undefined) errors.push(`${field} is not allowed: dependencies come from the registry`);
  }
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
      if (typeof range !== 'string' || /^(?:workspace|link|file|git|github|https?):/.test(range)) {
        errors.push(`${field}.${dep} has a non-registry range: ${String(range)}`);
      } else if (field !== 'peerDependencies' && !EXACT_VERSION_RE.test(range)) {
        // Peer ranges are ranges by design; everything we install for the user is pinned (as in the lockfile).
        errors.push(`${field}.${dep} is not an exact version: ${range}`);
      }
      if (dep.startsWith('@relic-bridge/'))
        errors.push(`${field}.${dep}: internal packages are bundled, not published`);
    }
  }
  return errors;
}

export function scanContent(file: string, text: string): string[] {
  const errors: string[] = [];
  for (const [label, re] of SECRET_PATTERNS) {
    if (re.test(text)) errors.push(`${file}: contains a ${label}-shaped string`);
  }
  if (LOCAL_PATH_RE.test(text)) errors.push(`${file}: contains an absolute local path`);
  return errors;
}

export function checkBin(text: string, mode: number): string[] {
  const errors: string[] = [];
  if (!text.startsWith('#!/usr/bin/env node\n'))
    errors.push(`${BIN_PATH}: missing "#!/usr/bin/env node" shebang`);
  if ((mode & 0o111) === 0) errors.push(`${BIN_PATH}: not executable`);
  return errors;
}

function run(cmd: string, args: readonly string[], cwd: string): string {
  return execFileSync(cmd, [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function main(argv: readonly string[]): number {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const outIndex = argv.indexOf('--out');
  const out = outIndex === -1 ? undefined : argv[outIndex + 1];
  const skipInstall = argv.includes('--skip-install');
  const work = mkdtempSync(join(tmpdir(), 'rb-pack-'));
  const errors: string[] = [];
  try {
    const packed = JSON.parse(
      run('pnpm', ['pack', '--pack-destination', work, '--json'], join(root, CLI_DIR)),
    ) as {
      filename: string;
      version: string;
    };
    const tarball = packed.filename;
    const extracted = join(work, 'x');
    mkdirSync(extracted);
    run('tar', ['-xzf', tarball, '-C', extracted], root);
    const files = run('tar', ['-tzf', tarball], root)
      .split('\n')
      .filter((l) => l !== '' && !l.endsWith('/'))
      .map((l) => l.replace(/^package\//, ''));
    errors.push(...checkFileList(files));

    const pkgDir = join(extracted, 'package');
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as Manifest;
    errors.push(...checkManifest(manifest));

    for (const f of ['LICENSE', 'NOTICE']) {
      if (
        files.includes(f) &&
        readFileSync(join(pkgDir, f), 'utf8') !== readFileSync(join(root, f), 'utf8')
      ) {
        errors.push(`${f} differs from the repository root ${f}`);
      }
    }
    for (const f of files) errors.push(...scanContent(f, readFileSync(join(pkgDir, f), 'utf8')));
    if (files.includes(BIN_PATH)) {
      errors.push(
        ...checkBin(readFileSync(join(pkgDir, BIN_PATH), 'utf8'), statSync(join(pkgDir, BIN_PATH)).mode),
      );
    }

    const coreVersion = readVersionConst(readFileSync(join(root, VERSION_FILE), 'utf8'));
    if (manifest.version !== coreVersion) {
      errors.push(
        `package version ${String(manifest.version)} != VERSION ${String(coreVersion)} in ${VERSION_FILE}`,
      );
    }

    if (!skipInstall && errors.length === 0) {
      // `npx relic-bridge`-style smoke test: install the tarball (no install scripts) and run the bin.
      const prefix = join(work, 'install');
      mkdirSync(prefix);
      run(
        'npm',
        ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball],
        root,
      );
      const bin = join(prefix, 'node_modules', '.bin', PACKAGE_NAME);
      const version = run(bin, ['--version'], prefix).trim();
      if (version !== manifest.version) errors.push(`installed bin --version printed "${version}"`);
      const hooks = spawnSync(bin, [], {
        cwd: prefix,
        encoding: 'utf8',
        input: '',
        env: {
          PATH: process.env['PATH'] ?? '',
          // Dummy, never sent anywhere: the process must exit before it builds a NerdGraph client.
          NEW_RELIC_API_KEY: `NRAK-${'X'.repeat(27)}`,
          NEW_RELIC_ACCOUNT_ID: '1',
          RB_TEST_NERDGRAPH_URL: 'http://127.0.0.1:9/graphql',
        },
        timeout: 20_000,
      });
      if (hooks.status !== 1 || !hooks.stderr.includes('does not allow test hooks')) {
        errors.push('packed build did not refuse RB_TEST_NERDGRAPH_URL: test hooks may be compiled in');
      }
    }

    if (errors.length === 0 && out !== undefined) {
      mkdirSync(out, { recursive: true });
      copyFileSync(tarball, join(out, `${PACKAGE_NAME}-${packed.version}.tgz`));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  for (const e of errors) console.error(`✗ ${e}`);
  if (errors.length === 0)
    console.error(`✓ ${PACKAGE_NAME} tarball OK${skipInstall ? ' (install skipped)' : ''}`);
  return errors.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
