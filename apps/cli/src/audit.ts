// SPDX-License-Identifier: Apache-2.0
// `relic-bridge audit purge` (P2-08): delete audit rows past the retention period. Needs no master key: the audit log
// holds no secrets. Run it by hand or from cron; `serve` also purges at startup and hourly.
import { existsSync } from 'node:fs';
import type { Logger } from '@relic-bridge/core';
import { createAuditRecorder } from '@relic-bridge/http-app';
import { StorageError } from '@relic-bridge/storage';
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { OLDER_THAN_DAYS_USAGE, parseOlderThanDays } from './args.ts';
import { ConfigError, type Env } from './config.ts';

export const DEFAULT_RETENTION_DAYS = 90;

/** `RB_AUDIT_RETENTION_DAYS`: whole days; `0` keeps everything. */
export function parseRetentionDays(raw: string | undefined): number {
  const v = raw?.trim();
  if (v === undefined || v === '') return DEFAULT_RETENTION_DAYS;
  if (!/^\d{1,5}$/.test(v)) {
    throw new ConfigError('RB_AUDIT_RETENTION_DAYS must be a whole number of days (0 keeps everything).');
  }
  return Number(v);
}

export interface AuditPurgeOptions {
  readonly dbPath: string;
  readonly env: Env;
  /** `--older-than-days`; overrides RB_AUDIT_RETENTION_DAYS. Re-validated here (exit 2 when invalid). */
  readonly olderThanDays?: string;
  readonly stdout: (text: string) => void;
  readonly logger: Logger;
}

export async function auditPurge(options: AuditPurgeOptions): Promise<number> {
  const { logger } = options;
  // Defence in depth (P8-74): the parser already checks the flag, but a caller that skips it must not reach the
  // purge with NaN, a fraction or a negative number.
  let olderThan: number | undefined;
  if (options.olderThanDays !== undefined) {
    olderThan = parseOlderThanDays(options.olderThanDays);
    if (olderThan === undefined) {
      logger.error(OLDER_THAN_DAYS_USAGE);
      return 2;
    }
  }
  try {
    const days = olderThan ?? parseRetentionDays(options.env['RB_AUDIT_RETENTION_DAYS']);
    if (days <= 0) {
      options.stdout('Retention is 0 (keep everything): nothing purged.\n');
      return 0;
    }
    if (!existsSync(options.dbPath)) {
      logger.error('database not found', { path: options.dbPath });
      return 1;
    }
    const storage = await openSqliteStorage({ path: options.dbPath });
    try {
      const recorder = createAuditRecorder({ storage, logger });
      const removed = await recorder.purge(days);
      // The purge itself is an administrative action worth a row (who removed history, and how much).
      await recorder.admin({
        actor: {},
        action: 'audit.purge',
        targetType: 'audit_log',
        details: { removed, olderThanDays: days, source: 'cli' },
      });
      options.stdout(`Deleted ${removed} audit row(s) older than ${days} day(s).\n`);
    } finally {
      await storage.close();
    }
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error(error.message, error.hint === undefined ? {} : { hint: error.hint });
      return 1;
    }
    if (error instanceof StorageError) {
      logger.error(error.message, { code: error.code });
      return 1;
    }
    throw error;
  }
}
