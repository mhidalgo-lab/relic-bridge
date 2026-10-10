// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { NrqlComplete, NrqlOutcome, NrqlPending } from '../nrql/engine.ts';
import { redactValue } from '../redact.ts';
import type { ToolOutput } from '../tool.ts';
import { estimateTokens, type ShapeRowsOptions, shapeRows } from './format.ts';

/** `_meta` key carrying result metadata (format, truncation, NRQL actually run…), next to `relic-bridge/error`. */
export const RESULT_META_KEY = 'relic-bridge/result';

export const NRQL_NARROW_HINT =
  'narrow the NRQL: add WHERE filters, a shorter SINCE, fewer attributes, or aggregate (FACET … LIMIT n)';

/** `structuredContent` of an NRQL result. One object type (MCP output schemas must be objects); `status` tells which. */
export interface NrqlResult {
  status: 'complete' | 'pending';
  accounts: number[];
  /** Column names in display order (complete only). */
  columns?: string[] | undefined;
  /** The rows shown, with the same cuts as the text (complete only). */
  rows?: Record<string, unknown>[] | undefined;
  totalResult?: Record<string, unknown> | undefined;
  otherResult?: Record<string, unknown> | undefined;
  facets?: string[] | undefined;
  eventTypes?: string[] | undefined;
  timeseries?: boolean | undefined;
  totalRows?: number | undefined;
  returnedRows?: number | undefined;
  truncated: boolean;
  /** Pending only: pass to get_query_result together with `account`. */
  queryId?: string | undefined;
  account?: number | undefined;
  retryAfterS?: number | undefined;
  expiresAt?: string | undefined;
  /** The NRQL actually sent (after query limits). */
  nrql?: string | undefined;
  notes: string[];
  messages?: string[] | undefined;
}

/** Output schema for tools returning `shapeNrqlOutcome` results (P1-06). */
export const nrqlResultSchema: z.ZodType<NrqlResult> = z.object({
  status: z.enum(['complete', 'pending']),
  accounts: z.array(z.number().int()),
  columns: z.array(z.string()).optional(),
  rows: z.array(z.record(z.string(), z.unknown())).optional(),
  totalResult: z.record(z.string(), z.unknown()).optional(),
  otherResult: z.record(z.string(), z.unknown()).optional(),
  facets: z.array(z.string()).optional(),
  eventTypes: z.array(z.string()).optional(),
  timeseries: z.boolean().optional(),
  totalRows: z.number().int().optional(),
  returnedRows: z.number().int().optional(),
  truncated: z.boolean(),
  queryId: z.string().optional(),
  account: z.number().int().optional(),
  retryAfterS: z.number().optional(),
  expiresAt: z.string().optional(),
  nrql: z.string().optional(),
  notes: z.array(z.string()),
  messages: z.array(z.string()).optional(),
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
  readonly inspectedCount?: number;
  readonly polls: number;
  readonly notes: readonly string[];
  readonly tokenEstimate: number;
}

export type ShapeNrqlOptions = Omit<ShapeRowsOptions, 'totalRows' | 'columns' | 'trailer'>;

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
    accounts: [outcome.account],
    truncated: false,
    queryId: outcome.queryId,
    account: outcome.account,
    retryAfterS: outcome.retryAfterS,
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

function shapeComplete(outcome: NrqlComplete, options: ShapeNrqlOptions): ToolOutput<NrqlResult> {
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
  const shaped = shapeRows(outcome.results, {
    narrowHint: NRQL_NARROW_HINT,
    source: 'NRQL results',
    ...options,
    ...(trailer.length > 0 ? { trailer } : {}),
  });
  const total = outcome.results.length;
  const summary =
    `NRQL returned ${total.toLocaleString('en-US')} ${total === 1 ? 'row' : 'rows'} from ${accountsText(outcome.accounts)}` +
    `${seconds(outcome.durationMs)}` +
    (shaped.stats.returnedRows < total ? `; showing ${shaped.stats.returnedRows}` : '') +
    (outcome.stats?.inspectedCount === undefined
      ? '.'
      : `; ${outcome.stats.inspectedCount.toLocaleString('en-US')} events inspected.`);

  const lines = [summary, ...outcome.notes.map((n) => `Note: ${n}`), shaped.text];
  const clean = (v: Record<string, unknown>) =>
    (options.redactSecrets ?? true) ? (redactValue(v) as Record<string, unknown>) : v;
  const md = outcome.metadata;
  const structured: NrqlResult = {
    status: 'complete',
    accounts: [...outcome.accounts],
    columns: shaped.columns,
    rows: shaped.rows,
    ...(outcome.totalResult ? { totalResult: clean(outcome.totalResult) } : {}),
    ...(outcome.otherResult ? { otherResult: clean(outcome.otherResult) } : {}),
    facets: [...md.facets],
    eventTypes: [...md.eventTypes],
    timeseries: md.timeseries,
    totalRows: total,
    returnedRows: shaped.stats.returnedRows,
    truncated: shaped.stats.truncated,
    ...(outcome.nrql === undefined ? {} : { nrql: outcome.nrql }),
    notes: [...outcome.notes],
    messages: [...outcome.messages],
  };
  return finish(lines.join('\n'), structured, {
    status: 'complete',
    ...(outcome.nrql === undefined ? {} : { nrql: outcome.nrql }),
    accounts: outcome.accounts,
    ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
    format: shaped.format,
    totalRows: total,
    returnedRows: shaped.stats.returnedRows,
    truncated: shaped.stats.truncated,
    ...(outcome.stats?.inspectedCount === undefined ? {} : { inspectedCount: outcome.stats.inspectedCount }),
    polls: outcome.polls,
    notes: outcome.notes,
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
