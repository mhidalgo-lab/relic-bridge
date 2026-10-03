// SPDX-License-Identifier: Apache-2.0
// Release helpers (P1-15), used by .github/workflows/release.yml and `pnpm version-packages`.
//
//   node scripts/release.ts plan                 → prints `mode=version|publish|none` and `version=<semver>` lines
//   node scripts/release.ts notes <version>      → prints the CHANGELOG section of <version>
//   node scripts/release.ts sync-version [--check] → writes (or checks) VERSION in packages/core/src/version.ts
//
// Only the `relic-bridge` CLI package (apps/cli) is ever published.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = 'relic-bridge';
export const CLI_DIR = 'apps/cli';
export const VERSION_FILE = 'packages/core/src/version.ts';

/** Strict SemVer (no build metadata), so the value is safe to put into workflow outputs and tag names. */
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export type ReleaseMode = 'version' | 'publish' | 'none';

/** Changeset files waiting to be versioned (everything in `.changeset/` except its README and config). */
export function pendingChangesets(files: readonly string[]): string[] {
  return files.filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md');
}

/** Pending changesets → open the version PR; otherwise publish only a version npm doesn't have yet. */
export function decideMode(pending: number, alreadyPublished: boolean): ReleaseMode {
  if (pending > 0) return 'version';
  return alreadyPublished ? 'none' : 'publish';
}

/** The body of the `## <version>` section of a Changesets CHANGELOG, without the heading. */
export function extractNotes(changelog: string, version: string): string | undefined {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return body === '' ? undefined : body;
}

const VERSION_CONST_RE = /export const VERSION = '([^']*)';/;

export function readVersionConst(source: string): string | undefined {
  return VERSION_CONST_RE.exec(source)?.[1];
}

export function writeVersionConst(source: string, version: string): string {
  if (!SEMVER_RE.test(version)) throw new Error(`Not a SemVer version: ${version}`);
  if (!VERSION_CONST_RE.test(source)) throw new Error(`No "export const VERSION = '…';" in ${VERSION_FILE}`);
  return source.replace(VERSION_CONST_RE, `export const VERSION = '${version}';`);
}

export function cliVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(`${root}/${CLI_DIR}/package.json`, 'utf8')) as {
    name: string;
    version: string;
  };
  if (pkg.name !== PACKAGE_NAME) throw new Error(`${CLI_DIR}/package.json is not ${PACKAGE_NAME}`);
  if (!SEMVER_RE.test(pkg.version)) throw new Error(`Not a SemVer version: ${pkg.version}`);
  return pkg.version;
}

/** Whether `name@version` exists on the npm registry. Any error other than "not found" is fatal. */
function isPublished(name: string, version: string): boolean {
  try {
    const out = execFileSync('npm', ['view', `${name}@${version}`, 'version', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim() !== '';
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    const stdout = String((error as { stdout?: unknown }).stdout ?? '');
    if (/E404|404 Not Found/.test(stderr + stdout)) return false;
    throw error;
  }
}

function main(argv: readonly string[]): number {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const [command, arg] = argv;
  switch (command) {
    case 'plan': {
      const version = cliVersion(root);
      const pending = pendingChangesets(readdirSync(`${root}/.changeset`)).length;
      const mode = decideMode(pending, pending > 0 ? false : isPublished(PACKAGE_NAME, version));
      process.stdout.write(`mode=${mode}\nversion=${version}\n`);
      return 0;
    }
    case 'notes': {
      if (arg === undefined || !SEMVER_RE.test(arg)) {
        console.error('usage: release.ts notes <version>');
        return 2;
      }
      const notes = extractNotes(readFileSync(`${root}/${CLI_DIR}/CHANGELOG.md`, 'utf8'), arg);
      if (notes === undefined) {
        console.error(`✗ ${CLI_DIR}/CHANGELOG.md has no "## ${arg}" section`);
        return 1;
      }
      process.stdout.write(`${notes}\n`);
      return 0;
    }
    case 'sync-version': {
      const version = cliVersion(root);
      const file = `${root}/${VERSION_FILE}`;
      const source = readFileSync(file, 'utf8');
      if (arg === '--check') {
        const current = readVersionConst(source);
        if (current !== version) {
          console.error(
            `✗ ${VERSION_FILE} has VERSION '${current}', ${CLI_DIR}/package.json has '${version}'. Run node scripts/release.ts sync-version`,
          );
          return 1;
        }
        return 0;
      }
      writeFileSync(file, writeVersionConst(source, version));
      return 0;
    }
    default:
      console.error('usage: release.ts plan | notes <version> | sync-version [--check]');
      return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
