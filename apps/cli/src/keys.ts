// SPDX-License-Identifier: Apache-2.0
// `relic-bridge keys generate | rotate` (ADR-0007, P2-03). Master keys come from the environment or a 0600 file,
// never from flags (T23), and are never written to stderr or logs (T8).
import { existsSync } from 'node:fs';
import {
  CryptoError,
  generateMasterKey,
  loadKeyringFromEnv,
  MASTER_KEY_ENV,
  PREVIOUS_MASTER_KEY_ENV,
  rotateCredentialKeys,
} from '@relic-bridge/auth';
import type { Logger } from '@relic-bridge/core';
import { ADMIN_TOKEN_ADVICE, checkAdminToken, describeAdminTokenProblem } from '@relic-bridge/http-app';
import { StorageError } from '@relic-bridge/storage';
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { ConfigError, type ConfigFs, type Env } from './config.ts';

/** A key file is a few dozen bytes; anything larger is not one. */
const MAX_KEY_FILE_BYTES = 1024;

/**
 * Resolve `RB_MASTER_KEY` / `RB_MASTER_KEY_PREVIOUS`, each from the variable or from `<NAME>_FILE`. A key file must
 * not be readable by group or others (POSIX; Windows relies on the profile ACL). Setting both forms is an error.
 */
export function resolveMasterKeyEnv(env: Env, fs: ConfigFs, platform: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [MASTER_KEY_ENV, PREVIOUS_MASTER_KEY_ENV]) {
    const direct = env[name]?.trim() ?? '';
    const file = env[`${name}_FILE`]?.trim() ?? '';
    if (direct !== '' && file !== '') {
      throw new ConfigError(`Both ${name} and ${name}_FILE are set.`, 'Set only one of them.');
    }
    if (direct !== '') out[name] = direct;
    else if (file !== '') out[name] = readKeyFile(`${name}_FILE`, file, fs, platform);
  }
  return out;
}

export function readKeyFile(variable: string, path: string, fs: ConfigFs, platform: string): string {
  let stat: ReturnType<ConfigFs['stat']>;
  try {
    stat = fs.stat(path);
  } catch {
    throw new ConfigError(`${variable}: ${path} not found or not readable.`);
  }
  if (!stat.isFile() || stat.size > MAX_KEY_FILE_BYTES) {
    throw new ConfigError(`${variable}: ${path} is not a key file.`);
  }
  if (platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new ConfigError(
      `${variable}: ${path} is readable by other users (mode ${(stat.mode & 0o777).toString(8)}).`,
      `Run: chmod 600 ${path}`,
    );
  }
  return fs.readFile(path).trim();
}

/** Sign-in client secrets that can also come from a `0600` file named by `<NAME>_FILE` (P4-09). */
export const IDP_SECRET_ENVS = [
  'RB_GOOGLE_CLIENT_SECRET',
  'RB_GITHUB_CLIENT_SECRET',
  'RB_OIDC_CLIENT_SECRET',
] as const;

/**
 * `env` with each sign-in client secret resolved from its `<NAME>_FILE` when that is set (same rules as the admin
 * token file: mode `0600`, one value, never both forms). The secret never leaves the returned copy.
 */
export function resolveIdpSecretEnv(env: Env, fs: ConfigFs, platform: string): Env {
  const out: Record<string, string | undefined> = { ...env };
  for (const name of IDP_SECRET_ENVS) {
    const direct = env[name]?.trim() ?? '';
    const file = env[`${name}_FILE`]?.trim() ?? '';
    if (direct !== '' && file !== '') {
      throw new ConfigError(`Both ${name} and ${name}_FILE are set.`, 'Set only one of them.');
    }
    if (file !== '') out[name] = readKeyFile(`${name}_FILE`, file, fs, platform);
  }
  return out;
}

export const ADMIN_TOKEN_ENV = 'RB_ADMIN_TOKEN';

/**
 * The bootstrap admin token (P2-09) from `RB_ADMIN_TOKEN` or a `0600` file named by `RB_ADMIN_TOKEN_FILE`, or
 * `undefined` when neither is set (the admin API stays off). A token that is too short, holds spaces or is predictable
 * (`checkAdminToken`, P3-13) is refused; the error never contains the token.
 */
export function resolveAdminToken(env: Env, fs: ConfigFs, platform: string): string | undefined {
  const direct = env[ADMIN_TOKEN_ENV]?.trim() ?? '';
  const file = env[`${ADMIN_TOKEN_ENV}_FILE`]?.trim() ?? '';
  if (direct !== '' && file !== '') {
    throw new ConfigError(
      `Both ${ADMIN_TOKEN_ENV} and ${ADMIN_TOKEN_ENV}_FILE are set.`,
      'Set only one of them.',
    );
  }
  const value =
    direct !== '' ? direct : file !== '' ? readKeyFile(`${ADMIN_TOKEN_ENV}_FILE`, file, fs, platform) : '';
  if (value === '') return undefined;
  const problem = checkAdminToken(value);
  if (problem !== null) {
    throw new ConfigError(
      `${ADMIN_TOKEN_ENV} is ${describeAdminTokenProblem(problem)}.`,
      `Use a random value of at least 32 printable characters without spaces. ${ADMIN_TOKEN_ADVICE}`,
    );
  }
  return value;
}

/** `keys generate`: the key goes to stdout only (pipe it into your secret store), guidance to stderr. */
export function keysGenerate(
  version: number,
  stdout: (text: string) => void,
  stderr: (line: string) => void,
): number {
  stdout(`${generateMasterKey(version)}\n`);
  stderr(
    `New master key (version ${version}) printed above. It is not stored anywhere: put it in your secret manager ` +
      `as ${MASTER_KEY_ENV} (or a 0600 file named by ${MASTER_KEY_ENV}_FILE) and keep a backup. ` +
      'Losing it means re-entering every New Relic key.',
  );
  return 0;
}

export interface KeysRotateOptions {
  readonly dbPath: string;
  readonly env: Env;
  readonly fs: ConfigFs;
  readonly platform: string;
  readonly stdout: (text: string) => void;
  readonly logger: Logger;
}

/** `keys rotate`: re-encrypt every credential under the current master key. Exit 0 when every row is current. */
export async function keysRotate(options: KeysRotateOptions): Promise<number> {
  const { logger } = options;
  try {
    const keyring = await loadKeyringFromEnv(resolveMasterKeyEnv(options.env, options.fs, options.platform));
    if (!existsSync(options.dbPath)) {
      logger.error('database not found', { path: options.dbPath });
      return 1;
    }
    const storage = await openSqliteStorage({ path: options.dbPath });
    let report: Awaited<ReturnType<typeof rotateCredentialKeys>>;
    try {
      report = await rotateCredentialKeys(storage, keyring);
    } finally {
      await storage.close();
    }
    for (const f of report.failed) {
      logger.warn('credential not rotated', { credential: f.id, code: f.code });
    }
    const done = report.failed.length === 0 && report.versionsInUse.every((v) => v === report.currentVersion);
    options.stdout(
      [
        `Master key version ${report.currentVersion}: ${report.reencrypted.length} re-encrypted, ` +
          `${report.alreadyCurrent} already current, ${report.failed.length} failed (of ${report.total}).`,
        done
          ? `Every credential uses version ${report.currentVersion}. You can now remove ${PREVIOUS_MASTER_KEY_ENV} (keep a backup of it until you have verified the server starts without it).`
          : `Versions still in use: ${report.versionsInUse.join(', ')}. Keep ${PREVIOUS_MASTER_KEY_ENV} set, fix the rows reported above, and run keys rotate again.`,
        '',
      ].join('\n'),
    );
    return done ? 0 : 1;
  } catch (error) {
    if (error instanceof CryptoError || error instanceof ConfigError) {
      logger.error(error.message, {
        ...(error instanceof CryptoError ? { code: error.code } : {}),
        ...(error.hint === undefined ? {} : { hint: error.hint }),
      });
      return 1;
    }
    if (error instanceof StorageError) {
      logger.error(error.message, { code: error.code });
      return 1;
    }
    throw error;
  }
}
