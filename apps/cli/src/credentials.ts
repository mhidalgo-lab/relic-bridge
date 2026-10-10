// SPDX-License-Identifier: Apache-2.0
// `relic-bridge credential revalidate` (P2-04): re-check every stored New Relic key so one revoked in New Relic stops
// granting access (marked `invalid`, every grant using it fails closed). Run it by hand or from cron.
import { existsSync } from 'node:fs';
import {
  CryptoError,
  loadKeyringFromEnv,
  nerdGraphKeyValidator,
  revalidateCredentials,
  verifyKeyChecks,
} from '@relic-bridge/auth';
import type { FetchLike, Logger } from '@relic-bridge/core';
import { StorageError } from '@relic-bridge/storage';
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { ConfigError, type ConfigFs, type Env } from './config.ts';
import { resolveMasterKeyEnv } from './keys.ts';

export interface CredentialRevalidateOptions {
  readonly dbPath: string;
  readonly env: Env;
  readonly fs: ConfigFs;
  readonly platform: string;
  readonly stdout: (text: string) => void;
  readonly logger: Logger;
  /** NerdGraph fetch override (tests). */
  readonly fetch?: FetchLike;
}

/**
 * Exit 0 when every live credential was confirmed valid; 1 when any was refused by New Relic or could not be checked
 * (so cron can alert). Prints ids, outcomes and error codes only, never keys.
 */
export async function credentialRevalidate(options: CredentialRevalidateOptions): Promise<number> {
  const { logger } = options;
  try {
    const keyring = await loadKeyringFromEnv(resolveMasterKeyEnv(options.env, options.fs, options.platform));
    if (!existsSync(options.dbPath)) {
      logger.error('database not found', { path: options.dbPath });
      return 1;
    }
    const storage = await openSqliteStorage({ path: options.dbPath });
    let results: Awaited<ReturnType<typeof revalidateCredentials>>;
    try {
      // A wrong master key must fail here, not be mistaken for a batch of broken credentials.
      await verifyKeyChecks(storage, keyring, { register: false });
      results = await revalidateCredentials({
        storage,
        keyring,
        validate: nerdGraphKeyValidator({
          logger,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }),
      });
    } finally {
      await storage.close();
    }
    const count = (o: string) => results.filter((r) => r.outcome === o).length;
    for (const r of results) {
      if (r.outcome === 'invalid') {
        logger.warn('credential refused by New Relic; grants using it now fail closed', {
          credential: r.id,
          code: r.code,
        });
      } else if (r.outcome === 'error') {
        logger.warn('credential not checked; status unchanged', { credential: r.id, code: r.code });
      } else if (r.outcome === 'valid' && (r.accountsAdded.length > 0 || r.accountsRemoved.length > 0)) {
        logger.info('credential reachable accounts changed', {
          credential: r.id,
          added: r.accountsAdded,
          removed: r.accountsRemoved,
        });
      }
    }
    options.stdout(
      `Checked ${results.length} credential(s): ${count('valid')} valid, ${count('invalid')} invalid, ` +
        `${count('error')} not checked, ${count('skipped')} skipped.\n`,
    );
    return count('invalid') + count('error') === 0 ? 0 : 1;
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
