// SPDX-License-Identifier: Apache-2.0
import { CryptoError } from '@relic-bridge/auth';
import type { Logger } from '@relic-bridge/core';
import { StorageError } from '@relic-bridge/storage';
import { UsageError } from '../args.ts';
import { ConfigError } from '../config.ts';
import { KeychainError } from '../keychain.ts';
import { nerdGraphFetch } from '../test-hooks.ts';
import type { ManageArgs } from './args.ts';
import { type AdminClient, ApiError, parseRemoteUrl, remoteClient } from './client.ts';
import { adminTokenGenerate, HANDLERS, type Rec } from './commands.ts';
import { doctorCommand } from './doctor.ts';
import { initCommand } from './init.ts';
import type { ManageContext } from './io.ts';
import { keychainCommand } from './keychain.ts';
import { openLocalClient } from './local.ts';
import { readAdminToken } from './secrets.ts';

// ---------------------------------------------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------------------------------------------

const NEEDS_KEY = new Set(['credential add', 'credential rotate', 'credential revalidate']);
/** Local commands that need the sign-in settings (RB_PUBLIC_URL and the providers) from the environment. */
const NEEDS_SETUP_LINKS = new Set(['setup-link']);

/** Whether a command decrypts or encrypts stored keys (the master key is loaded and checked only then). */
function needsKey(args: ManageArgs): boolean {
  if (NEEDS_KEY.has(args.command)) return true;
  // Export seals stored keys only with --with-credentials; import creates credentials only when applying.
  if (args.command === 'config export') return args.values['with-credentials'] === true;
  if (args.command === 'config import') return args.values.apply === true;
  return false;
}

/** Remote when `--remote` / `RB_REMOTE` is given, otherwise the local database. */
export async function connect(
  ctx: ManageContext,
  args: ManageArgs,
  logger: Logger,
  forceLocal = false,
): Promise<AdminClient> {
  const remote = (args.values.remote ?? ctx.env['RB_REMOTE'] ?? '').trim();
  if (remote !== '' && !forceLocal) {
    if (args.values.db !== undefined) throw new UsageError('--db and --remote cannot be combined.');
    const url = parseRemoteUrl(remote, args.values.insecure === true);
    const token = await readAdminToken(ctx);
    return remoteClient(ctx.host, url, token);
  }
  if (args.values.insecure === true) throw new UsageError('--insecure only applies with --remote.');
  const fetch = ctx.host.nerdGraphFetch ?? nerdGraphFetch(ctx.env, logger);
  return openLocalClient({
    ctx,
    logger,
    ...(args.values.db === undefined ? {} : { db: args.values.db }),
    needsKey: needsKey(args),
    needsSetupLinks: NEEDS_SETUP_LINKS.has(args.command),
    ...(fetch === undefined ? {} : { nerdGraphFetch: fetch }),
  });
}

/** Run a parsed management command and return its exit code (0 ok, 1 failed, 2 usage). */
export async function runManage(ctx: ManageContext, args: ManageArgs, logger: Logger): Promise<number> {
  const json = args.values.json === true;
  const fail = (code: string, message: string, extra: Rec = {}): number => {
    ctx.stderr(json ? JSON.stringify({ error: { code, message, ...extra } }) : `error ${code}: ${message}`);
    return 1;
  };
  let client: AdminClient | undefined;
  try {
    if (args.command === 'admin-token generate') return adminTokenGenerate(ctx, json);
    if (args.command.startsWith('keychain ')) return await keychainCommand(ctx, args);
    if (args.command === 'doctor') return await doctorCommand(ctx, args, logger);
    if (args.command === 'init') return await initCommand(ctx, args, logger);
    client = await connect(ctx, args, logger);
    const handler = HANDLERS[args.command];
    if (handler === undefined) throw new UsageError(`Unknown command "${args.command}".`);
    return await handler({ ctx, args, client, json });
  } catch (error) {
    if (error instanceof UsageError) {
      ctx.stderr(`relic-bridge: ${error.message}`);
      return 2;
    }
    if (error instanceof ApiError) {
      const hint = hintFor(error);
      return fail(
        error.code,
        `${error.message}${error.field ? ` (${error.field})` : ''}${error.detail ? ` [${error.detail}]` : ''}${hint ? `. ${hint}` : ''}`,
        { status: error.status },
      );
    }
    if (error instanceof ConfigError) {
      return fail('config', `${error.message}${error.hint ? ` ${error.hint}` : ''}`);
    }
    if (error instanceof KeychainError) {
      return fail('keychain', `${error.message}${error.hint ? ` ${error.hint}` : ''}`);
    }
    if (error instanceof CryptoError) return fail(error.code, error.message);
    if (error instanceof StorageError) return fail(error.code, error.message);
    throw error;
  } finally {
    await client?.close();
  }
}

function hintFor(error: ApiError): string {
  switch (error.status) {
    case 401:
      return 'Check the admin token (RB_ADMIN_TOKEN) and that the server was started with the same one';
    case 413:
      return 'The file is larger than the server accepts (64 KiB by default); split it or trim unused entries';
    case 404:
      return error.code === 'not_found'
        ? ''
        : 'Is the admin API enabled on that server (RB_ADMIN_TOKEN set)?';
    case 429:
      return 'Too many requests; wait and retry';
    case 502:
      return 'New Relic could not be reached; nothing was changed. Retry later';
    default:
      return '';
  }
}
