// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import {
  DEFAULT_MAX_POLLS,
  getQueryResult,
  MAX_NRQL_TIMEOUT_S,
  type NrqlOutcome,
  QUERY_ID_RE,
  runRawNrql,
} from '../nrql/engine.ts';
import { assertRawNrqlAllowed } from '../nrql/limits.ts';
import {
  DEFAULT_OUTPUT_CAPS,
  MAX_OUTPUT_CAPS,
  OUTPUT_FORMATS,
  type OutputFormat,
  TABLE_MAX_COLUMNS,
} from '../output/format.ts';
import { nrqlResultSchema, shapeNrqlOutcome } from '../output/nrql.ts';
import { DETAIL_MODES, type DetailMode } from '../output/summarize.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { accountIdSchema as accountId, type ToolDeps, toolClient, UNTRUSTED } from './shared.ts';

export type { ToolDeps };

/** Longest NRQL text `run_nrql` accepts. Real queries are far shorter; this bounds parsing work (T5). */
export const MAX_NRQL_CHARS = 4096;
/** Most accounts one cross-account `run_nrql` call may name. */
export const MAX_QUERY_ACCOUNTS = 20;

const format = z
  .enum(OUTPUT_FORMATS as [OutputFormat, ...OutputFormat[]])
  .optional()
  .describe(
    `Text format: "auto" (default: table, CSV above ${TABLE_MAX_COLUMNS} columns), "table", "csv", "json". structuredContent is always JSON.`,
  );

const detail = z
  .enum(DETAIL_MODES as [DetailMode, ...DetailMode[]])
  .optional()
  .describe(
    'Big timeseries/facet results: "auto" (default) summarizes, "full" returns max_rows rows, "summary" always.',
  );

const maxRows = z
  .number()
  .int()
  .min(1)
  .max(MAX_OUTPUT_CAPS.maxRows)
  .optional()
  .describe(
    `Most rows shown (default ${DEFAULT_OUTPUT_CAPS.maxRows}, max ${MAX_OUTPUT_CAPS.maxRows}). Display cap only (NRQL LIMIT limits the query).`,
  );

// Strict: an unknown argument (e.g. `account` instead of `accounts`) must fail, not silently query the default account.
const runNrqlInput = z.strictObject({
  nrql: z
    .string()
    .min(1)
    .max(MAX_NRQL_CHARS)
    .describe('Full NRQL with SINCE; FACET … LIMIT n for breakdowns, LIMIT for raw events.'),
  accounts: z
    .array(accountId)
    .min(1)
    .max(MAX_QUERY_ACCOUNTS)
    .optional()
    .describe('Account ids (list_accounts). Default: the default. Several run a cross-account query.'),
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_NRQL_TIMEOUT_S)
    .optional()
    .describe(`Seconds to wait (1–${MAX_NRQL_TIMEOUT_S}, default 10). A slower query returns a handle.`),
  format,
  detail,
  max_rows: maxRows,
  cache: z.enum(['use', 'bypass']).optional().describe('"bypass" skips the short-lived query cache.'),
});

const getQueryResultInput = z.strictObject({
  query_id: z
    .string()
    .regex(QUERY_ID_RE)
    .describe('The queryId returned by run_nrql when the query was still running.'),
  account: accountId.describe('The account the query runs in (the accountId returned with the queryId).'),
  format,
  detail,
  max_rows: maxRows,
});

const RUN_NRQL_DESCRIPTION = `Run a read-only NRQL query and return the rows: the general-purpose tool for counts, rates, percentiles, top-N, time series and raw events.

Prefer a purpose-built tool when one fits (entity_health, analyze_transactions, list_error_groups...): fewer requests. NRQL tips:
- Always add SINCE (e.g. SINCE 1 hour ago); long windows may exceed the connection's query limits.
- Aggregate rather than pulling raw events: count(*), average(), percentile(duration, 95), uniqueCount().
- FACET attr LIMIT n for top-N, TIMESERIES 5 minutes for trends, WHERE to filter.
- Raw-event queries get LIMIT 10 unless you set one; the connection caps every LIMIT.
- Unsure of event types or attribute names? Call list_event_types and get_attributes instead of guessing.
A query still running after timeout_seconds returns a queryId and accountId: pass them to get_query_result (query_id, account) after the suggested wait. ${UNTRUSTED}`;

const GET_QUERY_RESULT_DESCRIPTION = `Fetch the result of a slow NRQL query that run_nrql returned as still running (status "pending"), using the queryId and accountId from that response.

If it is still running you get the handle back with a new wait time: call again later. New Relic keeps results only until expiresAt. ${UNTRUSTED}`;

/**
 * Tools that run agent-written NRQL. When a connection's `limits.rawNrql` is off they must not be registered at all
 * (hidden from `tools/list`, not only refused): stdio `selectTools` and the access resolver (P2-04) both use this.
 */
export const RAW_NRQL_TOOLS: readonly string[] = Object.freeze(['run_nrql', 'get_query_result']);

/** `run_nrql` and `get_query_result`. Both need raw NRQL enabled on the connection (`limits.rawNrql`). */
export function createQueryTools(deps: ToolDeps = {}): ToolDefinition[] {
  const client = toolClient(deps);

  const runNrql = defineTool({
    name: 'run_nrql',
    title: 'Run NRQL query',
    description: RUN_NRQL_DESCRIPTION,
    inputSchema: runNrqlInput,
    outputSchema: nrqlResultSchema,
    kind: 'read',
    openWorld: true,
    // One submit plus the default polls.
    cost: 1 + DEFAULT_MAX_POLLS,
    group: 'query',
    phase: 1,
    handler: async (input, ctx) => {
      const outcome = await runRawNrql(
        ctx,
        {
          nrql: input.nrql,
          ...(input.accounts ? { accounts: input.accounts } : {}),
          ...(input.timeout_seconds === undefined ? {} : { timeoutS: input.timeout_seconds }),
          mode: 'auto',
          ...(input.cache === undefined ? {} : { cache: input.cache }),
        },
        { client: client(ctx), ...(deps.sleep ? { sleep: deps.sleep } : {}) },
      );
      return shape(outcome, input);
    },
  });

  const getResult = defineTool({
    name: 'get_query_result',
    title: 'Get NRQL query result',
    description: GET_QUERY_RESULT_DESCRIPTION,
    inputSchema: getQueryResultInput,
    outputSchema: nrqlResultSchema,
    kind: 'read',
    openWorld: true,
    cost: 1,
    group: 'query',
    phase: 1,
    handler: async (input, ctx) => {
      // Handles only come from run_nrql, so the same switch applies.
      assertRawNrqlAllowed(ctx.limits);
      const outcome = await getQueryResult(
        ctx,
        { queryId: input.query_id, account: input.account },
        { client: client(ctx) },
      );
      return shape(outcome, input);
    },
  });

  return [runNrql as ToolDefinition, getResult as ToolDefinition];
}

function shape(
  outcome: NrqlOutcome,
  input: {
    format?: OutputFormat | undefined;
    max_rows?: number | undefined;
    detail?: DetailMode | undefined;
  },
) {
  return shapeNrqlOutcome(outcome, {
    ...(input.format === undefined ? {} : { format: input.format }),
    ...(input.max_rows === undefined ? {} : { maxRows: input.max_rows }),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  });
}
