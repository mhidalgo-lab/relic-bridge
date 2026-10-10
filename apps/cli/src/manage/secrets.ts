// SPDX-License-Identifier: Apache-2.0
// Where the CLI reads secrets from. Never from an argument value: process lists and shell history leak those (T23).
import { ConfigError } from '../config.ts';
import { readKeyFile, resolveAdminToken } from '../keys.ts';
import type { ManageValues } from './args.ts';
import type { ManageContext } from './io.ts';

const MAX_SECRET_CHARS = 512;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function checked(value: string, what: string): string {
  const v = value.trim();
  if (v === '') throw new ConfigError(`No ${what} was given.`);
  if (v.length > MAX_SECRET_CHARS || /\s/.test(v)) {
    throw new ConfigError(`The ${what} is not valid (one token without spaces).`);
  }
  return v;
}

/**
 * A New Relic User key: `--key-file <path>` (mode 0600), `--key-env <VAR>` (the variable's name, not its value),
 * a hidden prompt on a terminal, or stdin when piped. The value is returned to the caller and never logged.
 */
export async function readNewRelicKey(ctx: ManageContext, values: ManageValues): Promise<string> {
  const file = values['key-file'];
  const envName = values['key-env'];
  if (file !== undefined && envName !== undefined) {
    throw new ConfigError('Use only one of --key-file and --key-env.');
  }
  if (file !== undefined)
    return checked(readKeyFile('--key-file', file, ctx.fs, ctx.platform), 'key in the file');
  if (envName !== undefined) {
    if (!ENV_NAME_RE.test(envName))
      throw new ConfigError('--key-env takes the NAME of an environment variable.');
    return checked(ctx.env[envName] ?? '', `key in ${envName}`);
  }
  if (ctx.host.stdinIsTTY)
    return checked(await ctx.host.promptSecret('New Relic User API key (hidden): '), 'key');
  let text: string;
  try {
    text = await ctx.host.readStdin(4096);
  } catch {
    throw new ConfigError('The key on stdin is too long.');
  }
  return checked(text.split(/\r?\n/, 1)[0] ?? '', 'key on stdin');
}

/** The admin token for a remote instance: `RB_ADMIN_TOKEN` / `RB_ADMIN_TOKEN_FILE`, else a hidden prompt. */
export async function readAdminToken(ctx: ManageContext): Promise<string> {
  const configured = resolveAdminToken(ctx.env, ctx.fs, ctx.platform);
  if (configured !== undefined) return configured;
  if (ctx.host.stdinIsTTY)
    return checked(await ctx.host.promptSecret('Admin token (hidden): '), 'admin token');
  throw new ConfigError(
    'No admin token for the remote instance.',
    'Set RB_ADMIN_TOKEN, or RB_ADMIN_TOKEN_FILE (a file with mode 0600). It is never accepted as a flag.',
  );
}
