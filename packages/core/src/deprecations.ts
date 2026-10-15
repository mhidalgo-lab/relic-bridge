// SPDX-License-Identifier: Apache-2.0
// Deprecated configuration names (P8-67). One list for the CLI (`serve`, stdio, `doctor`) and the Worker, so a renamed
// or retired environment variable, YAML key or CLI flag is announced the same way everywhere for its whole
// deprecation window (docs/guide/versioning.md). Only names are ever reported, never values: a deprecated variable may
// hold a secret (THREAT_MODEL T28). Web-standard only (ADR-0004).
import { VERSION } from './version.ts';

/** `env`: environment variable or Worker var/secret. `yaml`: key in a `--config` file. `flag`: CLI option. */
export type DeprecatedConfigKind = 'env' | 'yaml' | 'flag';

export interface DeprecatedConfig {
  /**
   * `env`: the variable (`RB_OLD`). `yaml`: a dotted path in the config file, `*` matching any one key or list
   * item (`projects.*.oldKey`). `flag`: the option without dashes (`old-flag`).
   */
  readonly name: string;
  readonly kind: DeprecatedConfigKind;
  /** What to use instead, as an operator would type it (`RB_NEW`, or "nothing: the default now does this"). */
  readonly replacement: string;
  /** Release that deprecated it (`0.11.0`). */
  readonly deprecatedIn: string;
  /** Release that removes it; later than the current version, or the entry should have gone with the name. */
  readonly removedIn: string;
  /** Where the change is explained (a docs path or an https URL). */
  readonly docs: string;
}

/**
 * The registry. Empty while nothing in configuration is deprecated; add an entry in the release that deprecates a
 * name and delete it in the release that removes the name (a test fails once `removedIn` is reached).
 */
export const DEPRECATED_CONFIG: readonly DeprecatedConfig[] = [];

/** Major, minor, patch of a `x.y.z` version (pre-release and build suffixes ignored); null when it is not one. */
export function parseVersion(version: string): readonly [number, number, number] | null {
  const m = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+].*)?$/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative, zero or positive as `a` is older than, equal to or newer than `b`. Both must parse. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (x === null || y === null) throw new Error(`not a version: ${x === null ? a : b}`);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** Problems with the registry's entries (empty when it is sound). Used by the unit test and nothing else. */
export function deprecationRegistryProblems(
  registry: readonly DeprecatedConfig[],
  currentVersion: string = VERSION,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of registry) {
    const id = `${e.kind}:${e.name}`;
    if (seen.has(id)) problems.push(`${id}: listed twice`);
    seen.add(id);
    if (e.name.trim() === '' || e.name !== e.name.trim()) problems.push(`${id}: name is empty or padded`);
    if (e.kind === 'flag' && e.name.startsWith('-')) problems.push(`${id}: write the flag without dashes`);
    if (e.replacement.trim() === '') problems.push(`${id}: no replacement text`);
    if (!/^(https:\/\/|docs\/)/.test(e.docs))
      problems.push(`${id}: docs must be an https URL or a docs/ path`);
    if (parseVersion(e.deprecatedIn) === null || parseVersion(e.removedIn) === null) {
      problems.push(`${id}: deprecatedIn and removedIn must be x.y.z versions`);
      continue;
    }
    if (compareVersions(e.deprecatedIn, currentVersion) > 0) {
      problems.push(`${id}: deprecatedIn ${e.deprecatedIn} is after the current version ${currentVersion}`);
    }
    if (compareVersions(e.removedIn, e.deprecatedIn) <= 0) {
      problems.push(`${id}: removedIn ${e.removedIn} is not after deprecatedIn ${e.deprecatedIn}`);
    }
    if (compareVersions(e.removedIn, currentVersion) <= 0) {
      problems.push(
        `${id}: removedIn ${e.removedIn} is at or below the current version ${currentVersion}; remove the name and this entry`,
      );
    }
  }
  return problems;
}

/** What an operator's setup uses. Values are only tested for presence and never kept. */
export interface ConfigInUse {
  /** Environment (or Worker `env`): a variable counts when it is set to a non-blank string, number or boolean. */
  readonly env?: Readonly<Record<string, unknown>>;
  /** Parsed `--config` file. */
  readonly yaml?: unknown;
  /** Raw argv: `--name` and `--name=…` count. */
  readonly argv?: readonly string[];
}

function setInEnv(env: Readonly<Record<string, unknown>>, name: string): boolean {
  if (!Object.hasOwn(env, name)) return false;
  const v = env[name];
  if (typeof v === 'string') return v.trim() !== '';
  return typeof v === 'number' || typeof v === 'boolean';
}

function hasYamlPath(node: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return node !== undefined;
  if (node === null || typeof node !== 'object') return false;
  const [head, ...rest] = path as [string, ...string[]];
  // `*` matches any key of a mapping or any item of a list (`projects.*.x` covers the `projects:` list).
  if (head === '*') return Object.values(node).some((child) => hasYamlPath(child, rest));
  if (Array.isArray(node)) return false;
  const record = node as Record<string, unknown>;
  return Object.hasOwn(record, head) && hasYamlPath(record[head], rest);
}

function flagGiven(argv: readonly string[], name: string): boolean {
  const flag = `--${name}`;
  for (const a of argv) {
    if (a === '--') return false;
    if (a === flag || a.startsWith(`${flag}=`)) return true;
  }
  return false;
}

/** The registry entries `input` uses, in registry order. */
export function deprecatedConfigInUse(
  input: ConfigInUse,
  registry: readonly DeprecatedConfig[] = DEPRECATED_CONFIG,
): DeprecatedConfig[] {
  return registry.filter((e) => {
    if (e.kind === 'env') return input.env !== undefined && setInEnv(input.env, e.name);
    if (e.kind === 'yaml') return input.yaml !== undefined && hasYamlPath(input.yaml, e.name.split('.'));
    return input.argv !== undefined && flagGiven(input.argv, e.name);
  });
}

const KIND_LABEL: Record<DeprecatedConfigKind, string> = {
  env: 'Environment variable',
  yaml: 'Config file key',
  flag: 'Flag',
};

/** The display form of the name: `--flag` for flags. */
export function deprecatedConfigName(entry: DeprecatedConfig): string {
  return entry.kind === 'flag' ? `--${entry.name}` : entry.name;
}

/** One warning line for an entry in use. Names only; never the value. */
export function describeDeprecatedConfig(entry: DeprecatedConfig): string {
  return (
    `${KIND_LABEL[entry.kind]} ${deprecatedConfigName(entry)} is deprecated since ${entry.deprecatedIn} and will be ` +
    `removed in ${entry.removedIn}; use ${entry.replacement} instead (${entry.docs}).`
  );
}

/** Warning lines for everything `input` uses that is deprecated. */
export function deprecatedConfigWarnings(
  input: ConfigInUse,
  registry: readonly DeprecatedConfig[] = DEPRECATED_CONFIG,
): string[] {
  return deprecatedConfigInUse(input, registry).map(describeDeprecatedConfig);
}
