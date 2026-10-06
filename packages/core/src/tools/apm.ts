// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { ToolContext } from '../context.ts';
import { ErrorCode, RbError } from '../errors.ts';
import { type NrqlComplete, runNrql } from '../nrql/engine.ts';
import { type NrqlQuery, nrql } from '../nrql/template.ts';
import { pickFields } from '../output/compact.ts';
import { shapeRows } from '../output/format.ts';
import { parseTimeRange } from '../time/range.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { compareWindows, FATAL_CODES, numberOf, type WindowStats } from './changes.ts';
import { checkGuid } from './entities.ts';
import { cleanName, errorNote } from './identity.ts';
import {
  assertWindowWithinLimit,
  NRQL_COST,
  singleAccount,
  startableNrql,
  type ToolDeps,
  timeRangeInput,
  toolClient,
  UNTRUSTED,
} from './shared.ts';

const DEFAULT_WINDOW = 'last 1 hour';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MINUTE_MS = 60_000;
const MAX_NAME_CHARS = 300;

const GUID_FIELD = z.string().min(1).max(256).describe('The APM application (guid; its account is queried).');
const RANGE_FIELD = timeRangeInput(DEFAULT_WINDOW);
const TYPE_FIELD = z
  .enum(['all', 'web', 'background'])
  .optional()
  .describe('Only web transactions, only background (non-web) ones, or all (default).');

/** Closed set to NRQL literal: the user's choice never reaches the query text. */
const typeFilter = (t: 'all' | 'web' | 'background' | undefined): NrqlQuery =>
  t === 'web'
    ? nrql`AND transactionType = ${'Web'}`
    : t === 'background'
      ? nrql`AND transactionType = ${'Other'}`
      : nrql``;

export interface TxStats extends WindowStats {
  /** Count of failed transactions. */
  readonly errors: number | null;
  readonly p50Duration: number | null;
  readonly p99Duration: number | null;
}

/** Reads the aggregate columns of one NRQL result row. Pure. */
export function txStats(row: Record<string, unknown> | undefined): TxStats {
  const r = row ?? {};
  return {
    requests: numberOf(r['requests']),
    errors: numberOf(r['errors']),
    errorRate: numberOf(r['errorRate']),
    avgDuration: numberOf(r['avgDuration']),
    p50Duration: numberOf(r['p50Duration']),
    p95Duration: numberOf(r['p95Duration']),
    p99Duration: numberOf(r['p99Duration']),
  };
}

const rounded = (v: number | null): number | null => (v === null ? null : Number(v.toPrecision(6)));
const perMinute = (requests: number | null, minutes: number): number | null =>
  requests === null || minutes <= 0 ? null : rounded(requests / minutes);

/** The aggregates shared by both tools (`FROM Transaction`). Durations are seconds. */
const AGGREGATES = nrql`count(*) AS requests, filter(count(*), WHERE error IS true) AS errors, percentage(count(*), WHERE error IS true) AS errorRate, average(duration) AS avgDuration, percentile(duration, 50) AS p50Duration, percentile(duration, 95) AS p95Duration, percentile(duration, 99) AS p99Duration`;

const bounds = (sinceMs: number, untilMs: number) => ({
  since: Math.floor(sinceMs / 1000),
  until: Math.ceil(untilMs / 1000),
});

/** Overall (optionally one transaction) query for one window. Every user value is a template value. */
export function summaryQuery(
  guid: string,
  sinceMs: number,
  untilMs: number,
  name: string | undefined,
  type: 'all' | 'web' | 'background' | undefined,
): NrqlQuery {
  const { since, until } = bounds(sinceMs, untilMs);
  const byName = name === undefined ? nrql`` : nrql`AND name = ${name}`;
  return nrql`SELECT ${AGGREGATES} FROM Transaction WHERE entityGuid = ${guid} ${byName} ${typeFilter(type)} SINCE ${since} UNTIL ${until}`;
}

export type SortBy = 'slowest' | 'errors' | 'throughput';

/** Per-transaction query. `pattern` is a LIKE pattern built from the user's text, passed as a template value. */
export function topQuery(
  guid: string,
  sinceMs: number,
  untilMs: number,
  sortBy: SortBy,
  limit: number,
  pattern: string | undefined,
  type: 'all' | 'web' | 'background' | undefined,
): NrqlQuery {
  const { since, until } = bounds(sinceMs, untilMs);
  const byName = pattern === undefined ? nrql`` : nrql`AND name LIKE ${pattern}`;
  const order =
    sortBy === 'errors'
      ? nrql`filter(count(*), WHERE error IS true)`
      : sortBy === 'throughput'
        ? nrql`count(*)`
        : nrql`percentile(duration, 95)`;
  return nrql`SELECT ${AGGREGATES} FROM Transaction WHERE entityGuid = ${guid} ${byName} ${typeFilter(type)} FACET name ORDER BY ${order} DESC LIMIT ${limit} SINCE ${since} UNTIL ${until}`;
}

/** `%` and `_` the user typed must match literally in a LIKE pattern. */
export const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// ---------------------------------------------------------------------------------------------------------------------
// list_top_transactions
// ---------------------------------------------------------------------------------------------------------------------

const listInput = z.strictObject({
  entity_guid: GUID_FIELD,
  sort_by: z
    .enum(['slowest', 'errors', 'throughput'])
    .optional()
    .describe(
      'slowest = highest p95 duration (default), errors = most failed transactions, throughput = most requests.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Most transactions to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
  transaction_type: TYPE_FIELD,
  name_contains: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Only transactions whose name contains this text (case-insensitive).'),
  time_range: RANGE_FIELD,
  minimal_output: z.boolean().optional().describe('Only name, requests, error rate and p95 duration.'),
});

const listOutput = z.object({
  account: z.number().int(),
  entityGuid: z.string(),
  since: z.string(),
  until: z.string(),
  sortBy: z.enum(['slowest', 'errors', 'throughput']),
  transactions: z.array(z.record(z.string(), z.unknown())),
  /** The page is full: more transactions may exist. Raise limit or filter. */
  maybeMore: z.boolean(),
});

const LIST_DESCRIPTION = `Rank the transactions of an APM application (guid or name) by p95 latency (default), errors or throughput, with throughput, error count and rate, and average, p50, p95 and p99 duration in seconds.

Use it to find which endpoints to look at. Rows with few requests have noisy percentiles: check the requests column. For the application as a whole, or a before/after view, use analyze_transactions. ${UNTRUSTED}`;

const LIST_MINIMAL = ['name', 'requests', 'errorRate', 'p95Duration'] as const;

// ---------------------------------------------------------------------------------------------------------------------
// analyze_transactions
// ---------------------------------------------------------------------------------------------------------------------

const analyzeInput = z.strictObject({
  entity_guid: GUID_FIELD,
  transaction_name: z
    .string()
    .min(1)
    .max(MAX_NAME_CHARS)
    .optional()
    .describe('Only this transaction (exact name from list_top_transactions). Default: all.'),
  transaction_type: TYPE_FIELD,
  time_range: RANGE_FIELD,
  compare_previous: z
    .boolean()
    .optional()
    .describe('Also compare with the equal window before (default true; false saves a request).'),
});

const statsOut = z.object({
  requests: z.number().nullable(),
  throughputPerMinute: z.number().nullable(),
  errors: z.number().nullable(),
  errorRate: z.number().nullable(),
  avgDuration: z.number().nullable(),
  p50Duration: z.number().nullable(),
  p95Duration: z.number().nullable(),
  p99Duration: z.number().nullable(),
});

const analyzeOutput = z.object({
  account: z.number().int(),
  entityGuid: z.string(),
  transaction: z.string().nullable(),
  window: z.object({ since: z.string(), until: z.string(), minutes: z.number() }),
  previousWindow: z.object({ since: z.string(), until: z.string() }).nullable(),
  current: statsOut.nullable(),
  previous: statsOut.nullable(),
  /** Verdicts for current vs previous (null when not compared). */
  comparison: z
    .object({
      overall: z.enum(['regression_suspected', 'improvement', 'no_significant_change', 'inconclusive']),
      metrics: z.array(
        z.object({
          metric: z.string(),
          unit: z.string(),
          before: z.number().nullable(),
          after: z.number().nullable(),
          delta: z.number().nullable(),
          changeRatio: z.number().nullable(),
          verdict: z.string(),
          note: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
  /** A window was not queried (budget) or failed. */
  partial: z.boolean(),
  notes: z.array(z.string()),
});

const ANALYZE_DESCRIPTION = `Summarise the performance of an APM application (guid or name), or of one transaction in it: requests, throughput per minute, error rate, and average, p50, p95 and p99 duration, compared by default with the equal window before (worse, better or similar per metric).

Runs 2 requests (1 with compare_previous false); a stopped earlier window leaves the current one (partial). Verdicts need at least 30 requests per window. To pick a transaction_name use list_top_transactions; to compare around a specific deployment use analyze_deployment_impact. ${UNTRUSTED}`;

const fmt = (v: number | null) => (v === null ? '' : String(Number(v.toPrecision(4))));
const pct = (r: number | null) => (r === null ? '' : `${r >= 0 ? '+' : ''}${(r * 100).toFixed(1)}%`);

function statsOutput(s: TxStats, minutes: number) {
  return {
    requests: s.requests,
    throughputPerMinute: perMinute(s.requests, minutes),
    errors: s.errors,
    errorRate: rounded(s.errorRate),
    avgDuration: rounded(s.avgDuration),
    p50Duration: rounded(s.p50Duration),
    p95Duration: rounded(s.p95Duration),
    p99Duration: rounded(s.p99Duration),
  };
}

/** `list_top_transactions` and `analyze_transactions` (read-only, APM Transaction events). */
export function createApmTools(deps: ToolDeps = {}): ToolDefinition[] {
  const client = toolClient(deps);

  const run = (ctx: ToolContext, account: number, query: NrqlQuery) =>
    runNrql(
      ctx,
      // One poll at most: a slow query is reported rather than spending the budget.
      { nrql: query, accounts: [account], mode: 'auto', maxPolls: 1 },
      { client: client(ctx), ...(deps.sleep ? { sleep: deps.sleep } : {}) },
    );

  const top = defineTool({
    name: 'list_top_transactions',
    title: 'List top transactions',
    description: LIST_DESCRIPTION,
    inputSchema: listInput,
    outputSchema: listOutput,
    kind: 'read',
    openWorld: true,
    // One NRQL.
    cost: NRQL_COST,
    group: 'performance',
    phase: 6,
    handler: async (args, ctx) => {
      // The account comes from the GUID, checked offline; the query runs in that account only (T3).
      const decoded = checkGuid(ctx, args.entity_guid);
      const account = singleAccount(ctx, decoded.accountId);
      const range = parseTimeRange(args.time_range ?? DEFAULT_WINDOW, ctx.clock.now());
      assertWindowWithinLimit(range, ctx.limits);
      const limit = args.limit ?? DEFAULT_LIMIT;
      const sortBy = args.sort_by ?? 'slowest';
      const pattern = args.name_contains === undefined ? undefined : likePattern(args.name_contains);

      const outcome = await run(
        ctx,
        account,
        topQuery(
          args.entity_guid,
          range.sinceMs,
          range.untilMs,
          sortBy,
          limit,
          pattern,
          args.transaction_type,
        ),
      );
      if (outcome.status === 'pending') {
        throw new RbError(ErrorCode.NerdGraphTimeout, 'The query is still running at New Relic.', {
          hint: 'Try again shortly, or use a shorter time_range.',
        });
      }
      const done: NrqlComplete = outcome;
      const minutes = range.windowMs / MINUTE_MS;
      const rows = done.results.flatMap((r) => {
        const facet = Array.isArray(r['facet']) ? r['facet'][0] : (r['facet'] ?? r['name']);
        if (typeof facet !== 'string') return [];
        const s = txStats(r);
        return [
          {
            name: cleanName(facet, MAX_NAME_CHARS),
            ...statsOutput(s, minutes),
          },
        ];
      });
      const sortKey = (r: (typeof rows)[number]): number =>
        (sortBy === 'errors' ? r.errors : sortBy === 'throughput' ? r.requests : r.p95Duration) ?? -1;
      rows.sort((a, b) => sortKey(b) - sortKey(a));
      const shown = rows.slice(0, limit);
      const transactions = args.minimal_output
        ? pickFields(shown, LIST_MINIMAL)
        : (shown as Record<string, unknown>[]);
      const maybeMore = done.results.length >= limit;

      const lines = [
        `${shown.length} transaction${shown.length === 1 ? '' : 's'} of the application in account ${account}, ${range.since} to ${range.until} (UTC), sorted by ${sortBy}. Durations are seconds.`,
      ];
      if (maybeMore)
        lines.push('The list is full: more transactions may exist. Raise limit or filter by name.');
      if (shown.length === 0)
        lines.push('No transactions found. Check the guid is an APM application and the window.');
      else {
        lines.push(
          shapeRows(
            shown.map((r) => ({
              name: r.name,
              requests: fmt(r.requests),
              per_min: fmt(r.throughputPerMinute),
              errors: fmt(r.errors),
              error_pct: fmt(r.errorRate),
              avg: fmt(r.avgDuration),
              p50: fmt(r.p50Duration),
              p95: fmt(r.p95Duration),
              p99: fmt(r.p99Duration),
            })),
            { format: 'csv', source: 'New Relic Transaction data', maxRows: MAX_LIMIT },
          ).text,
        );
      }
      return {
        text: lines.join('\n'),
        structured: {
          account,
          entityGuid: args.entity_guid,
          since: range.since,
          until: range.until,
          sortBy,
          transactions,
          maybeMore,
        },
      };
    },
  });

  type Outcome = { ok: true; stats: TxStats } | { ok: false; note: string };

  async function window(ctx: ToolContext, account: number, query: NrqlQuery): Promise<Outcome> {
    try {
      const outcome = await run(ctx, account, query);
      if (outcome.status === 'pending')
        return { ok: false, note: 'Still running at New Relic; try again shortly.' };
      const done: NrqlComplete = outcome;
      return { ok: true, stats: txStats(done.results[0]) };
    } catch (e) {
      if (!(e instanceof RbError) || FATAL_CODES.has(e.code)) throw e;
      if (e.code === ErrorCode.BudgetExhausted) return { ok: false, note: 'Request budget exhausted.' };
      return { ok: false, note: errorNote(e) };
    }
  }

  const analyze = defineTool({
    name: 'analyze_transactions',
    title: 'Analyze transactions',
    description: ANALYZE_DESCRIPTION,
    inputSchema: analyzeInput,
    outputSchema: analyzeOutput,
    kind: 'read',
    openWorld: true,
    // The current window and, by default, the previous one (one NRQL each).
    cost: 2 * NRQL_COST,
    group: 'performance',
    phase: 6,
    handler: async (args, ctx) => {
      const decoded = checkGuid(ctx, args.entity_guid);
      const account = singleAccount(ctx, decoded.accountId);
      const range = parseTimeRange(args.time_range ?? DEFAULT_WINDOW, ctx.clock.now());
      assertWindowWithinLimit(range, ctx.limits);
      const minutes = range.windowMs / MINUTE_MS;
      const compare = args.compare_previous ?? true;
      const prev = { sinceMs: range.sinceMs - range.windowMs, untilMs: range.sinceMs };

      const queries = [
        {
          name: 'Current',
          q: summaryQuery(
            args.entity_guid,
            range.sinceMs,
            range.untilMs,
            args.transaction_name,
            args.transaction_type,
          ),
        },
        ...(compare
          ? [
              {
                name: 'Previous',
                q: summaryQuery(
                  args.entity_guid,
                  prev.sinceMs,
                  prev.untilMs,
                  args.transaction_name,
                  args.transaction_type,
                ),
              },
            ]
          : []),
      ];
      // Budget-aware: the current window comes first, the rest is skipped when the budget is short.
      const startable = startableNrql(queries.length, ctx.budget.remaining);
      const ran = await Promise.all(queries.slice(0, startable).map((w) => window(ctx, account, w.q)));
      const outcomes = queries.map(
        (_, i): Outcome => ran[i] ?? { ok: false, note: 'Request budget exhausted.' },
      );
      const cur = outcomes[0] as Outcome;
      const prv = compare ? (outcomes[1] as Outcome) : null;
      const notes: string[] = [];
      if (!cur.ok) notes.push(`Current window: ${cur.note}`);
      if (prv && !prv.ok) notes.push(`Previous window: ${prv.note}`);
      const partial = !cur.ok || (prv !== null && !prv.ok);

      let comparison: ReturnType<typeof compareWindows> | null = null;
      if (prv) {
        comparison = compareWindows(prv.ok ? prv.stats : null, cur.ok ? cur.stats : null, minutes);
      }
      const current = cur.ok ? statsOutput(cur.stats, minutes) : null;
      const previous = prv?.ok ? statsOutput(prv.stats, minutes) : null;
      if (cur.ok && cur.stats.requests === 0)
        notes.push(
          'No transactions in the window. Check the guid is an APM application, the name and the window.',
        );

      const label =
        args.transaction_name === undefined ? null : cleanName(args.transaction_name, MAX_NAME_CHARS);
      const lines = [
        `Transactions ${label === null ? 'of the application' : 'named in the request'} in account ${account}, ${range.since} to ${range.until} (UTC, ${Math.round(minutes * 100) / 100} minutes)${prv ? ', compared with the window just before' : ''}. Durations are seconds.`,
      ];
      if (comparison)
        lines.push(
          `Overall: ${comparison.overall.replaceAll('_', ' ')}.${partial ? ' Partial result: see notes.' : ''}`,
        );
      else if (partial) lines.push('Partial result: see notes.');
      for (const n of notes) lines.push(`Note: ${n}`);
      if (comparison) {
        lines.push(
          shapeRows(
            comparison.metrics.map((m) => ({
              metric: m.metric,
              unit: m.unit,
              before: fmt(m.before),
              after: fmt(m.after),
              change: pct(m.changeRatio),
              verdict: m.verdict,
              note: m.note ?? '',
            })),
            { format: 'table', source: 'New Relic Transaction data', maxRows: 10 },
          ).text,
        );
      }
      if (current) {
        lines.push(
          shapeRows(
            [
              { window: 'current', ...asCells(current) },
              ...(previous ? [{ window: 'previous', ...asCells(previous) }] : []),
            ],
            { format: 'table', source: 'New Relic Transaction data', maxRows: 2 },
          ).text,
        );
      }
      return {
        text: lines.join('\n'),
        structured: {
          account,
          entityGuid: args.entity_guid,
          transaction: label,
          window: { since: range.since, until: range.until, minutes: Math.round(minutes * 100) / 100 },
          previousWindow: compare
            ? { since: new Date(prev.sinceMs).toISOString(), until: new Date(prev.untilMs).toISOString() }
            : null,
          current,
          previous,
          comparison,
          partial,
          notes,
        },
      };
    },
  });

  return [top as ToolDefinition, analyze as ToolDefinition];
}

function asCells(s: ReturnType<typeof statsOutput>) {
  return {
    requests: fmt(s.requests),
    per_min: fmt(s.throughputPerMinute),
    error_pct: fmt(s.errorRate),
    avg: fmt(s.avgDuration),
    p50: fmt(s.p50Duration),
    p95: fmt(s.p95Duration),
    p99: fmt(s.p99Duration),
  };
}
