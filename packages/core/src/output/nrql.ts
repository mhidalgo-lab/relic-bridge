// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { QueryCacheInfo } from '../cache/query-cache.ts';
import type { NrqlTotals } from '../nrql/documents.ts';
import type { NrqlComplete, NrqlOutcome, NrqlPending } from '../nrql/engine.ts';
import { redact, redactHead, redactValue } from '../redact.ts';
import type { ToolOutput } from '../tool.ts';
import { estimateTokens, type ShapeRowsOptions, shapeRows } from './format.ts';
import { type DetailMode, type ResultSummary, SUMMARY_MIN_ROWS, summarizeRows } from './summarize.ts';

/** `_meta` key carrying result metadata (format, truncation, NRQL actually run…), next to `relic-bridge/error`. */
export const RESULT_META_KEY = 'relic-bridge/result';

export const NRQL_NARROW_HINT =
  'narrow the NRQL: add WHERE filters, a shorter SINCE, fewer attributes, or aggregate (FACET … LIMIT n)';

const nrqlTotalsSchema = z.union([
  z.record(z.string(), z.unknown()),
  z.array(z.record(z.string(), z.unknown())),
]);

/** `structuredContent` of an NRQL result. One object type (MCP output schemas must be objects); `status` tells which. */
export interface NrqlResult {
  status: 'complete' | 'pending';
  accountIds: number[];
  /** Column names in display order (complete only). */
  columns?: string[] | undefined;
  /** The rows shown, with the same cuts as the text (complete only). */
  rows?: Record<string, unknown>[] | undefined;
  totalResult?: NrqlTotals | undefined;
  otherResult?: NrqlTotals | undefined;
  facets?: string[] | undefined;
  eventTypes?: string[] | undefined;
  timeseries?: boolean | undefined;
  totalRows?: number | undefined;
  returnedRows?: number | undefined;
  truncated: boolean;
  /** Pending only: pass to get_query_result (`query_id`) together with `accountId` (`account`). */
  queryId?: string | undefined;
  accountId?: number | undefined;
  retryAfterSeconds?: number | undefined;
  expiresAt?: string | undefined;
  /** The NRQL actually sent (after query limits). */
  nrql?: string | undefined;
  notes: string[];
  messages?: string[] | undefined;
  /** Present when a large result was summarized (P7-01): exact stats over all rows, anomaly hints, what was cut. */
  summary?: ResultSummary | undefined;
}

/** Output schema for tools returning `shapeNrqlOutcome` results (P1-06). */
export const nrqlResultSchema: z.ZodType<NrqlResult> = z.object({
  status: z.enum(['complete', 'pending']),
  accountIds: z.array(z.number().int()),
  columns: z.array(z.string()).optional(),
  rows: z.array(z.record(z.string(), z.unknown())).optional(),
  totalResult: nrqlTotalsSchema.optional(),
  otherResult: nrqlTotalsSchema.optional(),
  facets: z.array(z.string()).optional(),
  eventTypes: z.array(z.string()).optional(),
  timeseries: z.boolean().optional(),
  totalRows: z.number().int().optional(),
  returnedRows: z.number().int().optional(),
  truncated: z.boolean(),
  queryId: z.string().optional(),
  accountId: z.number().int().optional(),
  retryAfterSeconds: z.number().optional(),
  expiresAt: z.string().optional(),
  nrql: z.string().optional(),
  notes: z.array(z.string()),
  messages: z.array(z.string()).optional(),
  summary: z
    .object({
      mode: z.enum(['downsampled', 'top-n']),
      totalRows: z.number().int(),
      shownRows: z.number().int(),
      stats: z.array(
        z.object({
          column: z.string(),
          count: z.number().int(),
          min: z.number(),
          max: z.number(),
          avg: z.number(),
          p50: z.number(),
          p95: z.number(),
          othersSum: z.number().optional(),
        }),
      ),
      anomalies: z.array(
        z.object({
          column: z.string(),
          series: z.string().optional(),
          beginTimeSeconds: z.number().optional(),
          value: z.number(),
          median: z.number(),
        }),
      ),
      omittedSeries: z.number().int(),
      ignoredRows: z.number().int(),
    })
    .optional(),
});

export interface NrqlResultMeta {
  readonly status: 'complete' | 'pending';
  readonly nrql?: string;
  readonly accounts: readonly number[];
  readonly durationMs?: number;
  readonly format?: string;
  readonly totalRows?: number;
  readonly returnedRows?: number;
  readonly truncated: boolean;
  readonly summarized?: 'downsampled' | 'top-n';
  readonly inspectedCount?: number;
  readonly polls: number;
  readonly notes: readonly string[];
  /** What the query cache did (P7-02): hit / miss / bypass / off. */
  readonly cache?: QueryCacheInfo;
  readonly tokenEstimate: number;
}

export type ShapeNrqlOptions = Omit<ShapeRowsOptions, 'totalRows' | 'columns' | 'trailer'> & {
  /** `auto` (default) summarizes big timeseries / faceted results, `summary` always, `full` never (P7-01). */
  readonly detail?: DetailMode;
};

const accountsText = (accounts: readonly number[]) =>
  accounts.length === 1 ? `account ${accounts[0]}` : `accounts ${accounts.join(', ')}`;

function seconds(ms: number | undefined): string {
  return ms === undefined ? '' : ` in ${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function finish(text: string, structured: NrqlResult, meta: Omit<NrqlResultMeta, 'tokenEstimate'>) {
  const tokenEstimate = estimateTokens(text) + estimateTokens(JSON.stringify(structured));
  return {
    text,
    structured,
    meta: { [RESULT_META_KEY]: { ...meta, tokenEstimate } satisfies NrqlResultMeta },
  };
}

function shapePending(outcome: NrqlPending): ToolOutput<NrqlResult> {
  const lines = [
    `The NRQL query is still running in account ${outcome.account} (query id ${outcome.queryId}).`,
    `Call get_query_result with query_id "${outcome.queryId}" and account ${outcome.account} in about ${outcome.retryAfterS} s.` +
      (outcome.expiresAt ? ` The result is kept until ${outcome.expiresAt}.` : ''),
    ...outcome.notes.map((n) => `Note: ${n}`),
  ];
  const structured: NrqlResult = {
    status: 'pending',
    accountIds: [outcome.account],
    truncated: false,
    queryId: outcome.queryId,
    accountId: outcome.account,
    retryAfterSeconds: outcome.retryAfterS,
    ...(outcome.expiresAt ? { expiresAt: outcome.expiresAt } : {}),
    ...(outcome.nrql === undefined ? {} : { nrql: outcome.nrql }),
    notes: [...outcome.notes],
  };
  return finish(lines.join('\n'), structured, {
    status: 'pending',
    ...(outcome.nrql === undefined ? {} : { nrql: outcome.nrql }),
    accounts: [outcome.account],
    ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
    truncated: false,
    polls: outcome.polls,
    notes: outcome.notes,
  });
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

function summaryLines(s: ResultSummary): string[] {
  const lines = s.stats.map(
    (c) =>
      `Stats ${JSON.stringify(c.column)} over ${c.count.toLocaleString('en-US')} values: min ${fmt(c.min)}, max ${fmt(c.max)}, avg ${fmt(c.avg)}, p50 ${fmt(c.p50)}, p95 ${fmt(c.p95)}` +
      (c.othersSum === undefined ? '' : `; sum of rows not shown ${fmt(c.othersSum)}`),
  );
  for (const a of s.anomalies) {
    const at =
      a.beginTimeSeconds === undefined ? '' : ` at ${new Date(a.beginTimeSeconds * 1000).toISOString()}`;
    lines.push(
      `Anomaly hint: ${JSON.stringify(a.column)}${a.series === undefined ? '' : ` ${a.series}`}${at} = ${fmt(a.value)} (median ${fmt(a.median)})`,
    );
  }
  return lines;
}

function shapeComplete(outcome: NrqlComplete, allOptions: ShapeNrqlOptions): ToolOutput<NrqlResult> {
  const { detail = 'auto', ...options } = allOptions;
  const wanted =
    outcome.results.length > 0 &&
    (detail === 'summary' ||
      (detail === 'auto' &&
        outcome.results.length >= SUMMARY_MIN_ROWS &&
        (outcome.metadata.timeseries || outcome.metadata.facets.length > 0)));
  const reduced = wanted ? summarizeRows(outcome.results, outcome.metadata.timeseries) : undefined;
  // totalResult / otherResult come from the data as well, so they go inside the envelope with the rows.
  const trailer: string[] = [];
  if (outcome.totalResult) trailer.push(`Total: ${JSON.stringify(outcome.totalResult)}`);
  if (outcome.otherResult) {
    trailer.push(`Other (rows outside the facets shown): ${JSON.stringify(outcome.otherResult)}`);
  }
  // NRDB messages and GraphQL field warnings are New Relic text too (T6): inside the envelope as well.
  trailer.push(
    ...outcome.messages.map((m) => `New Relic: ${m}`),
    ...outcome.warnings.map((w) => `Warning: ${w}`),
  );
  if (reduced) trailer.push(...summaryLines(reduced.summary));
  const shaped = shapeRows(reduced ? reduced.rows : outcome.results, {
    narrowHint: NRQL_NARROW_HINT,
    source: 'NRQL results',
    ...options,
    ...(trailer.length > 0 ? { trailer } : {}),
  });
  const total = outcome.results.length;
  const summary =
    `NRQL returned ${total.toLocaleString('en-US')} ${total === 1 ? 'row' : 'rows'} from ${accountsText(outcome.accounts)}` +
    `${seconds(outcome.durationMs)}` +
    (shaped.stats.returnedRows < total && !reduced ? `; showing ${shaped.stats.returnedRows}` : '') +
    (outcome.stats?.inspectedCount === undefined
      ? '.'
      : `; ${outcome.stats.inspectedCount.toLocaleString('en-US')} events inspected.`);

  const summaryNotice = reduced
    ? `Summarized: ${total.toLocaleString('en-US')} rows reduced to ${shaped.stats.returnedRows} (${
        reduced.summary.mode === 'downsampled' ? 'timeseries downsampled per series' : 'first rows kept'
      }); statistics are exact over all rows${
        reduced.summary.omittedSeries > 0 ? `; ${reduced.summary.omittedSeries} more series not shown` : ''
      }. For every row, call again with detail "full" (max_rows up to 1000).`
    : undefined;
  const cache = outcome.cache;
  const lines = [
    summary,
    ...(cache?.status === 'hit' ? [`Served from the query cache, ${cache.ageSeconds ?? 0} s old.`] : []),
    ...outcome.notes.map((n) => `Note: ${n}`),
    ...(summaryNotice ? [summaryNotice] : []),
    shaped.text,
  ];
  const clean = (v: NrqlTotals) => ((options.redactSecrets ?? true) ? (redactValue(v) as NrqlTotals) : v);
  const scrub = (v: string) => ((options.redactSecrets ?? true) ? redact(v) : v);
  // Cut to `max`, redacting only what is kept (redactHead) so the work follows the cap.
  const scrubTo = (v: string, max: number) =>
    ((options.redactSecrets ?? true) ? redactHead(v, max).text : v).slice(0, max);
  const md = outcome.metadata;
  const structured: NrqlResult = {
    status: 'complete',
    accountIds: [...outcome.accounts],
    columns: shaped.columns,
    rows: shaped.rows,
    ...(outcome.totalResult ? { totalResult: clean(outcome.totalResult) } : {}),
    ...(outcome.otherResult ? { otherResult: clean(outcome.otherResult) } : {}),
    facets: [...md.facets],
    eventTypes: md.eventTypes.map(scrub),
    timeseries: md.timeseries,
    totalRows: total,
    returnedRows: shaped.stats.returnedRows,
    truncated: shaped.stats.truncated || reduced !== undefined,
    ...(outcome.nrql === undefined ? {} : { nrql: outcome.nrql }),
    notes: [...outcome.notes],
    messages: outcome.messages.map(scrub),
    ...(reduced
      ? {
          summary: {
            ...reduced.summary,
            stats: reduced.summary.stats.map((c) => ({ ...c, column: scrub(c.column) })),
            anomalies: reduced.summary.anomalies.map((a) => ({
              ...a,
              column: scrub(a.column),
              ...(a.series === undefined ? {} : { series: scrubTo(a.series, 200) }),
            })),
          },
        }
      : {}),
  };
  return finish(lines.join('\n'), structured, {
    status: 'complete',
    ...(outcome.nrql === undefined ? {} : { nrql: outcome.nrql }),
    accounts: outcome.accounts,
    ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
    format: shaped.format,
    totalRows: total,
    returnedRows: shaped.stats.returnedRows,
    truncated: shaped.stats.truncated || reduced !== undefined,
    ...(reduced ? { summarized: reduced.summary.mode } : {}),
    ...(outcome.stats?.inspectedCount === undefined ? {} : { inspectedCount: outcome.stats.inspectedCount }),
    polls: outcome.polls,
    notes: outcome.notes,
    ...(cache === undefined ? {} : { cache }),
  });
}

/**
 * Turn an NRQL outcome into a tool result: a summary line, notes, the rows in the chosen format inside the
 * untrusted-data envelope, a truncation notice when needed, `structuredContent` matching `nrqlResultSchema`, and
 * `_meta[RESULT_META_KEY]`.
 */
export function shapeNrqlOutcome(
  outcome: NrqlOutcome,
  options: ShapeNrqlOptions = {},
): ToolOutput<NrqlResult> {
  return outcome.status === 'pending' ? shapePending(outcome) : shapeComplete(outcome, options);
}
