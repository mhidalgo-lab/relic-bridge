// SPDX-License-Identifier: Apache-2.0
// `pnpm cf:setup` (P3-05): deploy relic-bridge to your Cloudflare account from a clone, in one command.
//
//   0. checks the Wrangler login and its scopes first (`wrangler whoami --json`, P8-82),
//   1. generates RB_MASTER_KEY and RB_ADMIN_TOKEN (and RB_FINGERPRINT_SECRET with --passthrough) with the CSPRNG,
//   2. sends them to `wrangler secret bulk` on STDIN (never as arguments, never written to a repo file),
//   3. deploys with a git-ignored copy of wrangler.jsonc, so Wrangler's automatic provisioning creates the D1 database
//      without an id in the committed file; Wrangler writes ids back only in an interactive terminal, so the script then
//      looks the database up and records its `database_id` in the copy itself (P8-81),
//   3b. with --sign-in (P4-09): asks for RB_PUBLIC_URL and the sign-in provider settings. Client ids and issuer go to the
//      deploy as `--var`; client SECRETS go through the same `wrangler secret bulk` stdin call (read from the environment
//      or a hidden prompt, never from an argument, never written to a file),
//   4. prints the deployed URLs and the next steps (credential, project, grant and token through the CLI built in the
//      clone, `node apps/cli/dist/index.mjs`, with RB_REMOTE set to the custom domain or workers.dev URL).
//
//   --master-key-stdin (P8-80): use the master key of an existing server (piped on stdin, or a hidden prompt) instead of
//   generating one, for a database imported with `relic-bridge db export --format d1`. That key is never printed and
//   never written to --backup-file.
//
// Migrations are not a step: the Worker migrates D1 itself when it boots (ADR-0006 update, P3-02).
// Re-running is safe: secrets that already exist are never regenerated (a new master key would make every stored
// New Relic key undecryptable).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SetupOptions {
  name: string;
  plan: 'free' | 'paid';
  passthrough: boolean;
  dryRun: boolean;
  /** Treat a failing `secret list` as "the Worker does not exist yet" (first deploy). */
  assumeNew: boolean;
  /** Also write the generated secrets to this file (created 0600, never overwritten). Off by default. */
  backupFile: string | undefined;
  /** Ask for RB_PUBLIC_URL and the sign-in provider settings (P4-09). */
  signIn: boolean;
  /** `--public-url`: not a secret; otherwise RB_PUBLIC_URL from the environment, else a prompt. */
  publicUrl: string | undefined;
  /** Allow generating a new RB_MASTER_KEY although the Worker already has RB_ADMIN_TOKEN (orphans stored keys). */
  replaceMasterKey: boolean;
  /** `--shared-limiter rules|on`: deploy with RB_SHARED_LIMITER (P7-10, the Durable Object limiter). */
  sharedLimiter: 'rules' | 'on' | undefined;
  /** `--master-key-stdin` (P8-80): RB_MASTER_KEY is the existing server's key, read by `deps.readMasterKey`. */
  masterKeyStdin: boolean;
}

export interface WranglerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one Wrangler command. `input` goes to its stdin; arguments never carry secret values. */
export type WranglerRunner = (args: readonly string[], input?: string) => Promise<WranglerResult>;

export interface SetupDeps {
  wrangler: WranglerRunner;
  /** CSPRNG; defaults to node:crypto. */
  random: (bytes: number) => Uint8Array;
  log: (line: string) => void;
  /** Environment for `--sign-in`: `RB_<PROVIDER>_CLIENT_ID` / `_CLIENT_SECRET` skip the prompts. Defaults to none. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Ask on the terminal (echoed). Present only when stdin is a terminal. */
  prompt?: (question: string) => Promise<string>;
  /** Ask on the terminal without echo. Present only when stdin is a terminal. */
  promptSecret?: (question: string) => Promise<string>;
  /** `--master-key-stdin`: the existing master key (all of stdin, or a hidden prompt on a terminal). */
  readMasterKey?: () => Promise<string>;
  /** The secrets text shown once (stdout). Separate from `log` so tests can assert what is printed where. */
  reveal: (line: string) => void;
  /** Worker directory (holds wrangler.jsonc). */
  workerDir: string;
  /** Repository root, to warn when `--backup-file` would land inside the working tree. */
  repoRoot?: string;
  fs: {
    exists: (path: string) => boolean;
    read: (path: string) => string;
    /** Writes a new file; throws when it exists. */
    writeNew: (path: string, content: string, mode: number) => void;
    /** Replaces the content of an existing file, keeping its mode. Used only for the git-ignored local config. */
    replace: (path: string, content: string) => void;
  };
}

export class SetupError extends Error {}

const SECRET_NAMES = ['RB_MASTER_KEY', 'RB_ADMIN_TOKEN', 'RB_FINGERPRINT_SECRET'] as const;
export const LOCAL_CONFIG = 'wrangler.local.jsonc';
const DEFAULT_NAME = 'relic-bridge';

/**
 * The git-ignored config a Worker deploys with. One per Worker name: it names (and, after the first deploy, holds the
 * id of) that Worker's D1 database, so a second Worker (staging) sharing the default copy would bind to the first one's.
 */
export function localConfigName(name: string): string {
  return name === DEFAULT_NAME ? LOCAL_CONFIG : `wrangler.${name}.local.jsonc`;
}

/** The committed config for Worker `name`: its own D1 database name, so provisioning never reuses another's. */
export function localConfigFor(committed: string, name: string): string {
  if (name === DEFAULT_NAME) return committed;
  const re = /"database_name":\s*"relic-bridge"/;
  const ns = /("namespace_id":\s*)"1701"/;
  if (!re.test(committed))
    throw new SetupError('wrangler.jsonc has no relic-bridge D1 database_name to rename');
  if (!ns.test(committed))
    throw new SetupError('wrangler.jsonc has no ratelimits namespace_id "1701" to rename');
  return committed.replace(re, `"database_name": "${name}"`).replace(ns, `$1"${rateLimitNamespace(name)}"`);
}

/** Cloudflare wants an account-unique integer string; derive one from the Worker name (FNV-1a), 1701 for the default. */
export function rateLimitNamespace(name: string): string {
  if (name === DEFAULT_NAME) return '1701';
  let h = 0x811c9dc5;
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return String(1_000_000 + (h % 8_000_000_000));
}

/**
 * Comparable form of a wrangler config: comments, whitespace and the ids Wrangler writes on provisioning
 * (`database_id`) and any leftover `kv_namespaces` block (P5-13) removed. Equal forms mean a `git pull` changed nothing the local copy lacks.
 */
export function normalizeConfig(text: string): string {
  return text
    .replace(/(^|\s)\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"kv_namespaces"\s*:\s*\[[^\]]*\]\s*,?/g, '')
    .replace(/"(database_id|id)"\s*:\s*"[^"]*"\s*,?/g, '')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/\s+/g, '');
}
const WORKER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The `DB` entry of `d1_databases`. A D1 binding has no nested objects, so `{...}` without inner braces is all of it. */
const DB_BINDING_RE = /("d1_databases"\s*:\s*\[[^\]]*?)(\{[^{}]*"binding"\s*:\s*"DB"[^{}]*\})/;

/** The `DB` binding of a wrangler config text: its `database_name` and whether it already has a `database_id`. */
export function d1Binding(text: string): { name: string; hasId: boolean } | undefined {
  const entry = DB_BINDING_RE.exec(text)?.[2];
  if (entry === undefined) return undefined;
  const name = /"database_name"\s*:\s*"([^"]+)"/.exec(entry)?.[1];
  if (name === undefined) return undefined;
  return { name, hasId: /"database_id"\s*:\s*"[^"]*"/.test(entry) };
}

/**
 * `text` with `"database_id": "<id>"` added right after the `DB` binding's `database_name`, everything else byte for
 * byte; `undefined` when there is no such binding, it already has an id, or `id` is not a UUID.
 */
export function withDatabaseId(text: string, id: string): string | undefined {
  if (!UUID_RE.test(id)) return undefined;
  const b = d1Binding(text);
  if (b === undefined || b.hasId) return undefined;
  return text.replace(
    DB_BINDING_RE,
    (_m, head: string, entry: string) =>
      head + entry.replace(/("database_name"\s*:\s*"[^"]+")/, `$1, "database_id": "${id}"`),
  );
}

/** The uuid of the one database named `name` in `wrangler d1 list --json` output, or why there is none. */
export function databaseIdFromList(stdout: string, name: string): { id: string } | { reason: string } {
  let rows: unknown;
  try {
    // Wrangler may print a notice (an update hint) before the JSON array.
    const start = stdout.indexOf('[');
    rows = JSON.parse(start === -1 ? stdout : stdout.slice(start));
  } catch {
    return { reason: '`wrangler d1 list --json` did not return JSON' };
  }
  if (!Array.isArray(rows)) return { reason: '`wrangler d1 list --json` did not return a list' };
  const ids = rows.flatMap((r: unknown) => {
    if (typeof r !== 'object' || r === null) return [];
    const row = r as { name?: unknown; uuid?: unknown };
    return row.name === name && typeof row.uuid === 'string' ? [row.uuid] : [];
  });
  if (ids.length === 0) return { reason: `no D1 database named "${name}" is listed` };
  if (ids.length > 1) return { reason: `more than one D1 database is named "${name}"` };
  const id = ids[0] as string;
  if (!UUID_RE.test(id)) return { reason: 'the listed database id is not a UUID' };
  return { id };
}

/**
 * After a deploy: record the bound database's id in the local copy (P8-81). Wrangler writes provisioned ids back only
 * in an interactive terminal (this script pipes its output), and a binding by name alone makes every later deploy
 * print a "remote configuration differs" diff (`- database_id` / `+ database_name`). Never fatal: by name works.
 */
async function recordDatabaseId(deps: SetupDeps, localConfig: string, localName: string): Promise<void> {
  const text = deps.fs.read(localConfig);
  const binding = d1Binding(text);
  if (binding === undefined || binding.hasId) return;
  const r = await deps.wrangler(['d1', 'list', '--json', '-c', localConfig]);
  const found =
    r.code === 0
      ? databaseIdFromList(r.stdout, binding.name)
      : { reason: `wrangler d1 list failed (exit ${r.code})` };
  const updated = 'id' in found ? withDatabaseId(text, found.id) : undefined;
  if (updated === undefined) {
    const reason = 'reason' in found ? found.reason : 'the D1 entry could not be updated';
    deps.log(
      `NOTE: could not record the D1 database id in ${localName} (${reason}). Deploys still work: Wrangler finds the ` +
        'database by name. To add it by hand, run `wrangler d1 list` and add "database_id": "<uuid>" next to "database_name".',
    );
    return;
  }
  deps.fs.replace(localConfig, updated);
  deps.log(
    `Recorded the id of D1 database "${binding.name}" in ${localName} (later deploys no longer list it as a "remote configuration" difference).`,
  );
}

export function parseArgs(argv: readonly string[]): SetupOptions | 'help' {
  const o: SetupOptions = {
    name: DEFAULT_NAME,
    plan: 'free',
    passthrough: false,
    dryRun: false,
    assumeNew: false,
    backupFile: undefined,
    signIn: false,
    publicUrl: undefined,
    replaceMasterKey: false,
    sharedLimiter: undefined,
    masterKeyStdin: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new SetupError(`${a} needs a value`);
      return v;
    };
    if (a === '--help' || a === '-h') return 'help';
    else if (a === '--name') o.name = value();
    else if (a === '--plan') {
      const v = value();
      if (v !== 'free' && v !== 'paid') throw new SetupError('--plan must be free or paid');
      o.plan = v;
    } else if (a === '--passthrough') o.passthrough = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--assume-new') o.assumeNew = true;
    else if (a === '--replace-master-key') o.replaceMasterKey = true;
    else if (a === '--master-key-stdin') o.masterKeyStdin = true;
    else if (a === '--backup-file') o.backupFile = value();
    else if (a === '--sign-in') o.signIn = true;
    else if (a === '--public-url') o.publicUrl = value();
    else if (a === '--shared-limiter') {
      const v = value();
      if (v !== 'rules' && v !== 'on') throw new SetupError('--shared-limiter must be rules or on');
      o.sharedLimiter = v;
    } else throw new SetupError(`unknown option ${a}`);
  }
  if (!WORKER_NAME_RE.test(o.name)) {
    throw new SetupError('--name must be lowercase letters, digits and dashes (max 63 characters)');
  }
  return o;
}

export const HELP = `Usage: pnpm cf:setup [options]

Deploys relic-bridge to your Cloudflare account (run \`wrangler login\` first).

  --name <worker>      Worker name (default relic-bridge)
  --plan free|paid     RB_PLAN preset for NerdGraph limits (default free)
  --passthrough        Also generate RB_FINGERPRINT_SECRET and set RB_PASSTHROUGH=on
  --backup-file <path> Also write the generated secrets to a new file (mode 0600). Off by default.
  --assume-new         First deploy: treat an unreadable secret list as "no Worker yet" (refused if the Worker exists)
  --replace-master-key Generate a new RB_MASTER_KEY although the Worker already has RB_ADMIN_TOKEN. DESTRUCTIVE:
                       every stored New Relic key becomes undecryptable. Rarely what you want.
  --master-key-stdin   Use the master key of the server you are migrating from (P8-80) instead of generating one: piped
                       on stdin (e.g. from your password manager's CLI), or typed at a hidden prompt. Never printed, never
                       written to --backup-file. Replacing a key the Worker already has also needs --replace-master-key.
                       Then import the data: see "Migrate from a self-hosted server" in docs/guide/cloudflare-deploy.md.
  --sign-in            Also set up sign-in (P4-09): asks for the public URL and, per provider (Google, GitHub, generic
                       OIDC), the client id and secret. Answers can come from RB_PUBLIC_URL and
                       RB_<GOOGLE|GITHUB|OIDC>_CLIENT_ID / _CLIENT_SECRET (and RB_OIDC_ISSUER) in your environment, so
                       it also works without a terminal. Client secrets are sent as Worker secrets, never as arguments.
  --public-url <url>   The https origin people use for this Worker (with --sign-in); not a secret.
  --shared-limiter rules|on
                       Count limits in the SharedLimiter Durable Object for every isolate (P7-10): \`rules\` for the
                       auth-failure, sign-in, OAuth and write limits, \`on\` also for NerdGraph concurrency per key.
                       Each check is a Durable Object request (Free plan: 100,000 a day). See cloudflare-limits.md.
  --dry-run            Print what would happen; generates and sends nothing, calls no Cloudflare API
`;

const SIGN_IN_PROVIDERS = [
  { key: 'GOOGLE', id: 'google', label: 'Google' },
  { key: 'GITHUB', id: 'github', label: 'GitHub' },
  { key: 'OIDC', id: 'oidc', label: 'a generic OIDC provider' },
] as const;
const CLIENT_ID_RE = /^[\x21-\x7e]{1,512}$/;

/** `https://host` only, no path or credentials (a Worker is always served over https). */
export function checkPublicUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new SetupError(
      'the public URL is not a valid URL (example: https://relic-bridge.acme.workers.dev)',
    );
  }
  if (
    u.protocol !== 'https:' ||
    u.username !== '' ||
    u.password !== '' ||
    u.search !== '' ||
    u.hash !== '' ||
    (u.pathname !== '/' && u.pathname !== '')
  ) {
    throw new SetupError(
      'the public URL must be an https origin only (https://host), with no path or credentials',
    );
  }
  return u.origin;
}

export interface SignInConfig {
  readonly publicUrl: string;
  /** Not secret: sent as `--var` on deploy. */
  readonly vars: Readonly<Record<string, string>>;
  /** Client secrets: sent through `wrangler secret bulk` on stdin only. */
  readonly secrets: Readonly<Record<string, string>>;
  /** Provider ids, for the redirect URLs printed afterwards (`oidc` is replaced by RB_OIDC_NAME or `oidc`). */
  readonly providers: readonly string[];
}

/**
 * Collect the sign-in settings (P4-09) before anything is sent: from the environment first, then prompts (when stdin is
 * a terminal). A provider whose secret already exists on the Worker keeps it when none is given now.
 */
export async function collectSignIn(
  opts: SetupOptions,
  deps: SetupDeps,
  have: ReadonlySet<string>,
): Promise<SignInConfig> {
  const env = deps.env ?? {};
  const ask = async (question: string): Promise<string> =>
    deps.prompt === undefined ? '' : (await deps.prompt(question)).trim();
  const askSecret = async (question: string): Promise<string> =>
    deps.promptSecret === undefined ? '' : (await deps.promptSecret(question)).trim();
  const fromEnv = (name: string): string => (env[name] ?? '').trim();

  let publicUrl = opts.publicUrl ?? fromEnv('RB_PUBLIC_URL');
  if (publicUrl === '') publicUrl = await ask('Public URL of this Worker (https://...): ');
  if (publicUrl === '') {
    throw new SetupError(
      '--sign-in needs the public URL: pass --public-url, set RB_PUBLIC_URL, or run in a terminal.',
    );
  }
  publicUrl = checkPublicUrl(publicUrl);

  const vars: Record<string, string> = { RB_PUBLIC_URL: publicUrl };
  const secrets: Record<string, string> = {};
  const providers: string[] = [];
  for (const p of SIGN_IN_PROVIDERS) {
    let clientId = fromEnv(`RB_${p.key}_CLIENT_ID`);
    if (clientId === '') clientId = await ask(`${p.label} client id (empty to skip): `);
    if (clientId === '') continue;
    if (!CLIENT_ID_RE.test(clientId)) throw new SetupError(`the ${p.label} client id has invalid characters`);
    const secretName = `RB_${p.key}_CLIENT_SECRET`;
    let secret = fromEnv(secretName);
    if (secret === '' && deps.promptSecret !== undefined) {
      const kept = have.has(secretName) ? ' (empty keeps the stored one)' : '';
      secret = await askSecret(`${p.label} client secret (hidden)${kept}: `);
    }
    if (secret === '' && !have.has(secretName)) {
      throw new SetupError(
        `${p.label}: a client id needs its secret (${secretName} in the environment, or a terminal).`,
      );
    }
    vars[`RB_${p.key}_CLIENT_ID`] = clientId;
    if (secret !== '') secrets[secretName] = secret;
    if (p.key === 'OIDC') {
      let issuer = fromEnv('RB_OIDC_ISSUER');
      if (issuer === '') issuer = await ask('OIDC issuer URL (https://...): ');
      if (!/^https:\/\/[^\s?#]+$/.test(issuer)) throw new SetupError('the OIDC issuer must be an https URL');
      vars['RB_OIDC_ISSUER'] = issuer;
      const name = fromEnv('RB_OIDC_NAME');
      if (name !== '') {
        if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(name)) {
          throw new SetupError('RB_OIDC_NAME must be 1-32 lowercase letters, digits or dashes');
        }
        vars['RB_OIDC_NAME'] = name;
      }
      providers.push(name === '' ? 'oidc' : name);
    } else providers.push(p.id);
  }
  if (providers.length === 0) {
    throw new SetupError(
      '--sign-in found no provider: give a client id for Google, GitHub or OIDC (prompt or RB_<PROVIDER>_CLIENT_ID).',
    );
  }
  return Object.freeze({ publicUrl, vars, secrets, providers });
}

const MASTER_KEY_RE = /^(?:v([1-9][0-9]{0,5}):)?([A-Za-z0-9+/_=-]+)$/;

/**
 * Check a master key given with --master-key-stdin: `[v<N>:]<base64 of 32 bytes>`, as the Worker parses it
 * (packages/auth/src/crypto/keyring.ts). Returns the trimmed key and its version; errors never echo the value.
 */
export function checkMasterKey(raw: string): { key: string; version: number } {
  const key = raw.trim();
  const m = MASTER_KEY_RE.exec(key);
  const fail = (why: string): SetupError =>
    new SetupError(`the master key on stdin is not valid (${why}); expected v<N>:<base64 of 32 bytes>`);
  if (key === '') throw fail('empty');
  if (m === null) throw fail('unexpected characters or a second line');
  const body = (m[2] ?? '').replaceAll('-', '+').replaceAll('_', '/');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw fail('not base64');
  const bytes = Buffer.from(body, 'base64');
  if (bytes.byteLength !== 32) throw fail(`${bytes.byteLength} bytes instead of 32`);
  if (bytes.every((b) => b === bytes[0])) throw fail('all bytes are equal');
  bytes.fill(0);
  return { key, version: m[1] === undefined ? 1 : Number(m[1]) };
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/** 256-bit secrets in the formats the Worker validates (master key `v1:<base64>`, admin token 32-512 printable). */
export function generateSecrets(
  names: readonly string[],
  random: (bytes: number) => Uint8Array,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const bytes = random(32);
    if (bytes.byteLength !== 32) throw new SetupError('random source returned the wrong length');
    out[n] = n === 'RB_MASTER_KEY' ? `v1:${b64(bytes)}` : n === 'RB_ADMIN_TOKEN' ? b64url(bytes) : b64(bytes);
  }
  return out;
}

function secretsToSet(opts: SetupOptions): string[] {
  return SECRET_NAMES.filter((n) => n !== 'RB_FINGERPRINT_SECRET' || opts.passthrough);
}

const NOT_FOUND_RE = /10007|does not exist|not found|no worker/i;

/** Names of the secrets already on the Worker; `[]` when the Worker does not exist yet. */
async function existingSecrets(
  opts: SetupOptions,
  deps: SetupDeps,
  cfg: readonly string[],
): Promise<string[]> {
  const r = await deps.wrangler(['secret', 'list', '--format', 'json', ...cfg]);
  if (r.code === 0) {
    try {
      const rows = JSON.parse(r.stdout) as unknown;
      if (Array.isArray(rows)) {
        if (opts.assumeNew && rows.length > 0) {
          throw new SetupError(
            '--assume-new is for a first deploy, but this Worker already exists (it has secrets). Re-run without --assume-new.',
          );
        }
        return rows.flatMap((row) =>
          typeof row === 'object' && row !== null && typeof (row as { name?: unknown }).name === 'string'
            ? [(row as { name: string }).name]
            : [],
        );
      }
    } catch (e) {
      if (e instanceof SetupError) throw e;
      // fall through to the refusal below
    }
    throw new SetupError("could not read the Worker's secret list; refusing to generate secrets blindly");
  }
  if (opts.assumeNew || NOT_FOUND_RE.test(r.stderr + r.stdout)) return [];
  throw new SetupError(
    "could not list the Worker's secrets (not logged in, or a network error?). Refusing to continue, because setting a new " +
      'master key on an existing Worker would make its stored New Relic keys undecryptable. ' +
      'If this Worker does not exist yet, re-run with --assume-new.',
  );
}

const WORKERS_DEV_RE = /https:\/\/[a-z0-9.-]+\.workers\.dev/i;
const WORKERS_DEV_LINE_RE = /^\s+(https:\/\/[a-z0-9.-]+\.workers\.dev)\s*$/gim;
const CUSTOM_DOMAIN_LINE_RE =
  /^\s+([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+) \(custom domain/gim;

/**
 * The URLs a `wrangler deploy` reported (its "Deployed <name> triggers" list): custom domains first, then workers.dev.
 * Plain routes (`example.com/*`) are not URLs and are left out.
 */
export function deployedUrls(output: string): string[] {
  const custom = [...output.matchAll(CUSTOM_DOMAIN_LINE_RE)].map(
    (m) => `https://${(m[1] as string).toLowerCase()}`,
  );
  let dev = [...output.matchAll(WORKERS_DEV_LINE_RE)].map((m) => (m[1] as string).toLowerCase());
  if (dev.length === 0) {
    const any = WORKERS_DEV_RE.exec(output)?.[0];
    if (any !== undefined) dev = [any.toLowerCase()];
  }
  return [...new Set([...custom, ...dev])];
}

/** JSONC text as a value (comments and trailing commas removed outside strings); `undefined` when it does not parse. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as unknown;
  } catch {
    return undefined;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Keys of the copy that are the operator's to change (custom domain, workers.dev, dashboard-style variables, account). */
const LOCAL_KEYS = new Set(['routes', 'route', 'workers_dev', 'preview_urls', 'vars', 'account_id']);

/** A comparable form of one top-level value: object keys sorted, D1 ids dropped. */
function comparable(key: string, value: unknown): string {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (!isRecord(v)) return v;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      if (key === 'd1_databases' && (k === 'database_id' || k === 'preview_database_id')) continue;
      out[k] = strip(v[k]);
    }
    return out;
  };
  return JSON.stringify(strip(value));
}

/**
 * Top-level settings of `wanted` (the committed config for this Worker) that the local copy lacks or has with another
 * value: a binding, cron or setting an update added. Keys only in the copy, and `LOCAL_KEYS`, are the operator's and
 * never count. `undefined` when either file does not parse (the caller falls back to a text comparison).
 */
export function configDrift(wanted: string, local: string): string[] | undefined {
  const a = parseJsonc(wanted);
  const b = parseJsonc(local);
  if (!isRecord(a) || !isRecord(b)) return undefined;
  return Object.keys(a).filter(
    (k) => !LOCAL_KEYS.has(k) && (!(k in b) || comparable(k, a[k]) !== comparable(k, b[k])),
  );
}

const LOGIN_CMD = '`pnpm --filter @relic-bridge/worker exec wrangler login`';
const REQUIRED_SCOPES = ['workers_scripts:write', 'd1:write'] as const;

/**
 * Checks `wrangler whoami --json` before anything is done: logged in, and (for an OAuth login, which lists its scopes)
 * the scopes this setup uses. Reads only `loggedIn`, `authType` and `tokenPermissions`, never prints the email or ids.
 * Returns a note to print, or throws.
 */
export function checkLogin(r: WranglerResult, hasRoutes: boolean): string | undefined {
  let info: unknown;
  const start = r.stdout.indexOf('{');
  if (start !== -1) {
    try {
      info = JSON.parse(r.stdout.slice(start));
    } catch {
      info = undefined;
    }
  }
  if (!isRecord(info)) {
    // Not JSON (an older Wrangler): the exit code and the text are all there is.
    if (r.code !== 0 || /not authenticated/i.test(r.stdout + r.stderr)) {
      throw new SetupError(`Wrangler is not logged in. Run ${LOGIN_CMD} first.`);
    }
    return undefined;
  }
  if (r.code !== 0 || info['loggedIn'] !== true) {
    throw new SetupError(`Wrangler is not logged in. Run ${LOGIN_CMD} first.`);
  }
  const needed: string[] = [...REQUIRED_SCOPES, ...(hasRoutes ? ['zone:read'] : [])];
  const perms = info['tokenPermissions'];
  if (!Array.isArray(perms)) {
    return (
      'NOTE: Wrangler uses an API token, whose permissions cannot be listed here. It needs Workers Scripts Edit and D1 Edit' +
      `${hasRoutes ? ', and Zone Read for the custom domain' : ''}; a missing one fails at the step that uses it.`
    );
  }
  const have = new Set(perms.filter((p): p is string => typeof p === 'string'));
  const missing = needed.filter((s) => !have.has(s));
  if (missing.length > 0) {
    throw new SetupError(
      `Your Wrangler login lacks ${missing.join(', ')}${hasRoutes && missing.includes('zone:read') ? ' (zone:read is for the routes in your local config)' : ''}. ` +
        `Run ${LOGIN_CMD} again (it asks for every scope Wrangler uses), then re-run this setup. Nothing was changed.`,
    );
  }
  return undefined;
}

/** True when the config text declares `routes` or `route` (a custom domain or route needs zone access). */
export function hasRoutes(text: string): boolean {
  const c = parseJsonc(text);
  if (isRecord(c)) {
    const r = c['routes'] ?? c['route'];
    return Array.isArray(r) ? r.length > 0 : r !== undefined && r !== null && r !== '';
  }
  return /"routes?"\s*:/.test(text);
}

/** How the next steps call the CLI from the clone (the package is also `relic-bridge` when installed). */
const CLI = 'node apps/cli/dist/index.mjs';

export async function runSetup(opts: SetupOptions, deps: SetupDeps): Promise<{ url: string | undefined }> {
  const { log } = deps;
  const localName = localConfigName(opts.name);
  const localConfig = join(deps.workerDir, localName);
  const backupPath = opts.backupFile === undefined ? undefined : resolve(opts.backupFile);
  const cfg = ['-c', localConfig, '--name', opts.name] as const;
  const wanted = secretsToSet(opts);

  if (opts.dryRun) {
    log('Dry run: nothing is generated, sent or deployed.');
    log(
      `  0. check the Wrangler login (\`wrangler whoami --json\`): stop unless it is logged in with ${REQUIRED_SCOPES.join(' and ')}`,
    );
    log('     (and zone:read when the local config has routes); an API token only gets a note');
    log(
      `  1. copy wrangler.jsonc to ${localName} (git-ignored; it gets the D1 database id after the deploy)` +
        (opts.name === DEFAULT_NAME
          ? ''
          : `, with D1 database "${opts.name}" and rate-limit namespace ${rateLimitNamespace(opts.name)}`),
    );
    log(
      '     on a re-run: warn about settings of wrangler.jsonc (a new binding or cron) that the copy lacks or changes;',
    );
    log('     routes, workers_dev, preview_urls, vars, account_id and ids are yours and are not compared');
    log(
      `  2. generate ${wanted.join(', ')} for Worker "${opts.name}" and send them to \`wrangler secret bulk\` on stdin,`,
    );
    if (opts.masterKeyStdin) {
      log(
        '     RB_MASTER_KEY is not generated: it is read from stdin (--master-key-stdin), sent the same way, never shown or',
      );
      log(
        '     written to the backup file; a Worker that already has RB_MASTER_KEY is refused unless --replace-master-key',
      );
    }
    log(
      '     skipping any that already exist; a missing RB_MASTER_KEY next to an existing RB_ADMIN_TOKEN is refused',
    );
    log('     unless --replace-master-key is given; --assume-new is refused if the Worker already exists');
    log(
      `  3. wrangler deploy --keep-vars (Wrangler provisions the D1 database and the SharedLimiter Durable Object namespace; RB_PLAN=${opts.plan}${opts.passthrough ? ', RB_PASSTHROUGH=on' : ''}${opts.sharedLimiter === undefined ? '' : `, RB_SHARED_LIMITER=${opts.sharedLimiter}`})`,
    );
    if (opts.signIn) {
      log(
        "     with --sign-in: ask for the public URL and each provider's client id and secret (nothing is asked in a dry run);",
      );
      log('     ids and URLs go to the deploy as --var, client secrets into the same secret bulk call');
    }
    log(
      `  4. when ${localName} has no D1 database_id yet: look the database up (\`wrangler d1 list --json\`) and add its id`,
    );
    log('     to the copy, so later deploys bind it by id (a failed lookup is only a note)');
    log(
      '  5. print the deployed URLs (custom domains, workers.dev) and the next steps with RB_REMOTE set to the first one;',
    );
    log(
      `     the steps use \`${CLI}\` and start with \`pnpm --filter ./apps/cli build\` when the CLI is not built`,
    );
    log('     (the Worker applies its D1 migrations when it first boots)');
    return { url: undefined };
  }

  // The login first: a missing scope must stop the run before anything is copied, generated or sent.
  const existingCopy = deps.fs.exists(localConfig) ? deps.fs.read(localConfig) : undefined;
  const loginNote = checkLogin(
    await deps.wrangler(['whoami', '--json']),
    existingCopy !== undefined && hasRoutes(existingCopy),
  );
  if (loginNote !== undefined) log(loginNote);

  if (backupPath !== undefined && deps.repoRoot !== undefined) {
    const rel = relative(resolve(deps.repoRoot), backupPath);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      log(
        `WARNING: ${opts.backupFile} is inside the repository. Only .env files are git-ignored: a different name could be committed. Prefer a path outside the repo.`,
      );
    }
  }

  // Before anything is generated: a backup file that can't be created must not cost the only copy of the secrets.
  if (backupPath !== undefined && deps.fs.exists(backupPath)) {
    throw new SetupError(`${opts.backupFile} already exists; choose a new --backup-file path`);
  }

  if (!deps.fs.exists(localConfig)) {
    const committed = deps.fs.read(join(deps.workerDir, 'wrangler.jsonc'));
    deps.fs.writeNew(localConfig, localConfigFor(committed, opts.name), 0o644);
    log(`Created ${localName} (git-ignored).`);
  } else {
    const wanted = localConfigFor(deps.fs.read(join(deps.workerDir, 'wrangler.jsonc')), opts.name);
    const current = existingCopy ?? deps.fs.read(localConfig);
    if (/"kv_namespaces"\s*:\s*\[[^\]]*"OAUTH_KV"/.test(current)) {
      log(
        `NOTE: ${localName} still declares the OAUTH_KV KV namespace, which relic-bridge no longer uses (P5-13). It is harmless; remove the "kv_namespaces" entry from the copy, and delete the namespace with \`wrangler kv namespace delete\` (see the upgrade note in docs/guide/cloudflare-deploy.md).`,
      );
    }
    const drift = configDrift(wanted, current);
    if (drift === undefined ? normalizeConfig(current) !== normalizeConfig(wanted) : drift.length > 0) {
      const what = drift === undefined ? '' : `: ${drift.join(', ')}`;
      log(
        `WARNING: ${localName} lacks or changes settings of wrangler.jsonc${what}. An update may have added a binding, cron or setting that this deploy will not include.`,
      );
      log(
        `  Copy them into ${localName} and keep its database_id. Your routes, workers_dev, vars and ids are not compared. (Deleting the copy loses your edits; the database stays bound by name.)`,
      );
    }
  }

  const have = new Set(await existingSecrets(opts, deps, cfg));
  let supplied: string | undefined;
  if (opts.masterKeyStdin) {
    if (have.has('RB_MASTER_KEY') && !opts.replaceMasterKey) {
      throw new SetupError(
        'This Worker already has RB_MASTER_KEY. Replacing it makes every New Relic key stored on this Worker undecryptable. ' +
          'For a migration into a Worker that holds no data yet, add --replace-master-key; otherwise leave the key as it is.',
      );
    }
    if (deps.readMasterKey === undefined)
      throw new SetupError('--master-key-stdin: no stdin to read the key from');
    const checked = checkMasterKey(await deps.readMasterKey());
    supplied = checked.key;
    log(`Read the existing master key (version ${checked.version}) from stdin.`);
  }
  const missing = wanted.filter((n) => !have.has(n) && !(n === 'RB_MASTER_KEY' && supplied !== undefined));
  if (supplied === undefined && missing.includes('RB_MASTER_KEY') && have.has('RB_ADMIN_TOKEN')) {
    if (!opts.replaceMasterKey) {
      throw new SetupError(
        'This Worker has RB_ADMIN_TOKEN but no RB_MASTER_KEY: a new master key would make every stored New Relic key undecryptable. ' +
          'Restore the original key (`wrangler secret put RB_MASTER_KEY`), or pass --replace-master-key to accept losing the stored credentials and re-add them.',
      );
    }
    log(
      'WARNING: --replace-master-key: stored New Relic keys will be undecryptable; re-add them with `credential add`.',
    );
  }
  // Asked before anything is generated or sent, so a mistyped answer costs nothing.
  const signIn = opts.signIn ? await collectSignIn(opts, deps, have) : undefined;
  const generated = generateSecrets(missing, deps.random);
  const toSend: Record<string, string> = {
    ...generated,
    ...(supplied === undefined ? {} : { RB_MASTER_KEY: supplied }),
    ...(signIn?.secrets ?? {}),
  };
  if (Object.keys(toSend).length > 0) {
    const r = await deps.wrangler(['secret', 'bulk', ...cfg], JSON.stringify(toSend));
    if (r.code !== 0) {
      throw new SetupError(
        `wrangler secret bulk failed (exit ${r.code}); nothing was deployed. ${firstLine(r.stderr)}`,
      );
    }
    log(`Set secrets: ${Object.keys(toSend).join(', ')}.`);
  }
  for (const n of wanted.filter((x) => have.has(x) && !(x === 'RB_MASTER_KEY' && supplied !== undefined))) {
    log(`Kept existing secret ${n} (not regenerated).`);
  }
  if (supplied !== undefined) {
    log(
      'RB_MASTER_KEY is the key you supplied: not shown and not written to the backup file. Keep the copy you already have.',
    );
  }

  // Reveal right after the secrets are set: if the deploy fails, a re-run keeps them and could not show them again.
  if (missing.length > 0) {
    deps.reveal('');
    deps.reveal('Shown ONCE. Save them in a password manager now; they are not stored anywhere else:');
    for (const n of missing) deps.reveal(`  ${n}=${generated[n]}`);
    if (missing.includes('RB_MASTER_KEY')) {
      deps.reveal('Losing RB_MASTER_KEY makes every stored New Relic key undecryptable.');
    }
    // After the reveal, so a failing write never loses the secrets; a failure is reported, not fatal.
    if (backupPath !== undefined) {
      const text = `${missing.map((n) => `${n}=${generated[n]}`).join('\n')}\n`;
      try {
        deps.fs.writeNew(backupPath, text, 0o600);
        log(
          `Wrote the new secrets to ${opts.backupFile} (mode 0600). Move it to a password manager, then delete it.`,
        );
      } catch (e) {
        log(
          `WARNING: could not write ${opts.backupFile} (${e instanceof Error ? e.message : String(e)}); copy the secrets shown above.`,
        );
      }
    }
  }

  // --keep-vars: without it Wrangler deletes every variable set in the dashboard (RB_ALLOWED_HOSTS, RB_AUDIT_*, …),
  // silently resetting an operator's security settings on each re-run.
  const deployArgs = ['deploy', ...cfg, '--keep-vars', '--var', `RB_PLAN:${opts.plan}`];
  if (opts.passthrough) deployArgs.push('--var', 'RB_PASSTHROUGH:on');
  if (opts.sharedLimiter !== undefined) deployArgs.push('--var', `RB_SHARED_LIMITER:${opts.sharedLimiter}`);
  for (const [k, v] of Object.entries(signIn?.vars ?? {})) deployArgs.push('--var', `${k}:${v}`);
  const dep = await deps.wrangler(deployArgs);
  if (dep.code !== 0)
    throw new SetupError(`wrangler deploy failed (exit ${dep.code}). ${firstLine(dep.stderr)}`);
  const urls = deployedUrls(`${dep.stdout}\n${dep.stderr}`);
  const url = urls[0];
  await recordDatabaseId(deps, localConfig, localName);

  log('');
  if (url === undefined) {
    log(
      `Deployed. Wrangler reported no URL: find it in the dashboard (Workers & Pages, ${opts.name}, Settings, Domains & Routes).`,
    );
  } else {
    log(`Deployed: ${urls.join(', ')}`);
  }
  log('The first request creates the database schema.');
  const remote = url ?? '<the Worker URL from the dashboard>';
  const cliBuilt =
    deps.repoRoot === undefined || deps.fs.exists(join(deps.repoRoot, 'apps', 'cli', 'dist', 'index.mjs'));
  log(
    `Next steps, from the repository root (with the CLI installed, \`relic-bridge\` replaces \`${CLI}\`; the admin token is read from RB_ADMIN_TOKEN or a prompt):`,
  );
  if (!cliBuilt) log('  pnpm --filter ./apps/cli build   # once: builds the CLI (pnpm install does not)');
  log(`  export RB_REMOTE=${remote}`);
  log(
    `  ${CLI} credential add --label main --region US   # your New Relic User API key: prompted, never a flag`,
  );
  log(`  ${CLI} project add ...  &&  ... grant create ...  &&  ... token create ...`);
  log('  (details: docs/guide/cloudflare-deploy.md and docs/guide/multi-device.md)');
  log(`  curl ${url === undefined ? '"$RB_REMOTE"' : remote}/health`);
  if (signIn !== undefined) {
    log('');
    log('Sign-in: register these redirect URLs with each provider (docs/guide/identity-providers.md):');
    for (const id of signIn.providers) log(`  ${signIn.publicUrl}/auth/callback/${id}`);
    log('Then issue the first owner link and open it in a browser:');
    log(`  ${CLI} setup-link --remote $RB_REMOTE`);
    if (url !== undefined && !urls.some((u) => new URL(u).origin === signIn.publicUrl)) {
      log(
        `  (RB_PUBLIC_URL is ${signIn.publicUrl}, which is not one of the deployed URLs: it must be the address browsers use.)`,
      );
    }
  }
  return { url };
}

const firstLine = (s: string): string => s.trim().split('\n').slice(-1)[0] ?? '';

/** Real runner: the Wrangler pinned in apps/worker, started with Node (no shell, so no quoting issues on Windows). */
export function realWrangler(workerDir: string): WranglerRunner {
  // `wrangler` does not export its bin path, so use the workspace symlink (pnpm) directly.
  const bin = join(workerDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!existsSync(bin)) throw new SetupError('Wrangler is not installed. Run `pnpm install` first.');
  return (args, input) =>
    new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, [bin, ...args], {
        cwd: workerDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
      child.stdin.on('error', () => undefined);
      child.stdin.end(input ?? '');
    });
}

/** A terminal question on stderr (stdout stays for the revealed secrets); `hidden` turns echo off. */
function ttyPrompt(hidden: boolean): (question: string) => Promise<string> {
  return (question) =>
    new Promise((resolveAnswer, reject) => {
      const stdin = process.stdin;
      process.stderr.write(question);
      let buf = '';
      const wasRaw = stdin.isRaw;
      if (hidden) stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      const done = (answer: string | Error): void => {
        stdin.off('data', onData);
        if (hidden) stdin.setRawMode(wasRaw);
        stdin.pause();
        if (hidden) process.stderr.write('\n');
        if (answer instanceof Error) reject(answer);
        else resolveAnswer(answer);
      };
      const onData = (chunk: string): void => {
        for (const ch of chunk) {
          if (ch === '\u0003') {
            done(new SetupError('cancelled'));
            return;
          }
          if (ch === '\r' || ch === '\n') {
            done(buf);
            return;
          }
          if (hidden && (ch === '\u007f' || ch === '\b')) buf = buf.slice(0, -1);
          else buf += ch;
        }
      };
      stdin.on('data', onData);
    });
}

/** All of stdin (a piped secret); at most 4 KiB, so a wrong pipe fails fast instead of buffering a file. */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += b.byteLength;
    if (size > 4096) throw new SetupError('--master-key-stdin: stdin is larger than a master key');
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<number> {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts === 'help') {
      process.stdout.write(HELP);
      return 0;
    }
    const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'worker');
    await runSetup(opts, {
      wrangler: realWrangler(workerDir),
      random: (n) => randomBytes(n),
      log: (l) => process.stderr.write(`${l}\n`),
      reveal: (l) => process.stdout.write(`${l}\n`),
      env: process.env,
      ...(process.stdin.isTTY ? { prompt: ttyPrompt(false), promptSecret: ttyPrompt(true) } : {}),
      ...(opts.masterKeyStdin
        ? {
            readMasterKey: process.stdin.isTTY
              ? () => ttyPrompt(true)('Master key of the server you are migrating from (hidden): ')
              : readAllStdin,
          }
        : {}),
      workerDir,
      repoRoot: resolve(workerDir, '..', '..'),
      fs: {
        exists: existsSync,
        read: (p) => readFileSync(p, 'utf8'),
        writeNew: (p, c, mode) => writeFileSync(p, c, { flag: 'wx', mode }),
        replace: (p, c) => writeFileSync(p, c),
      },
    });
    return 0;
  } catch (e) {
    if (e instanceof SetupError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
