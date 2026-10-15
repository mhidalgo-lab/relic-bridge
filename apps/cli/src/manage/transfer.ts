// SPDX-License-Identifier: Apache-2.0
// `relic-bridge config export | import` (P7-06): move projects, grants, users and settings between a local database,
// Docker and a Worker. Both commands go through the Admin API (owner only), locally in-process or with --remote.
//
// The passphrase never leaves this process: the PBKDF2 derivation (600 000 iterations) runs here and only the derived
// wrap key is sent. The file is YAML, created exclusively with mode 0600; a keys-free export holds no secrets but is
// written the same way. Import reads YAML or JSON, with aliases refused and a size cap.
import { checkPassphrase, deriveWrapKey, newKdf } from '@relic-bridge/auth';
import { CONFIG_IMPORT_MAX_BYTES } from '@relic-bridge/http-app';
import { parse, stringify, YAMLError } from 'yaml';
import { UsageError } from '../args.ts';
import { ConfigError } from '../config.ts';
import { readKeyFile } from '../keys.ts';
import type { ManageValues } from './args.ts';
import { api } from './client.ts';
import { type Rec, type Run, rec, str, warn } from './commands.ts';
import type { ManageContext } from './io.ts';
import { plain } from './render.ts';

/**
 * Largest file `import` reads, and the largest request it sends: the Admin API's cap for `POST /config/import`
 * (P8-74), so a file the CLI accepts is never refused by the server for its size.
 */
const MAX_IMPORT_BYTES = CONFIG_IMPORT_MAX_BYTES;
const tooLarge = (what: string): ConfigError =>
  new ConfigError(
    `${what} is larger than ${MAX_IMPORT_BYTES} bytes (1 MiB), the config import limit.`,
    'Split the configuration into smaller files and import each one; import is idempotent.',
  );
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

/**
 * The passphrase: `--passphrase-file <path>` (mode 0600), `--passphrase-env <NAME>` (the variable's name), or a hidden
 * prompt on a terminal (asked twice when `confirm`). `null` when none is available and `optional`.
 */
export async function readPassphrase(
  ctx: ManageContext,
  values: ManageValues,
  options: { readonly confirm: boolean; readonly optional: boolean; readonly prompt: string },
): Promise<string | null> {
  const file = values['passphrase-file'];
  const envName = values['passphrase-env'];
  if (file !== undefined && envName !== undefined) {
    throw new UsageError('Use only one of --passphrase-file and --passphrase-env.');
  }
  let passphrase: string;
  if (file !== undefined) {
    passphrase = readKeyFile('--passphrase-file', file, ctx.fs, ctx.platform);
  } else if (envName !== undefined) {
    if (!ENV_NAME_RE.test(envName)) {
      throw new ConfigError('--passphrase-env takes the NAME of an environment variable.');
    }
    passphrase = (ctx.env[envName] ?? '').trim();
    if (passphrase === '') throw new ConfigError(`${envName} is not set.`);
  } else if (ctx.host.stdinIsTTY) {
    passphrase = (await ctx.host.promptSecret(options.prompt)).trim();
    if (passphrase === '' && options.optional) return null;
    if (
      options.confirm &&
      passphrase !== (await ctx.host.promptSecret('Repeat the passphrase (hidden): ')).trim()
    ) {
      throw new ConfigError('The passphrases do not match.');
    }
  } else if (options.optional) {
    return null;
  } else {
    throw new ConfigError(
      'No passphrase for the encrypted keys.',
      'Use --passphrase-file <file> (mode 0600) or --passphrase-env <NAME>; a passphrase is never an option value.',
    );
  }
  try {
    checkPassphrase(passphrase);
  } catch {
    throw new ConfigError(
      'The passphrase is too short.',
      'Use at least 12 characters (a few random words work well).',
    );
  }
  return passphrase;
}

// ---------------------------------------------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------------------------------------------

const EXPORT_HEADER =
  '# relic-bridge configuration (P7-06). Import with `relic-bridge config import <file>`.\n' +
  '# Holds no access tokens or sessions. New Relic keys appear only in `secrets`, encrypted under the passphrase.\n';

export async function configExport(run: Run): Promise<number> {
  const { ctx, args, client, json } = run;
  const out = args.values.out;
  if (out === undefined) throw new UsageError('config export needs --out <file> (created with mode 0600).');
  const withCredentials = args.values['with-credentials'] === true;
  if (
    !withCredentials &&
    (args.values['passphrase-file'] !== undefined || args.values['passphrase-env'] !== undefined)
  ) {
    throw new UsageError('A passphrase only applies with --with-credentials.');
  }
  let body: Rec = {};
  if (withCredentials) {
    const passphrase = await readPassphrase(ctx, args.values, {
      confirm: true,
      optional: false,
      prompt: 'Passphrase to encrypt the New Relic keys (hidden, 12+ characters): ',
    });
    const kdf = newKdf();
    body = { wrapKey: toBase64(await deriveWrapKey(passphrase as string, kdf)), kdf };
  }
  const result = rec(await api(client, 'POST', '/config/export', { body }));
  const bundle = rec(result['data']);
  const text = EXPORT_HEADER + stringify(bundle, { lineWidth: 0 });
  try {
    ctx.host.writeSecretFile(out, text);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'EEXIST') {
      throw new ConfigError(
        `${out} already exists; nothing was written.`,
        'Choose another --out or remove the file.',
      );
    }
    throw new ConfigError(`Could not write ${out} (${code ?? 'error'}).`);
  }
  const count = (k: string): number => (Array.isArray(bundle[k]) ? (bundle[k] as unknown[]).length : 0);
  if (json) {
    ctx.stdout(
      `${JSON.stringify({ file: out, users: count('users'), credentials: count('credentials'), projects: count('projects'), grants: count('grants'), withCredentials })}\n`,
    );
  } else {
    warn(run, result['warnings']);
    ctx.stdout(
      `Wrote ${plain(out)} (mode 0600): ${count('users')} users, ${count('credentials')} credentials, ` +
        `${count('projects')} projects, ${count('grants')} grants.\n`,
    );
    ctx.stderr(
      withCredentials
        ? 'The New Relic keys in the file are encrypted with your passphrase (PBKDF2 + AES-256-GCM). Keep the passphrase ' +
            'out of the file and out of version control.'
        : 'No New Relic keys were exported: add them on the target with `credential add`, or export with --with-credentials.',
    );
    ctx.stderr('Access tokens are never exported: create new ones on the target with `token create`.');
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------------------------------------------

function readBundle(ctx: ManageContext, path: string): Rec {
  let stat: ReturnType<ManageContext['fs']['stat']>;
  try {
    stat = ctx.fs.stat(path);
  } catch {
    throw new ConfigError(`${path} not found or not readable.`);
  }
  if (!stat.isFile()) throw new ConfigError(`${path} is not a file.`);
  if (stat.size > MAX_IMPORT_BYTES) throw tooLarge(path);
  let text: string;
  try {
    text = ctx.fs.readFile(path);
  } catch {
    throw new ConfigError(`${path} could not be read.`);
  }
  let parsed: unknown;
  try {
    // No aliases (entity-expansion attacks), no duplicate keys; the core schema has no executable tags.
    parsed = parse(text, { maxAliasCount: 0, uniqueKeys: true, strict: true });
  } catch (error) {
    // The parser's message quotes the offending line: say where, never what.
    const line = error instanceof YAMLError ? error.linePos?.[0]?.line : undefined;
    throw new ConfigError(`${path} is not valid YAML${line === undefined ? '' : ` (line ${line})`}.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${path} is not a relic-bridge configuration file.`);
  }
  if (ctx.platform !== 'win32' && (stat.mode & 0o077) !== 0 && (parsed as Rec)['secrets'] !== undefined) {
    ctx.stderr(
      `warning: ${path} holds encrypted keys and is readable by other users; run: chmod 600 ${path}`,
    );
  }
  return parsed as Rec;
}

const ORDER: readonly string[] = ['user', 'credential', 'project', 'grant', 'setting'];

export async function configImport(run: Run): Promise<number> {
  const { ctx, args, client, json } = run;
  const path = args.positionals[0] as string;
  const apply = args.values.apply === true;
  const bundle = readBundle(ctx, path);
  const secrets = rec(bundle['secrets']);
  let wrapKey: string | undefined;
  if (bundle['secrets'] !== undefined) {
    const passphrase = await readPassphrase(ctx, args.values, {
      confirm: false,
      optional: true,
      prompt: 'Passphrase for the encrypted keys (hidden; empty to skip them): ',
    });
    if (passphrase !== null) {
      const kdf = rec(secrets['kdf']);
      try {
        wrapKey = toBase64(
          await deriveWrapKey(passphrase, {
            name: kdf['name'] as 'pbkdf2-sha256',
            iterations: kdf['iterations'] as number,
            salt: str(kdf['salt']),
          }),
        );
      } catch {
        throw new ConfigError(`${path}: the encrypted keys use unsupported key-derivation settings.`);
      }
    }
  } else if (args.values['passphrase-file'] !== undefined || args.values['passphrase-env'] !== undefined) {
    ctx.stderr('warning: the file holds no encrypted keys; the passphrase is not needed.');
  }
  const body = { bundle, ...(apply ? { apply: true } : {}), ...(wrapKey === undefined ? {} : { wrapKey }) };
  // YAML can be shorter than the JSON request it becomes: check what is sent, too.
  if (new TextEncoder().encode(JSON.stringify(body)).length > MAX_IMPORT_BYTES) {
    throw tooLarge(`The import request built from ${path}`);
  }
  const result = rec(await api(client, 'POST', '/config/import', { body }));
  const data = rec(result['data']);
  const failed = data['failed'] === null || data['failed'] === undefined ? null : rec(data['failed']);
  if (json) {
    ctx.stdout(`${JSON.stringify(result)}\n`);
    return failed === null ? 0 : 1;
  }
  const entries = (Array.isArray(data['entries']) ? data['entries'] : []).map(rec);
  const lines: string[] = [];
  for (const kind of ORDER) {
    for (const e of entries.filter((x) => x['kind'] === kind)) {
      const action = str(e['action']);
      if (action === 'unchanged') continue;
      const fields =
        Array.isArray(e['fields']) && e['fields'].length > 0 ? ` (${e['fields'].map(plain).join(', ')})` : '';
      const reason = e['reason'] === undefined ? '' : `: ${plain(e['reason'])}`;
      lines.push(`${action.padEnd(7)} ${kind.padEnd(10)} ${plain(e['key'])}${fields}${reason}`);
    }
  }
  const s = rec(data['summary']);
  ctx.stdout(
    `${lines.length === 0 ? 'Nothing to change.\n' : `${lines.join('\n')}\n`}` +
      `${apply ? 'Applied' : 'Dry run (nothing changed)'}: ${Number(s['create'])} to create, ${Number(s['update'])} to update, ` +
      `${Number(s['unchanged'])} unchanged, ${Number(s['skip'])} skipped.\n`,
  );
  warn(run, data['warnings']);
  if (failed !== null) {
    ctx.stderr(
      `error ${plain(failed['code'])}: stopped at ${plain(failed['kind'])} ${plain(failed['key'])}: ${plain(failed['message'])}. ` +
        'Everything before it was applied; fix the cause and import again to resume.',
    );
    return 1;
  }
  if (!apply) ctx.stderr('Review the changes above, then run again with --apply.');
  return 0;
}
