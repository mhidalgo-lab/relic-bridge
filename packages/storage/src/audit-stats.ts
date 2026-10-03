// SPDX-License-Identifier: Apache-2.0
// Usage statistics over the audit log (P4-05): one bounded aggregate, shared by the SQLite and D1 adapters so both run
// the same statement. Only `tool_call` rows in a time window, at most `AUDIT_STATS_MAX_GROUPS` groups out, and the
// window is capped (a Worker invocation reads the rows in the window, so an unbounded one would burn D1 row reads).
import { InvalidInputError } from './errors.ts';
import type { AuditStatsGroup, AuditStatsQuery, AuditStatsRow } from './types.ts';

export const AUDIT_STATS_DEFAULT_GROUPS = 50;
export const AUDIT_STATS_MAX_GROUPS = 100;
/** The longest window an aggregate may cover: the default audit retention. */
export const AUDIT_STATS_MAX_WINDOW_MS = 90 * 86_400_000;

const GROUP_EXPR: Readonly<Record<AuditStatsGroup, string>> = {
  action: 'action',
  project: 'project_id',
  grant: 'grant_id',
  token: 'token_id',
  day: "strftime('%Y-%m-%d', ts / 1000, 'unixepoch')",
};

/** The statement and parameters for `query`; throws `InvalidInputError` for an unbounded or malformed window. */
export function auditStatsSql(query: AuditStatsQuery): { sql: string; params: (string | number)[] } {
  const expr = GROUP_EXPR[query.groupBy];
  if (expr === undefined) throw new InvalidInputError('auditLog.stats.groupBy');
  const { since, until } = query;
  if (!Number.isFinite(since) || !Number.isFinite(until) || until <= since)
    throw new InvalidInputError('auditLog.stats.window');
  if (until - since > AUDIT_STATS_MAX_WINDOW_MS) throw new InvalidInputError('auditLog.stats.window');
  if (query.limit !== undefined && !Number.isFinite(query.limit))
    throw new InvalidInputError('auditLog.stats.limit');
  const limit = Math.min(
    Math.max(1, Math.trunc(query.limit ?? AUDIT_STATS_DEFAULT_GROUPS)),
    AUDIT_STATS_MAX_GROUPS,
  );
  const where = ["kind = 'tool_call'", 'ts >= ?', 'ts < ?'];
  const params: (string | number)[] = [since, until];
  const add = (clause: string, value: string | undefined): void => {
    if (value === undefined) return;
    where.push(clause);
    params.push(value);
  };
  add('project_id = ?', query.projectId);
  add('user_id = ?', query.userId);
  add('grant_id = ?', query.grantId);
  add('token_id = ?', query.tokenId);
  add('action = ?', query.action);
  const order = query.groupBy === 'day' ? 'k DESC' : 'calls DESC, k';
  const sql =
    `SELECT ${expr} AS k, COUNT(*) AS calls, ` +
    "COALESCE(SUM(status = 'error'), 0) AS errors, COALESCE(SUM(status = 'denied'), 0) AS denied, " +
    'COALESCE(SUM(duration_ms), 0) AS duration_sum, COUNT(duration_ms) AS duration_count, ' +
    'MAX(duration_ms) AS duration_max, COALESCE(SUM(inspected_count), 0) AS inspected ' +
    `FROM audit_log WHERE ${where.join(' AND ')} GROUP BY k ORDER BY ${order} LIMIT ?`;
  return { sql, params: [...params, limit] };
}

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : 0);

/** A result row of `auditStatsSql` as the public shape. */
export function auditStatsRowOf(r: Readonly<Record<string, unknown>>): AuditStatsRow {
  return Object.freeze({
    key: typeof r['k'] === 'string' ? r['k'] : null,
    calls: num(r['calls']),
    errors: num(r['errors']),
    denied: num(r['denied']),
    durationSumMs: num(r['duration_sum']),
    durationCount: num(r['duration_count']),
    maxDurationMs:
      r['duration_max'] === null || r['duration_max'] === undefined ? null : num(r['duration_max']),
    inspectedCount: num(r['inspected']),
  });
}

/** `ORDER BY` of an audit `list` query: newest first by id, or slowest first (rows with a duration only). */
export function auditOrder(order: 'newest' | 'slowest' | undefined): {
  where: string | null;
  orderBy: string;
} {
  return order === 'slowest'
    ? { where: 'duration_ms IS NOT NULL', orderBy: 'duration_ms DESC, id DESC' }
    : { where: null, orderBy: 'id DESC' };
}

/** The UTC day of an epoch-ms timestamp (`YYYY-MM-DD`), as the SQL `strftime` gives it. */
export const utcDay = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
