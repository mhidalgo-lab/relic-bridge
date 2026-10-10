// SPDX-License-Identifier: Apache-2.0
// Bounded purge of expired `kv` rows (P4-09), shared by the Worker's hourly cron and `serve`'s timer. Expired rows are
// invisible to every reader, so this only reclaims space (abandoned login transactions, unused setup links, ended
// sessions); it never changes behaviour. Each batch is one small DELETE, and a backlog beyond the budget is finished
// by the next run.
import type { KvRepository } from './types.ts';

export interface KvPurgeBudget {
  /** Rows per DELETE statement. */
  readonly batchRows: number;
  /** Statements per run. */
  readonly maxBatches: number;
  /** Wall-clock budget; no new batch starts after it. */
  readonly budgetMs: number;
}

/** 500-row batches, at most 10 per run (5,000 rows), 5 s: well inside the Free plan's 50 D1 queries per invocation. */
export const DEFAULT_KV_PURGE_BUDGET: KvPurgeBudget = Object.freeze({
  batchRows: 500,
  maxBatches: 10,
  budgetMs: 5_000,
});

export interface KvPurgeResult {
  readonly removed: number;
  readonly batches: number;
  /** False when the budget ran out before the backlog did. */
  readonly complete: boolean;
}

/** Deletes expired `kv` rows oldest-expiry first, within `budget`. Errors propagate to the caller to log. */
export async function purgeExpiredKv(
  kv: Pick<KvRepository, 'purgeExpired'>,
  budget: Partial<KvPurgeBudget> = {},
  now: () => number = Date.now,
): Promise<KvPurgeResult> {
  const b = { ...DEFAULT_KV_PURGE_BUDGET, ...budget };
  const started = now();
  let removed = 0;
  let batches = 0;
  while (batches < b.maxBatches && now() - started < b.budgetMs) {
    const n = await kv.purgeExpired(b.batchRows);
    batches++;
    removed += n;
    if (n < b.batchRows) return { removed, batches, complete: true };
  }
  return { removed, batches, complete: false };
}
