// SPDX-License-Identifier: Apache-2.0
// Per-grant usage counters (P7-12): period keys, row rules and the SQL shared by the SQLite and D1 adapters, so both run
// the same statements. Every statement is one write (or one bounded read), which is what makes the counters atomic on
// D1 (no interactive transactions) and keeps `reserve` from ever exceeding a cap.
import { InvalidInputError } from './errors.ts';
import type { StoredQuota, StoredQuotaPeriod, UsageCounters } from './types.ts';

export const USAGE_MAX_GRANTS = 50;
export const USAGE_MAX_PERIODS = 4;
export const USAGE_PURGE_DEFAULT = 1000;
/** Counter rows not updated for this long are housekeeping material: far longer than any dashboard looks back. */
export const USAGE_RETENTION_MS = 120 * 86_400_000;
/** Largest cap a quota may name (JSON numbers stay exact below 2^53). */
export const QUOTA_MAX = 1_000_000_000_000_000;
export const QUOTA_DEFAULT_WARN_PERCENT = 80;

/** `d2026-10-06` (a UTC day) or `m2026-10` (a UTC month). */
export const PERIOD_RE: RegExp = /^(?:d\d{4}-\d{2}-\d{2}|m\d{4}-\d{2})$/;

export type QuotaPeriodName = 'day' | 'month';

/** The period keys of the UTC day and month containing `ts` (epoch ms). */
export function usagePeriods(ts: number): { readonly day: string; readonly month: string } {
  const iso = new Date(ts).toISOString();
  return { day: `d${iso.slice(0, 10)}`, month: `m${iso.slice(0, 7)}` };
}

/** When the period containing `ts` ends (epoch ms): the next UTC midnight or the first of the next UTC month. */
export function periodResetsAt(name: QuotaPeriodName, ts: number): number {
  const d = new Date(ts);
  return name === 'day'
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
    : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export function checkPeriods(periods: readonly string[]): void {
  if (
    periods.length === 0 ||
    periods.length > USAGE_MAX_PERIODS ||
    !periods.every((p) => PERIOD_RE.test(p))
  ) {
    throw new InvalidInputError('grant_usage.period');
  }
}

export function checkPeriod(period: string): void {
  if (!PERIOD_RE.test(period)) throw new InvalidInputError('grant_usage.period');
}

export function checkUsageCount(n: number, field: string): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new InvalidInputError(field);
}

const isCap = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= QUOTA_MAX;

function periodShapeOk(p: unknown): p is StoredQuotaPeriod {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return false;
  const keys = Object.keys(p);
  if (keys.length === 0 || keys.some((k) => k !== 'queries' && k !== 'inspectedEvents')) return false;
  const o = p as Record<string, unknown>;
  return (
    (o['queries'] === undefined || isCap(o['queries'])) &&
    (o['inspectedEvents'] === undefined || isCap(o['inspectedEvents']))
  );
}

/** Whether `v` is a well-formed quota: only `day`, `month`, `warnPercent`; each period names at least one cap. */
export function isStoredQuota(v: unknown): v is StoredQuota {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== 'day' && k !== 'month' && k !== 'warnPercent')) return false;
  if (o['day'] === undefined && o['month'] === undefined) return false;
  if (o['day'] !== undefined && !periodShapeOk(o['day'])) return false;
  if (o['month'] !== undefined && !periodShapeOk(o['month'])) return false;
  const w = o['warnPercent'];
  return w === undefined || (Number.isSafeInteger(w) && (w as number) >= 1 && (w as number) <= 99);
}

/** A copy of a valid quota with only its known fields. */
export function cloneQuota(q: StoredQuota): StoredQuota {
  const period = (p: StoredQuotaPeriod | undefined): StoredQuotaPeriod | undefined =>
    p === undefined
      ? undefined
      : {
          ...(p.queries === undefined ? {} : { queries: p.queries }),
          ...(p.inspectedEvents === undefined ? {} : { inspectedEvents: p.inspectedEvents }),
        };
  const day = period(q.day);
  const month = period(q.month);
  return {
    ...(day === undefined ? {} : { day }),
    ...(month === undefined ? {} : { month }),
    ...(q.warnPercent === undefined ? {} : { warnPercent: q.warnPercent }),
  };
}

export const ZERO_USAGE: UsageCounters = Object.freeze({ queries: 0, inspected: 0 });

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : 0);

export function usageOf(r: Readonly<Record<string, unknown>> | null | undefined): UsageCounters {
  return r === null || r === undefined
    ? ZERO_USAGE
    : Object.freeze({ queries: num(r['queries']), inspected: num(r['inspected']) });
}

/** Parameters: grant id, period, now, cap, cap. The conditional `WHERE` makes the cap exact; no row back = refused. */
export const USAGE_RESERVE_SQL =
  'INSERT INTO grant_usage (grant_id, period, queries, inspected, updated_at) VALUES (?, ?, 1, 0, ?) ' +
  'ON CONFLICT(grant_id, period) DO UPDATE SET queries = queries + 1, updated_at = excluded.updated_at ' +
  'WHERE ? IS NULL OR queries < ? RETURNING queries, inspected';

/** Parameters: now, grant id, period. */
export const USAGE_RELEASE_SQL =
  'UPDATE grant_usage SET queries = MAX(queries - 1, 0), updated_at = ? WHERE grant_id = ? AND period = ?';

/** Parameters: grant id, period, events, now. */
export const USAGE_ADD_INSPECTED_SQL =
  'INSERT INTO grant_usage (grant_id, period, queries, inspected, updated_at) VALUES (?, ?, 0, ?, ?) ' +
  'ON CONFLICT(grant_id, period) DO UPDATE SET inspected = inspected + excluded.inspected, ' +
  'updated_at = excluded.updated_at RETURNING queries, inspected';

/** The statement and parameters reading the counters of `grantIds` x `periods` (bounded: 50 x 4 = 54 parameters). */
export function usageGetSql(
  grantIds: readonly string[],
  periods: readonly string[],
): { sql: string; params: string[] } {
  if (grantIds.length > USAGE_MAX_GRANTS) throw new InvalidInputError('grant_usage.grants');
  checkPeriods(periods);
  const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ');
  return {
    sql:
      'SELECT grant_id, period, queries, inspected FROM grant_usage ' +
      `WHERE grant_id IN (${marks(grantIds.length)}) AND period IN (${marks(periods.length)})`,
    params: [...grantIds, ...periods],
  };
}

/** Parameters: before, limit. */
export const USAGE_PURGE_SQL =
  'DELETE FROM grant_usage WHERE rowid IN (SELECT rowid FROM grant_usage WHERE updated_at < ? ORDER BY updated_at LIMIT ?)';

/** Groups result rows of `usageGetSql` into `{ grantId: { period: counters } }`. */
export function groupUsage(
  rows: readonly Readonly<Record<string, unknown>>[],
): Record<string, Record<string, UsageCounters>> {
  const out: Record<string, Record<string, UsageCounters>> = {};
  for (const r of rows) {
    const g = r['grant_id'];
    const p = r['period'];
    if (typeof g !== 'string' || typeof p !== 'string') continue;
    out[g] = { ...out[g], [p]: usageOf(r) };
  }
  return out;
}

// The same counters inside a Workers Durable Object's SQLite storage (one object per grant, so no `grant_id` column).
// Kept here with the other SQL (`apps/worker` holds none): every statement is bound parameters only.

export const QUOTA_OBJECT_DDL =
  'CREATE TABLE IF NOT EXISTS usage (period TEXT PRIMARY KEY, queries INTEGER NOT NULL, inspected INTEGER NOT NULL)';
/** Parameters: period, cap, cap. */
export const QUOTA_OBJECT_RESERVE_SQL =
  'INSERT INTO usage (period, queries, inspected) VALUES (?, 1, 0) ' +
  'ON CONFLICT(period) DO UPDATE SET queries = queries + 1 WHERE ? IS NULL OR queries < ? RETURNING queries, inspected';
/** Parameters: period. */
export const QUOTA_OBJECT_RELEASE_SQL = 'UPDATE usage SET queries = MAX(queries - 1, 0) WHERE period = ?';
/** Parameters: period, events. */
export const QUOTA_OBJECT_ADD_SQL =
  'INSERT INTO usage (period, queries, inspected) VALUES (?, 0, ?) ' +
  'ON CONFLICT(period) DO UPDATE SET inspected = inspected + excluded.inspected RETURNING queries, inspected';
/** Parameters: period. */
export const QUOTA_OBJECT_ONE_SQL = 'SELECT queries, inspected FROM usage WHERE period = ?';
/** Parameters: the current day key, the current month key. */
export const QUOTA_OBJECT_CLEANUP_SQL =
  "DELETE FROM usage WHERE (substr(period, 1, 1) = 'd' AND period < ?) OR (substr(period, 1, 1) = 'm' AND period < ?)";
/** How many periods remain, and how many of them are days. */
export const QUOTA_OBJECT_COUNTS_SQL =
  "SELECT count(*) AS n, coalesce(sum(substr(period, 1, 1) = 'd'), 0) AS days FROM usage";
/** Whether the object has ever held quota counters (its other storage is one rate-limit bucket). */
export const QUOTA_OBJECT_EXISTS_SQL = "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage'";

/** The statement reading the counters of `periods` (parameters: the periods). */
export function quotaObjectGetSql(periods: readonly string[]): string {
  checkPeriods(periods);
  return `SELECT period, queries, inspected FROM usage WHERE period IN (${periods.map(() => '?').join(', ')})`;
}
