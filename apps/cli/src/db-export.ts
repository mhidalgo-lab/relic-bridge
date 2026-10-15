// SPDX-License-Identifier: Apache-2.0
// `relic-bridge db export <file> --format d1` (P8-80): the server's database as a SQL file for the Worker's D1 database.
// Needs no master key: stored keys stay encrypted, tokens stay hashed (packages/storage-sqlite/src/d1-export.ts).
import { dirname, resolve } from 'node:path';
import { type Logger, VERSION } from '@relic-bridge/core';
import { StorageError } from '@relic-bridge/storage';
import { exportForD1 } from '@relic-bridge/storage-sqlite';
import type { Env } from './config.ts';

/** D1 rows written a day on Workers Free (the import counts; so do index entries). */
export const D1_FREE_DAILY_ROWS_WRITTEN = 100_000;

export interface DbExportOptions {
  readonly dbPath: string;
  readonly file: string;
  readonly includeAudit: boolean;
  readonly force: boolean;
  readonly env: Env;
  readonly stdout: (text: string) => void;
  readonly logger: Logger;
  readonly now?: () => number;
}

/**
 * THREAT_MODEL T7: the export holds credential ciphertext; the master key that decrypts it must never sit in the same
 * directory (a copy of one would then carry the other).
 */
function keyFileNextTo(file: string, env: Env): string | undefined {
  const dir = dirname(resolve(file));
  for (const name of ['RB_MASTER_KEY_FILE', 'RB_MASTER_KEY_PREVIOUS_FILE']) {
    const keyFile = env[name]?.trim();
    if (keyFile && dirname(resolve(keyFile)) === dir) return name;
  }
  return undefined;
}

export async function dbExport(options: DbExportOptions): Promise<number> {
  const { logger } = options;
  const sameDir = keyFileNextTo(options.file, options.env);
  if (sameDir !== undefined) {
    logger.error('refusing to write the export next to the master key', {
      hint: `${sameDir} is in the same directory. The export holds encrypted New Relic keys: write it somewhere else.`,
    });
    return 1;
  }
  let summary: Awaited<ReturnType<typeof exportForD1>>;
  try {
    summary = await exportForD1(options.dbPath, options.file, {
      includeAudit: options.includeAudit,
      force: options.force,
      version: VERSION,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  } catch (error) {
    if (error instanceof StorageError) {
      logger.error(error.message, { code: error.code });
      return 1;
    }
    throw error;
  }
  const counts = Object.entries(summary.rows)
    .map(([table, n]) => `${table} ${n}`)
    .join(', ');
  const out = options.stdout;
  out(`Exported ${options.dbPath} to ${options.file} (mode 0600, ${Math.ceil(summary.bytes / 1024)} KiB).\n`);
  out(`Rows: ${counts}.\n`);
  out(
    `Left out: ${summary.excluded.join(', ')} (sessions, sign-in and OAuth connections${
      summary.excluded.includes('audit_log') ? ', and the audit log' : ''
    }; they stay on this server).\n`,
  );
  if (summary.masterKeyVersion !== null) {
    out(
      `The Worker must run with this server's master key (version ${summary.masterKeyVersion}): ` +
        'pnpm cf:setup --master-key-stdin. Never let it generate a new one for this database.\n',
    );
  }
  out("Import into the NEW Worker's D1 database, then delete this file:\n");
  out(`  wrangler d1 execute <database> --remote --file ${options.file}\n`);
  out('See "Migrate from a self-hosted server" in docs/guide/cloudflare-deploy.md.\n');
  if (summary.credentialKeyVersions.length > 1) {
    logger.warn('stored New Relic keys use more than one master key version', {
      versions: summary.credentialKeyVersions.join(','),
      hint: 'Finish `relic-bridge keys rotate` before exporting, or also give the Worker the older key as RB_MASTER_KEY_PREVIOUS.',
    });
  }
  if (summary.rowsWritten > D1_FREE_DAILY_ROWS_WRITTEN / 2) {
    logger.warn('the import writes many D1 rows', {
      rowsWritten: summary.rowsWritten,
      hint: `Workers Free allows ${D1_FREE_DAILY_ROWS_WRITTEN} rows written a day. Purge old audit rows (audit purge) or export with --no-audit.`,
    });
  }
  return 0;
}
