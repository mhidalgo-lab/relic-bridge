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
import { cleanName } from './identity.ts';
import { assertWindowWithinLimit, type ToolDeps, toolClient, UNTRUSTED } from './shared.ts';

export const DEFAULT_GOLDEN_SINCE = 'last 30 minutes';
const DEFAULT_MAX_METRICS = 10;
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
    since: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        `Time window as in time_range, e.g. "last 6 hours". Default "last 30 minutes". A metric query with its own SINCE keeps it.`,
      ),
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
  /** Latest value (last bucket with data when a time series was fetched). */
  value: z.number().nullable(),
  /** The result column the value came from. */
  column: z.string().nullable(),
  trend: z.enum(['up', 'down', 'flat', 'unknown']),
  /** Mean of the later half of the series relative to the earlier half, as a fraction (0.12 = +12%). */
  changeRatio: z.number().nullable(),
  points: z.number().int(),
  nrql: z.string().nullable(),
  /** Why the metric has no value (limit adjustments, query error, skipped for budget…). */
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
  metrics: z.array(metricRow),
  /** Some metrics were not evaluated (budget) or have no value (errors, still running). */
  partial: z.boolean(),
  totalMetrics: z.number().int(),
});

const DESCRIPTION = `Golden metrics of one entity (guid or name): the key signals New Relic defines for its kind (throughput, response time and error rate for a service; CPU and memory for a host...), each with its latest value, a trend (up, down, flat) and the NRQL that produced it.

Use it for current metric values, and refine any metric with run_nrql. For metrics plus issues, errors and deployments in one call use entity_health.. Runs one entity lookup, then one query per metric (up to max_metrics); metrics stopped by budget or query limits are marked skipped or error. ${UNTRUSTED}`;

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

/** Latest value and trend of NRQL result rows (a time series when `timeseries`, else the first row). Pure. */
export function summarizeSeries(
  rows: readonly Record<string, unknown>[],
  timeseries: boolean,
): SeriesSummary {
  const series: number[] = [];
  let column: string | null = null;
  for (const row of timeseries ? rows : rows.slice(0, 1)) {
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
  const hasSeries = top.has('TIMESERIES');
  const parts = [source.trim()];
  if (!hasWindow) parts.push(clause);
  if (timeseries && !hasSeries && !top.has('COMPARE')) parts.push('TIMESERIES AUTO');
  return { nrql: parts.join(' '), timeseries: timeseries || hasSeries };
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
  ): Promise<MetricRow> {
    try {
      if (query.length > MAX_QUERY_CHARS) {
        return emptyMetric(title, 'error', 'The golden metric query is too long to run.');
      }
      const prepared = withTimeClauses(query, clause, wantSeries);
      const outcome = await runTrustedNrql(
        ctx,
        // One poll at most: a slow metric is reported pending rather than spending the budget.
        { nrql: prepared.nrql, accounts: [account], mode: 'auto', maxPolls: 1 },
        { client: client(ctx), ...(deps.sleep ? { sleep: deps.sleep } : {}) },
      );
      const sent = outcome.nrql ?? prepared.nrql;
      const notes = outcome.notes.join(' ') || null;
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
      const s = summarizeSeries(done.results, prepared.timeseries);
      if (s.value === null) {
        return { ...emptyMetric(title, 'no_data', notes ?? 'No data in this window.'), nrql: sent };
      }
      return { title, status: 'ok', ...s, nrql: sent, note: notes };
    } catch (e) {
      if (!(e instanceof RbError) || FATAL_CODES.has(e.code)) throw e;
      if (e.code === ErrorCode.BudgetExhausted)
        return emptyMetric(title, 'skipped', 'Request budget exhausted.');
      return emptyMetric(title, 'error', cleanName(e.message, 300));
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
    // One entity lookup plus one query per metric (default cap).
    cost: 1 + DEFAULT_MAX_METRICS + RESOLVE_COST,
    group: 'health',
    phase: 1,
    handler: async (rawArgs, ctx) => {
      const ref = await resolveEntityRef(resolver, ctx, rawArgs);
      const args = { ...rawArgs, guid: ref.guid };
      const decoded = checkGuid(ctx, args.guid);
      const sinceText = args.since ?? DEFAULT_GOLDEN_SINCE;
      const range = parseTimeRange(sinceText, ctx.clock.now());
      assertWindowWithinLimit(range, ctx.limits);
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
      // Budget-aware: start only as many as the remaining budget can pay for (one request each).
      const startable = Math.min(wanted.length, ctx.budget.remaining);
      const ran = await Promise.all(
        wanted
          .slice(0, startable)
          .map((m) => runMetric(ctx, account, m.title, m.query, range.clause, wantSeries)),
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
      const lines = [
        `${metrics.length} golden metric${metrics.length === 1 ? '' : 's'} for ${entity.domain ?? 'entity'}/${entity.type ?? ''} ` +
          `in account ${account}, ${range.clause.toLowerCase()}: ${count('ok')} with data` +
          `${count('no_data') ? `, ${count('no_data')} without data` : ''}` +
          `${count('pending') ? `, ${count('pending')} still running` : ''}` +
          `${count('error') ? `, ${count('error')} failed` : ''}` +
          `${count('skipped') ? `, ${count('skipped')} skipped (budget)` : ''}.`,
      ];
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
        structured: { entity, since: sinceText, metrics, partial, totalMetrics: defs.length },
      };
    },
  });

  return [tool as ToolDefinition];
}
