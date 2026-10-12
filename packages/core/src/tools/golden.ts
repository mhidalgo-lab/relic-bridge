// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { ToolContext } from '../context.ts';
import { ErrorCode, RbError } from '../errors.ts';
import { GOLDEN_METRICS_QUERY } from '../nerdgraph/entities.ts';
import { type NrqlComplete, runTrustedNrql } from '../nrql/engine.ts';
import { tokenize } from '../nrql/tokenize.ts';
import { envelope } from '../output/envelope.ts';
import { shapeRows } from '../output/format.ts';
import { parseTimeRange } from '../time/range.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { checkGuid, isNonNull, outOfScope, requireField } from './entity-common.ts';
import { entityRefFields, RESOLVE_COST, refineEntityRef, resolveEntityRef } from './entity-ref.ts';
import { createEntityResolver } from './entity-resolver.ts';
import { cleanName, errorNote } from './identity.ts';
import {
  assertWindowWithinLimit,
  NRQL_COST,
  startableNrql,
  type ToolDeps,
  timeRangeInput,
  toolClient,
  UNTRUSTED,
} from './shared.ts';

export const DEFAULT_GOLDEN_SINCE = 'last 30 minutes';
const DEFAULT_MAX_METRICS = 10;

/** Requests `get_golden_metrics` sends for `metrics` golden metrics (entity lookup + NRQL each), name resolution aside. */
export const goldenCost = (metrics: number): number => 1 + NRQL_COST * metrics;
/** The golden metrics a grant of `granted` requests pays for (at least one). */
export const goldenMetricsFor = (granted: number): number =>
  Math.max(1, Math.floor((granted - 1) / NRQL_COST));
const MAX_METRICS = 20;
const MAX_QUERY_CHARS = 4096;
/** Relative change between the two halves of the window that still counts as flat. */
export const FLAT_BAND = 0.05;
/** Fewest data points needed to call a trend. */
export const MIN_TREND_POINTS = 4;
const NON_VALUE_KEYS = new Set(['beginTimeSeconds', 'endTimeSeconds', 'facet', 'comparison', 'timestamp']);
/** Errors that make every metric fail the same way: abort instead of listing N identical failures. */
const FATAL_CODES: ReadonlySet<string> = new Set([
  ErrorCode.AuthUnauthorized,
  ErrorCode.AuthForbidden,
  ErrorCode.AuthInvalidKey,
  ErrorCode.AuthWrongRegion,
]);

export type Trend = 'up' | 'down' | 'flat' | 'unknown';

const input = refineEntityRef(
  z.strictObject({
    ...entityRefFields('Entity guid.'),
    time_range: timeRangeInput(DEFAULT_GOLDEN_SINCE),
    timeseries: z
      .boolean()
      .optional()
      .describe('Fetch a time series for the trend (default true); false: one value per metric.'),
    max_metrics: z
      .number()
      .int()
      .min(1)
      .max(MAX_METRICS)
      .optional()
      .describe(`Most golden metrics to run (default ${DEFAULT_MAX_METRICS}, max ${MAX_METRICS}).`),
  }),
);

const metricRow = z.object({
  title: z.string(),
  status: z.enum(['ok', 'no_data', 'pending', 'error', 'skipped']),
  /** Latest value (last complete bucket with data when a time series was fetched; the bucket still filling is ignored). */
  value: z.number().nullable(),
  /** The result column the value came from. */
  column: z.string().nullable(),
  trend: z.enum(['up', 'down', 'flat', 'unknown']),
  /** Mean of the later half of the complete buckets relative to the earlier half (equal lengths), as a fraction (0.12 = +12%). */
  changeRatio: z.number().nullable(),
  points: z.number().int(),
  nrql: z.string().nullable(),
  /** Why the metric has no value (no data, query error, skipped for budget…). */
  note: z.string().nullable(),
});

const output = z.object({
  entity: z.object({
    guid: z.string(),
    name: z.string().nullable(),
    accountId: z.number().int(),
    domain: z.string().nullable(),
    type: z.string().nullable(),
  }),
  since: z.string(),
  until: z.string(),
  metrics: z.array(metricRow),
  /** Adjustments made to the golden queries (limits), the same for every metric: stated once here. */
  notes: z.array(z.string()),
  /** Some metrics were not evaluated (budget) or have no value (errors, still running). */
  partial: z.boolean(),
  totalMetrics: z.number().int(),
});

const DESCRIPTION = `Golden metrics of one entity (guid or name): the key signals New Relic defines for its kind (throughput, response time and error rate for a service; CPU and memory for a host...), each with its latest value, a trend (up, down, flat) and the NRQL that produced it.

Value and trend use complete time buckets only (the one still filling is ignored); the trend compares the later half of the window with the earlier. timeseries=false: one aggregate per metric, no trend. Refine any metric with run_nrql. For metrics plus issues, errors and deployments in one call use entity_health. Runs one entity lookup, then one query per metric (up to max_metrics); metrics stopped by budget or query limits are marked skipped or error. ${UNTRUSTED}`;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The number a result row carries: first plain numeric column, or the first numeric member of an object (percentiles). */
function rowValue(row: Record<string, unknown>): { column: string; value: number | null } | null {
  for (const [key, v] of Object.entries(row)) {
    if (NON_VALUE_KEYS.has(key)) continue;
    if (isNum(v)) return { column: key, value: v };
    if (v === null) return { column: key, value: null };
    if (v !== undefined && typeof v === 'object') {
      const inner = Object.values(v as Record<string, unknown>).find(isNum);
      if (inner !== undefined) return { column: key, value: inner };
    }
  }
  return null;
}

export interface SeriesSummary {
  readonly column: string | null;
  readonly value: number | null;
  readonly trend: Trend;
  readonly changeRatio: number | null;
  readonly points: number;
}

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** The bucket end (epoch seconds) of a time series row, when it carries one. */
const bucketEnd = (row: Record<string, unknown>): number | null => {
  const v = row['endTimeSeconds'];
  return isNum(v) ? v : null;
};

/**
 * Latest value and trend of NRQL result rows (a time series when `timeseries`, else the first row). Pure.
 * `nowMs`: buckets that end after it are still filling (BUG-26: an empty last bucket read as value 0, a partial one skews
 * the trend), so they are left out of the value and the trend. The trend compares the later half of the remaining
 * buckets with the earlier half: two windows of equal length (an odd middle bucket is left out).
 */
export function summarizeSeries(
  rows: readonly Record<string, unknown>[],
  timeseries: boolean,
  nowMs: number | null = null,
): SeriesSummary {
  const series: number[] = [];
  let column: string | null = null;
  const complete =
    timeseries && nowMs !== null
      ? rows.filter((row) => {
          const end = bucketEnd(row);
          return end === null || end * 1000 <= nowMs;
        })
      : rows;
  for (const row of timeseries ? complete : rows.slice(0, 1)) {
    const v = rowValue(row);
    if (!v) continue;
    column ??= v.column;
    if (v.value !== null && v.column === column) series.push(v.value);
  }
  const last = series.at(-1) ?? null;
  if (!timeseries || series.length < MIN_TREND_POINTS) {
    return { column, value: last, trend: 'unknown', changeRatio: null, points: series.length };
  }
  const half = Math.floor(series.length / 2);
  const before = mean(series.slice(0, half));
  const after = mean(series.slice(series.length - half));
  if (before === 0) {
    const trend: Trend = after === 0 ? 'flat' : after > 0 ? 'up' : 'down';
    return { column, value: last, trend, changeRatio: null, points: series.length };
  }
  const changeRatio = (after - before) / Math.abs(before);
  const trend: Trend = Math.abs(changeRatio) <= FLAT_BAND ? 'flat' : changeRatio > 0 ? 'up' : 'down';
  return { column, value: last, trend, changeRatio, points: series.length };
}

const CLAUSE_STARTS = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'FACET',
  'SINCE',
  'UNTIL',
  'LIMIT',
  'OFFSET',
  'COMPARE',
  'ORDER',
  'EXTRAPOLATE',
  'WITH',
]);

/** Remove the top-level `TIMESERIES …` clause (including `SLIDE BY …`) from comment-free NRQL text. */
function stripTimeseries(source: string): string {
  const tokens = tokenize(source);
  const at = tokens.findIndex((t) => t.kind === 'word' && t.depth === 0 && t.value === 'TIMESERIES');
  const first = tokens[at];
  if (!first) return source;
  let end = first.end;
  for (const t of tokens.slice(at + 1)) {
    if (t.depth === 0 && t.kind === 'word' && CLAUSE_STARTS.has(t.value)) break;
    end = t.end;
  }
  return `${source.slice(0, first.start)} ${source.slice(end)}`;
}

/**
 * Add the time window and time series clauses a golden query lacks. Golden queries from New Relic often carry neither;
 * ones that already set SINCE/UNTIL/TIMESERIES keep them. Throws RB_INPUT_INVALID when the text can't be tokenized.
 */
export function withTimeClauses(
  query: string,
  clause: string,
  timeseries: boolean,
): { nrql: string; timeseries: boolean } {
  const tokens = tokenize(query);
  // A trailing `--` comment would swallow the clauses appended below: drop comments first (limits strip them anyway).
  let source = query;
  for (const c of tokens.filter((t) => t.kind === 'comment').reverse()) {
    source = `${source.slice(0, c.start)} ${source.slice(c.end)}`;
  }
  const top = new Set(tokens.filter((t) => t.kind === 'word' && t.depth === 0).map((t) => t.value));
  const hasWindow = top.has('SINCE') || top.has('UNTIL');
  let hasSeries = top.has('TIMESERIES');
  if (!timeseries && hasSeries) {
    // The caller wants one aggregate: drop the query's own TIMESERIES clause (and its SLIDE BY) rather than ignore the flag.
    source = stripTimeseries(source);
    hasSeries = false;
  }
  const parts = [source.trim()];
  if (!hasWindow) parts.push(clause);
  if (timeseries && !hasSeries && !top.has('COMPARE')) parts.push('TIMESERIES AUTO');
  return { nrql: parts.join(' '), timeseries: timeseries || hasSeries };
}

const SELECT_END = new Set([
  'FROM',
  'WHERE',
  'FACET',
  'SINCE',
  'UNTIL',
  'TIMESERIES',
  'LIMIT',
  'COMPARE',
  'WITH',
  'ORDER',
]);

/**
 * Whether an NRQL text only aggregates: every select item is a function call, no `*`, no sub-select, no JOIN. Golden
 * metrics can be customised in New Relic, so on a connection with `rawNrql: false` a golden query that could return raw
 * event rows is refused (review M4). Token-level, like the query limits: a screen, not a parser.
 */
export function isAggregateOnlyNrql(query: string): boolean {
  const tokens = tokenize(query).filter((t) => t.kind !== 'comment');
  if (
    tokens.some((t) => t.kind === 'word' && (t.value === 'JOIN' || (t.depth > 0 && t.value === 'SELECT')))
  ) {
    return false;
  }
  const start = tokens.findIndex((t) => t.kind === 'word' && t.depth === 0 && t.value === 'SELECT');
  if (start === -1) return false;
  let itemStart = true;
  for (let i = start + 1; i < tokens.length; i++) {
    const t = tokens[i] as (typeof tokens)[number];
    if (t.depth === 0 && t.kind === 'word' && SELECT_END.has(t.value)) break;
    if (t.depth === 0 && t.text === '*') return false;
    if (t.depth === 0 && t.text === ',') {
      itemStart = true;
      continue;
    }
    if (itemStart) {
      if (t.kind !== 'word' || tokens[i + 1]?.text !== '(') return false;
      itemStart = false;
    }
  }
  return !itemStart;
}

type MetricRow = z.infer<typeof metricRow>;

const emptyMetric = (title: string, status: MetricRow['status'], note: string | null = null): MetricRow => ({
  title,
  status,
  value: null,
  column: null,
  trend: 'unknown',
  changeRatio: null,
  points: 0,
  nrql: null,
  note,
});

const fmt = (v: number | null) => (v === null ? '' : String(Number(v.toPrecision(4))));
const pct = (r: number | null) => (r === null ? '' : `${r >= 0 ? '+' : ''}${(r * 100).toFixed(1)}%`);

/** `get_golden_metrics`. */
export function createGoldenMetricTools(deps: ToolDeps = {}): ToolDefinition[] {
  const client = toolClient(deps);
  const resolver = deps.resolver ?? createEntityResolver(deps);

  async function runMetric(
    ctx: ToolContext,
    account: number,
    title: string,
    query: string,
    clause: string,
    wantSeries: boolean,
    adjustments: Set<string>,
  ): Promise<MetricRow> {
    try {
      if (query.length > MAX_QUERY_CHARS) {
        return emptyMetric(title, 'error', 'The golden metric query is too long to run.');
      }
      if (!ctx.limits.rawNrql && !isAggregateOnlyNrql(query)) {
        return emptyMetric(
          title,
          'error',
          'This golden metric is not a plain aggregate query and raw NRQL is disabled on this connection.',
        );
      }
      const prepared = withTimeClauses(query, clause, wantSeries);
      const outcome = await runTrustedNrql(
        ctx,
        // One poll at most: a slow metric is reported pending rather than spending the budget.
        { nrql: prepared.nrql, accounts: [account], mode: 'auto', maxPolls: 1 },
        { client: client(ctx), ...(deps.sleep ? { sleep: deps.sleep } : {}) },
      );
      const sent = outcome.nrql ?? prepared.nrql;
      // Query adjustments (limits) are the same for every metric: reported once on the result, not per row (BUG-20).
      for (const n of outcome.notes) adjustments.add(n);
      if (outcome.status === 'pending') {
        return {
          ...emptyMetric(title, 'pending', 'Still running at New Relic; try again shortly.'),
          nrql: sent,
        };
      }
      const done: NrqlComplete = outcome;
      if (done.metadata.facets.length > 0) {
        return {
          ...emptyMetric(title, 'no_data', 'Faceted metric: run its NRQL with run_nrql for the breakdown.'),
          nrql: sent,
        };
      }
      const s = summarizeSeries(done.results, prepared.timeseries, ctx.clock.now());
      if (s.value === null) {
        return { ...emptyMetric(title, 'no_data', 'No data in this window.'), nrql: sent };
      }
      return { title, status: 'ok', ...s, nrql: sent, note: null };
    } catch (e) {
      if (!(e instanceof RbError) || FATAL_CODES.has(e.code)) throw e;
      if (e.code === ErrorCode.BudgetExhausted)
        return emptyMetric(title, 'skipped', 'Request budget exhausted.');
      return emptyMetric(title, 'error', errorNote(e));
    }
  }

  const tool = defineTool({
    name: 'get_golden_metrics',
    title: 'Get golden metrics',
    description: DESCRIPTION,
    inputSchema: input,
    outputSchema: output,
    kind: 'read',
    openWorld: true,
    // One entity lookup plus one NRQL per metric (default cap), and the name resolution.
    cost: goldenCost(DEFAULT_MAX_METRICS) + RESOLVE_COST,
    group: 'health',
    phase: 1,
    handler: async (rawArgs, ctx) => {
      const ref = await resolveEntityRef(resolver, ctx, rawArgs);
      const args = { ...rawArgs, guid: ref.guid };
      const decoded = checkGuid(ctx, args.guid);
      const range = parseTimeRange(args.time_range ?? DEFAULT_GOLDEN_SINCE, ctx.clock.now());
      assertWindowWithinLimit(range, ctx.limits, ctx.clock.now());
      const wantSeries = args.timeseries ?? true;

      const result = await client(ctx).query(GOLDEN_METRICS_QUERY, { guid: args.guid });
      const e = requireField(result.data.actor.entity, result, ctx);
      const account = e.accountId ?? decoded.accountId;
      if (!ctx.accounts.allowed.includes(account) || account !== decoded.accountId) {
        throw outOfScope(account);
      }

      const defs = (e.goldenMetrics?.metrics ?? [])
        .filter(isNonNull)
        .map((m) => ({
          title: cleanName(typeof m.title === 'string' && m.title ? m.title : 'metric'),
          query: typeof m.query === 'string' ? m.query.trim() : '',
        }))
        .filter((m) => m.query !== '');
      const cap = args.max_metrics ?? DEFAULT_MAX_METRICS;
      const wanted = defs.slice(0, cap);
      // Budget-aware: start only as many as the remaining budget can pay for (NRQL_COST requests each).
      const startable = startableNrql(wanted.length, ctx.budget.remaining);
      const adjustments = new Set<string>();
      const ran = await Promise.all(
        wanted
          .slice(0, startable)
          .map((m) => runMetric(ctx, account, m.title, m.query, range.clause, wantSeries, adjustments)),
      );
      const skipped = wanted
        .slice(startable)
        .map((m) => emptyMetric(m.title, 'skipped', 'Request budget exhausted.'));
      const metrics = [...ran, ...skipped];
      const notRun = defs.length - wanted.length;
      const partial = metrics.some((m) => m.status !== 'ok' && m.status !== 'no_data') || notRun > 0;

      const entity = {
        guid: args.guid,
        name: typeof e.name === 'string' ? cleanName(e.name) : null,
        accountId: account,
        domain: typeof e.domain === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(e.domain) ? e.domain : null,
        type: typeof e.type === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(e.type) ? e.type : null,
      };
      const count = (s: MetricRow['status']) => metrics.filter((m) => m.status === s).length;
      const notes = [...adjustments];
      const lines = [
        `${metrics.length} golden metric${metrics.length === 1 ? '' : 's'} for ${entity.domain ?? 'entity'}/${entity.type ?? ''} ` +
          `in account ${account}, ${range.clause.toLowerCase()}: ${count('ok')} with data` +
          `${count('no_data') ? `, ${count('no_data')} without data` : ''}` +
          `${count('pending') ? `, ${count('pending')} still running` : ''}` +
          `${count('error') ? `, ${count('error')} failed` : ''}` +
          `${count('skipped') ? `, ${count('skipped')} skipped (budget)` : ''}.`,
      ];
      for (const n of notes) lines.push(`Note: ${n}`);
      if (defs.length === 0)
        lines.push('This entity has no golden metrics. Use run_nrql for custom queries.');
      if (notRun > 0)
        lines.push(`${notRun} more golden metric(s) not run: raise max_metrics (max ${MAX_METRICS}).`);
      if (partial) lines.push('Partial result: see the status column; rerun for the missing metrics.');
      if (metrics.length > 0) {
        const shaped = shapeRows(
          metrics.map((m) => ({
            metric: m.title,
            status: m.status,
            value: fmt(m.value),
            trend: m.trend,
            change: pct(m.changeRatio),
            note: m.note ?? '',
          })),
          { format: 'table', source: 'New Relic golden metrics', maxRows: MAX_METRICS },
        );
        lines.push(shaped.text);
        lines.push(
          envelope(metrics.map((m) => `${m.title}: ${m.nrql ?? '(not run)'}`).join('\n'), {
            source: 'Golden metric NRQL',
          }),
        );
      }
      return {
        text: [...(ref.note ? [ref.note] : []), ...lines].join('\n'),
        structured: {
          entity,
          since: range.since,
          until: range.until,
          metrics,
          notes,
          partial,
          totalMetrics: defs.length,
        },
      };
    },
  });

  return [tool as ToolDefinition];
}
