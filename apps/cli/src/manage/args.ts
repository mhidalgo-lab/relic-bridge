// SPDX-License-Identifier: Apache-2.0
import { parseArgs } from 'node:util';
import { redact } from '@relic-bridge/core';
import { UsageError } from '../args.ts';

/** Every option the management commands know. No option carries a secret value (keys come from stdin, a file or env). */
const OPTIONS = {
  db: { type: 'string' },
  remote: { type: 'string' },
  insecure: { type: 'boolean' },
  json: { type: 'boolean' },
  yes: { type: 'boolean' },
  'log-level': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  label: { type: 'string' },
  region: { type: 'string' },
  owner: { type: 'string' },
  email: { type: 'string' },
  name: { type: 'string' },
  role: { type: 'string' },
  slug: { type: 'string' },
  'default-account': { type: 'string' },
  accounts: { type: 'string' },
  tools: { type: 'string' },
  'default-credential': { type: 'string' },
  disable: { type: 'boolean' },
  enable: { type: 'boolean' },
  project: { type: 'string' },
  user: { type: 'string' },
  credential: { type: 'string' },
  grant: { type: 'string' },
  'ttl-days': { type: 'string' },
  never: { type: 'boolean' },
  'expires-in-days': { type: 'string' },
  limit: { type: 'string' },
  follow: { type: 'boolean' },
  kind: { type: 'string' },
  action: { type: 'string' },
  status: { type: 'string' },
  since: { type: 'string' },
  until: { type: 'string' },
  'token-id': { type: 'string' },
  'key-id': { type: 'string' },
  'key-file': { type: 'string' },
  'key-env': { type: 'string' },
  'master-key-file': { type: 'string' },
  device: { type: 'string' },
  url: { type: 'string' },
  client: { type: 'string' },
  'no-config': { type: 'boolean' },
  'batch-size': { type: 'string' },
  provider: { type: 'string' },
  ttl: { type: 'string' },
  confirm: { type: 'string' },
  config: { type: 'string' },
  offline: { type: 'boolean' },
  'client-configs': { type: 'boolean' },
  'token-file': { type: 'string' },
  out: { type: 'string' },
  'with-credentials': { type: 'boolean' },
  apply: { type: 'boolean' },
  'passphrase-file': { type: 'string' },
  'passphrase-env': { type: 'string' },
} as const;

export type ManageOptionName = keyof typeof OPTIONS;
export type ManageValues = {
  readonly [K in ManageOptionName]?: (typeof OPTIONS)[K] extends { type: 'boolean' } ? boolean : string;
};

const COMMON: readonly ManageOptionName[] = ['db', 'remote', 'insecure', 'json', 'log-level', 'help'];
const KEY_SRC: readonly ManageOptionName[] = ['key-file', 'key-env'];

interface Spec {
  /** Exact positional count after the command words. */
  readonly args: number;
  readonly flags: readonly ManageOptionName[];
}

/** Command → what it accepts. A flag outside its command's list is a usage error. */
const SPECS: Readonly<Record<string, Spec>> = {
  doctor: { args: 0, flags: ['config', 'project', 'offline', 'client-configs', 'token-file'] },
  init: {
    args: 0,
    flags: [
      'master-key-file',
      'label',
      'region',
      ...KEY_SRC,
      'slug',
      'default-account',
      'accounts',
      'device',
      'url',
      'client',
      'no-config',
    ],
  },
  'admin-token generate': { args: 0, flags: [] },
  'user add': { args: 0, flags: ['email', 'name', 'role'] },
  'user list': { args: 0, flags: ['limit'] },
  'user unbind': { args: 1, flags: ['confirm'] },
  'setup-link': { args: 0, flags: ['provider', 'ttl'] },
  'credential add': { args: 0, flags: ['label', 'region', 'owner', ...KEY_SRC] },
  'credential list': { args: 0, flags: ['owner', 'limit'] },
  'credential rotate': { args: 1, flags: [...KEY_SRC] },
  'credential revalidate': { args: 1, flags: [] },
  'credential remove': { args: 1, flags: ['yes'] },
  'project add': {
    args: 0,
    flags: ['slug', 'name', 'default-account', 'accounts', 'tools', 'default-credential'],
  },
  'project list': { args: 0, flags: ['slug', 'limit'] },
  'project update': {
    args: 1,
    flags: [
      'slug',
      'name',
      'default-account',
      'accounts',
      'tools',
      'default-credential',
      'disable',
      'enable',
    ],
  },
  'grant create': {
    args: 0,
    flags: ['project', 'user', 'label', 'credential', 'tools', 'accounts', 'expires-in-days'],
  },
  'grant list': { args: 0, flags: ['project', 'user', 'limit'] },
  'grant revoke': { args: 1, flags: [] },
  'token create': { args: 0, flags: ['grant', 'label', 'ttl-days', 'never', 'url', 'client', 'no-config'] },
  'token list': { args: 0, flags: ['grant', 'limit'] },
  'token revoke': { args: 1, flags: [] },
  'keys rotate': { args: 0, flags: ['batch-size'] },
  'keychain set': { args: 1, flags: [...KEY_SRC] },
  'keychain delete': { args: 1, flags: [] },
  'keychain status': { args: 0, flags: [] },
  'config export': { args: 0, flags: ['out', 'with-credentials', 'passphrase-file', 'passphrase-env'] },
  'config import': { args: 1, flags: ['apply', 'passphrase-file', 'passphrase-env'] },
  'audit tail': {
    args: 0,
    flags: [
      'follow',
      'limit',
      'kind',
      'action',
      'status',
      'project',
      'user',
      'grant',
      'token-id',
      'key-id',
      'since',
      'until',
    ],
  },
};

export interface ManageArgs {
  /** `credential add`, `token create`, … */
  readonly command: string;
  readonly positionals: readonly string[];
  readonly values: ManageValues;
  readonly help: boolean;
}

const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'client-configs',
  'insecure',
  'json',
  'yes',
  'help',
  'version',
  'disable',
  'enable',
  'never',
  'follow',
  'no-config',
  'offline',
  'with-credentials',
  'apply',
]);

/** Whether argv names a management command (so `main` hands it over). */
export function isManageArgv(argv: readonly string[]): boolean {
  // Command words only: skip option values (every option except these flags takes one).
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('-')) words.push(a);
    else if (a.startsWith('--') && !a.includes('=') && !BOOLEAN_FLAGS.has(a.slice(2))) i++;
  }
  const first = words[0];
  const second = words[1];
  if (first === undefined) return false;
  if (first === 'init' || first === 'admin-token' || first === 'user' || first === 'project') return true;
  if (first === 'setup-link' || first === 'doctor' || first === 'keychain') return true;
  if (first === 'grant' || first === 'token' || first === 'config') return true;
  if (first === 'credential') return second !== 'revalidate' || words.length > 2;
  if (first === 'audit') return second === 'tail';
  // `keys rotate --remote <url>` (P3-11) runs on the server through the Admin API; without it, on a local file.
  if (first === 'keys')
    return second === 'rotate' && argv.some((a) => a === '--remote' || a.startsWith('--remote='));
  return false;
}

const WORDS: Readonly<Record<string, readonly string[]>> = {
  'admin-token': ['generate'],
  user: ['add', 'list', 'unbind'],
  credential: ['add', 'list', 'rotate', 'revalidate', 'remove'],
  project: ['add', 'list', 'update'],
  grant: ['create', 'list', 'revoke'],
  token: ['create', 'list', 'revoke'],
  audit: ['tail'],
  keys: ['rotate'],
  keychain: ['set', 'delete', 'status'],
  config: ['export', 'import'],
};

/** Parse a management command line. Strict: an unknown flag (e.g. `--api-key`, `--admin-token`) is refused. */
export function parseManageArgs(argv: readonly string[]): ManageArgs {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new UsageError(redact(error instanceof Error ? error.message : String(error)));
  }
  const { values, positionals } = parsed;
  if (values.help) return { command: positionals.slice(0, 2).join(' '), positionals: [], values, help: true };
  const first = positionals[0] ?? '';
  let command: string;
  let rest: string[];
  if (first === 'init' || first === 'setup-link' || first === 'doctor') {
    command = first;
    rest = positionals.slice(1);
  } else {
    const sub = positionals[1];
    const allowed = WORDS[first];
    if (allowed === undefined || sub === undefined || !allowed.includes(sub)) {
      throw new UsageError(
        allowed === undefined
          ? `Unknown command "${redact(first).slice(0, 40)}".`
          : `Usage: relic-bridge ${first} ${allowed.join('|')} [options]. Try --help.`,
      );
    }
    command = `${first} ${sub}`;
    rest = positionals.slice(2);
  }
  const spec = SPECS[command];
  if (spec === undefined) throw new UsageError(`Unknown command "${command}".`);
  if (rest.length !== spec.args) {
    throw new UsageError(
      spec.args === 0
        ? `${command} takes no positional arguments.`
        : `${command} needs exactly ${spec.args} argument${spec.args === 1 ? '' : 's'} (an id).`,
    );
  }
  const allowedFlags = new Set<string>([...COMMON, ...spec.flags]);
  for (const name of Object.keys(values)) {
    if (!allowedFlags.has(name)) throw new UsageError(`--${name} does not apply to ${command}.`);
  }
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'string' && value.trim() === '') throw new UsageError(`--${name} needs a value.`);
  }
  return { command, positionals: rest, values, help: false };
}

function parse(argv: readonly string[]) {
  return parseArgs({ args: [...argv], strict: true, allowPositionals: true, options: OPTIONS });
}

/** A whole number within bounds from an option value. */
export function intOption(
  name: string,
  raw: string | undefined,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^-?\d{1,15}$/.test(raw.trim())) throw new UsageError(`--${name} must be a whole number.`);
  const n = Number(raw);
  if (n < min || n > max) throw new UsageError(`--${name} must be between ${min} and ${max}.`);
  return n;
}

/** Comma-separated whole numbers (`--accounts 1,2`). */
export function intList(name: string, raw: string | undefined): number[] | undefined {
  if (raw === undefined) return undefined;
  const out = raw.split(',').map((s) => s.trim());
  if (out.some((s) => !/^\d{1,15}$/.test(s)))
    throw new UsageError(`--${name} must be comma-separated account ids.`);
  return out.map(Number);
}

/** Comma-separated names (`--tools a,b`); `all` means no restriction (null). */
export function nameList(name: string, raw: string | undefined): string[] | null | undefined {
  if (raw === undefined) return undefined;
  if (raw.trim().toLowerCase() === 'all') return null;
  const out = raw.split(',').map((s) => s.trim());
  if (out.some((s) => s === '')) throw new UsageError(`--${name} must be comma-separated names (or "all").`);
  return out;
}
