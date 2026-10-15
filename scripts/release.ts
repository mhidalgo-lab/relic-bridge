// SPDX-License-Identifier: Apache-2.0
// Release helpers (P1-15), used by .github/workflows/release.yml and `pnpm version-packages`.
//
//   node scripts/release.ts plan                 → prints `mode=version|publish|release|none` and `version=<semver>`
//                                                  lines (needs GITHUB_REPOSITORY, GITHUB_SHA and a GH_TOKEN that can
//                                                  read the repository when there are no pending changesets)
//   node scripts/release.ts notes <version>      → prints the CHANGELOG section of <version>
//   node scripts/release.ts sync-version [--check] → writes (or checks) VERSION in packages/core/src/version.ts and
//                                                  the versions in the MCP Registry metadata (server.json, P7-14)
//   node scripts/release.ts check-changesets     → part of `pnpm lint` (P8-84): every pending changeset names only
//                                                  packages changesets can version (not private, not ignored)
//
// Only the `relic-bridge` CLI package (apps/cli) is ever published.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = 'relic-bridge';
export const CLI_DIR = 'apps/cli';
export const VERSION_FILE = 'packages/core/src/version.ts';
/** MCP Registry metadata (P7-14): its own version and the npm package's must follow the CLI package. */
export const SERVER_JSON = 'server.json';

/** Strict SemVer (no build metadata), so the value is safe to put into workflow outputs and tag names. */
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * - `version`: changesets pending → open/update the version PR.
 * - `publish`: the version is not on npm → build, publish and create the GitHub Release.
 * - `release`: the version is on npm but there is no GitHub Release (an earlier run failed after `npm publish`) →
 *   rebuild, check the tarball is byte-identical to the published one, and create only the GitHub Release.
 * - `none`: nothing to do.
 */
export type ReleaseMode = 'version' | 'publish' | 'release' | 'none';

/** What `plan` knows about the current version. `tagCommit` is the commit `v<version>` points at, if the tag exists. */
export interface ReleaseState {
  pending: number;
  published: boolean;
  released: boolean;
  tagCommit: string | undefined;
  headSha: string;
}

/** Full 40-hex commit SHA (what GITHUB_SHA and the git refs API return). */
export const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
/** `owner/name`, as in GITHUB_REPOSITORY. */
export const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** Changeset files waiting to be versioned (everything in `.changeset/` except its README and config). */
export function pendingChangesets(files: readonly string[]): string[] {
  return files.filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md');
}

/** A pending changeset that changesets cannot consume: it names a private or ignored package, or cannot be read. */
export interface ChangesetProblem {
  file: string;
  message: string;
}

const BUMP_LINE_RE = /^\s*(["']?)([^"':\s]+)\1\s*:\s*(major|minor|patch|none)\s*$/;

/**
 * The packages a changeset's front matter names, or `undefined` when it has no readable front matter. An empty front
 * matter (an "empty changeset") names none.
 */
export function changesetPackages(text: string): string[] | undefined {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return undefined;
  const end = lines.indexOf('---', 1);
  if (end === -1) return undefined;
  const names: string[] = [];
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '') continue;
    const m = BUMP_LINE_RE.exec(line);
    if (m === null) return undefined;
    names.push(m[2] as string);
  }
  return names;
}

/**
 * Splits pending changesets into those `changeset version` consumes and those it would leave behind forever (P8-84):
 * a changeset for a private package (`privatePackages.version: false`) or an ignored one is never versioned, so it
 * stays in `.changeset/` and keeps `plan` in `version` mode.
 */
export function classifyChangesets(
  changesets: readonly { file: string; text: string }[],
  versionable: ReadonlySet<string>,
): { consumable: string[]; problems: ChangesetProblem[] } {
  const consumable: string[] = [];
  const problems: ChangesetProblem[] = [];
  for (const { file, text } of changesets) {
    const names = changesetPackages(text);
    if (names === undefined) {
      problems.push({ file, message: 'has no readable front matter (`"relic-bridge": patch|minor|major`)' });
      continue;
    }
    const bad = names.filter((n) => !versionable.has(n));
    if (bad.length > 0) {
      problems.push({
        file,
        message:
          `names ${bad.map((n) => `"${n}"`).join(', ')}, which changesets never versions (private or ignored); ` +
          `use "${PACKAGE_NAME}" instead: it is the only published package`,
      });
      continue;
    }
    consumable.push(file);
  }
  return { consumable, problems };
}

/** Workspace packages changesets versions: not `private`, not in `.changeset/config.json` `ignore`. */
export function versionablePackages(root: string): Set<string> {
  const config = JSON.parse(readFileSync(`${root}/.changeset/config.json`, 'utf8')) as { ignore?: string[] };
  const ignored = new Set(config.ignore ?? []);
  const dirs = [
    ...['packages', 'apps'].flatMap((parent) =>
      readdirSync(`${root}/${parent}`).map((d) => `${root}/${parent}/${d}`),
    ),
    `${root}/site`,
  ];
  const out = new Set<string>();
  for (const dir of dirs) {
    const file = `${dir}/package.json`;
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; private?: boolean };
    if (typeof pkg.name === 'string' && pkg.private !== true && !ignored.has(pkg.name)) out.add(pkg.name);
  }
  return out;
}

/**
 * What `plan` says about pending changesets (P8-84, #252): a changeset `changeset version` never consumes would keep the
 * plan in `version` mode forever and silently skip every publish. Each one is a warning; when none of the pending
 * changesets can be consumed, it is an error (the version PR would change nothing and nothing would ever publish).
 */
export function changesetReport(
  changesets: readonly { file: string; text: string }[],
  versionable: ReadonlySet<string>,
): { warnings: string[]; error?: string } {
  const { consumable, problems } = classifyChangesets(changesets, versionable);
  const warnings = problems.map((p) => `.changeset/${p.file} ${p.message}`);
  if (changesets.length > 0 && consumable.length === 0) {
    return {
      warnings,
      error:
        `${changesets.length} pending changeset(s) and none can be consumed by \`changeset version\`; ` +
        'fix or delete them, otherwise nothing is ever published',
    };
  }
  return { warnings };
}

function readChangesets(root: string): { file: string; text: string }[] {
  return pendingChangesets(readdirSync(`${root}/.changeset`)).map((file) => ({
    file,
    text: readFileSync(`${root}/.changeset/${file}`, 'utf8'),
  }));
}

/** Pending changesets → open the version PR; otherwise publish only a version npm doesn't have yet. */
export function decideMode(pending: number, alreadyPublished: boolean): ReleaseMode {
  if (pending > 0) return 'version';
  return alreadyPublished ? 'none' : 'publish';
}

/**
 * The release mode, including the idempotent `release` mode for reruns. Throws when releasing would be unsafe:
 * the tag `v<version>` already exists on a commit other than the one being built, or a GitHub Release exists for a
 * version npm doesn't have (out-of-order state that needs a human).
 */
export function decidePlan(state: ReleaseState): ReleaseMode {
  if (state.pending > 0) return 'version';
  if (state.published && state.released) return 'none';
  if (!state.published && state.released) {
    throw new Error(
      'A GitHub Release exists for a version that is not on npm; fix it by hand before releasing',
    );
  }
  if (state.tagCommit !== undefined && state.tagCommit !== state.headSha) {
    throw new Error(
      `Tag already exists on commit ${state.tagCommit}, not on ${state.headSha}; refusing to release from another commit`,
    );
  }
  return state.published ? 'release' : 'publish';
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

interface ServerJson {
  version?: unknown;
  packages?: { registryType?: unknown; identifier?: unknown; version?: unknown }[];
}

/** The versions in `server.json` that must equal the CLI version: the server's and its npm package's. */
export function serverJsonVersions(text: string): unknown[] {
  const doc = JSON.parse(text) as ServerJson;
  const npm = (doc.packages ?? []).filter((p) => p.registryType === 'npm' && p.identifier === PACKAGE_NAME);
  return [doc.version, ...npm.map((p) => p.version)];
}

/**
 * `server.json` with the server's and the npm package's versions set to `version`. Only those `"version": "…"` values
 * are rewritten in place, so the file keeps its formatting.
 */
export function writeServerJsonVersion(text: string, version: string): string {
  if (!SEMVER_RE.test(version)) throw new Error(`Not a SemVer version: ${version}`);
  let out = text;
  for (const old of new Set(serverJsonVersions(text))) {
    if (typeof old !== 'string' || old === version) continue;
    out = out.replaceAll(`"version": ${JSON.stringify(old)}`, `"version": ${JSON.stringify(version)}`);
  }
  const after = serverJsonVersions(out);
  if (after.length < 2 || after.some((v) => v !== version)) {
    throw new Error(`${SERVER_JSON}: could not set the server and npm package versions to ${version}`);
  }
  return out;
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

/** `gh api <path>` as JSON, or `undefined` on HTTP 404. Any other error is fatal. */
function ghApi(path: string): unknown {
  try {
    const out = execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github+json', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out) as unknown;
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    if (/HTTP 404/.test(stderr)) return undefined;
    throw error;
  }
}

interface GitObject {
  object?: { sha?: unknown; type?: unknown };
}

/**
 * The commit a tag points at, following annotated tags. `fetchJson` is `ghApi` (injected for tests).
 * Returns `undefined` when the tag does not exist.
 */
export function resolveTagCommit(
  repo: string,
  tag: string,
  fetchJson: (path: string) => unknown,
): string | undefined {
  let ref = fetchJson(`repos/${repo}/git/ref/tags/${tag}`) as GitObject | undefined;
  for (let depth = 0; depth < 5; depth++) {
    if (ref === undefined) return depth === 0 ? undefined : fail(`dangling annotated tag ${tag}`);
    const { sha, type } = ref.object ?? {};
    if (typeof sha !== 'string' || !COMMIT_SHA_RE.test(sha)) return fail(`unexpected ref data for ${tag}`);
    if (type === 'commit') return sha;
    if (type !== 'tag') return fail(`tag ${tag} points at a ${String(type)}, not a commit`);
    ref = fetchJson(`repos/${repo}/git/tags/${sha}`) as GitObject | undefined;
  }
  return fail(`tag ${tag} is nested too deeply`);
}

function fail(message: string): never {
  throw new Error(message);
}

function requireEnv(name: string, re: RegExp): string {
  const value = process.env[name];
  if (value === undefined || !re.test(value)) throw new Error(`${name} is missing or malformed`);
  return value;
}

function main(argv: readonly string[]): number {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const [command, arg] = argv;
  switch (command) {
    case 'plan': {
      const version = cliVersion(root);
      const changesets = readChangesets(root);
      const pending = changesets.length;
      const report = changesetReport(changesets, versionablePackages(root));
      for (const w of report.warnings) console.error(`::warning::${w}`);
      if (report.error !== undefined) {
        console.error(`✗ release plan: ${report.error}`);
        return 1;
      }
      let mode: ReleaseMode = 'version';
      if (pending === 0) {
        const tag = `v${version}`;
        try {
          const repo = requireEnv('GITHUB_REPOSITORY', REPO_RE);
          const headSha = requireEnv('GITHUB_SHA', COMMIT_SHA_RE);
          mode = decidePlan({
            pending,
            published: isPublished(PACKAGE_NAME, version),
            released: ghApi(`repos/${repo}/releases/tags/${tag}`) !== undefined,
            tagCommit: resolveTagCommit(repo, tag, ghApi),
            headSha,
          });
        } catch (error) {
          console.error(`✗ release plan for ${tag}: ${(error as Error).message}`);
          return 1;
        }
      }
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
      const serverFile = `${root}/${SERVER_JSON}`;
      const serverText = readFileSync(serverFile, 'utf8');
      if (arg === '--check') {
        const current = readVersionConst(source);
        if (current !== version) {
          console.error(
            `✗ ${VERSION_FILE} has VERSION '${current}', ${CLI_DIR}/package.json has '${version}'. Run node scripts/release.ts sync-version`,
          );
          return 1;
        }
        const listed = serverJsonVersions(serverText);
        if (listed.length < 2 || listed.some((v) => v !== version)) {
          console.error(
            `✗ ${SERVER_JSON} versions ${JSON.stringify(listed)} differ from ${CLI_DIR}/package.json '${version}'. Run node scripts/release.ts sync-version`,
          );
          return 1;
        }
        return 0;
      }
      writeFileSync(file, writeVersionConst(source, version));
      writeFileSync(serverFile, writeServerJsonVersion(serverText, version));
      return 0;
    }
    case 'check-changesets': {
      const { problems } = classifyChangesets(readChangesets(root), versionablePackages(root));
      for (const p of problems) console.error(`✗ .changeset/${p.file} ${p.message}`);
      return problems.length === 0 ? 0 : 1;
    }
    default:
      console.error('usage: release.ts plan | notes <version> | sync-version [--check] | check-changesets');
      return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
