// SPDX-License-Identifier: Apache-2.0
// list_synthetic_monitors: monitors by entity search (metadata only, never scripts or secure credentials) plus recent
// SyntheticCheck results per location. Field and attribute names are from documentation and unverified
// (docs/RESEARCH.md). Monitor names, URLs, locations and failure messages are written by third parties and are scrubbed
// (THREAT_MODEL T6).
import { z } from 'zod';
import type { ToolContext } from '../context.ts';
import { ErrorCode, RbError } from '../errors.ts';
import { entityQuery } from '../nerdgraph/entity-query.ts';
import { SYNTHETIC_MONITORS_QUERY, type SyntheticMonitorOutline } from '../nerdgraph/synthetics.ts';
import { runNrql } from '../nrql/engine.ts';
import { type NrqlQuery, nrql } from '../nrql/template.ts';
import { shapeRows } from '../output/format.ts';
import { parseTimeRange } from '../time/range.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { FATAL_CODES } from './changes.ts';
import { guidAgrees, isNonNull, requireField } from './entities.ts';
import { cleanName, errorNote } from './identity.ts';
import { bindingOf, pageUpstream } from './paging.ts';
import {
  accountInput,
  assertWindowWithinLimit,
  cursorInput,
  label,
  NRQL_COST,
  num,
  singleAccount,
  type ToolDeps,
  toolClient,
  UNTRUSTED,
} from './shared.ts';

const DEFAULT_WINDOW = 'last 1 hour';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const RESULT_ROWS = 2000;
const MAX_LOCATIONS_PER_MONITOR = 20;
const MAX_LOCATION_LINES = 30;
const MAX_URL_CHARS = 300;
const MAX_ERROR_CHARS = 200;

const MONITOR_TYPES = ['SIMPLE', 'BROWSER', 'SCRIPT_API', 'SCRIPT_BROWSER', 'STEP_MONITOR'] as const;
const STATUSES = ['ENABLED', 'MUTED', 'DISABLED'] as const;

// ---------------------------------------------------------------------------------------------------------------------
// Pure builders and readers
// ---------------------------------------------------------------------------------------------------------------------

/** Check results of the given monitors per monitor and location. Only the `nrql` tag builds it (T4). */
export function checkQuery(guids: readonly string[], sinceMs: number, untilMs: number): NrqlQuery {
  const since = Math.floor(sinceMs / 1000);
  const until = Math.ceil(untilMs / 1000);
  const result = nrql.identifier('result');
  return nrql`SELECT count(*) AS checks, filter(count(*), WHERE ${result} = 'FAILED') AS failures, average(${nrql.identifier('duration')}) AS avgDuration, latest(${result}) AS lastResult, max(${nrql.identifier('timestamp')}) AS lastAt, filter(latest(${nrql.identifier('error')}), WHERE ${result} = 'FAILED') AS lastError FROM SyntheticCheck WHERE ${nrql.identifier('entityGuid')} IN ${guids} FACET entityGuid, location LIMIT ${RESULT_ROWS} SINCE ${since} UNTIL ${until}`;
}

export interface LocationResult {
  readonly location: string;
  readonly checks: number;
  readonly failures: number;
  /** Percent 0-100, one decimal. */
  readonly failurePercent: number;
  readonly avgDurationMs: number | null;
  readonly lastResult: string | null;
  readonly lastCheckAt: string | null;
  readonly lastError: string | null;
}

export interface MonitorResults {
  readonly checks: number;
  readonly failures: number;
  readonly failurePercent: number;
  readonly lastResult: string | null;
  readonly lastCheckAt: string | null;
  readonly locations: LocationResult[];
}

const percent = (failures: number, checks: number): number =>
  checks === 0 ? 0 : Number(((failures / checks) * 100).toFixed(1));

const isoOrNull = (ms: number | null): string | null =>
  ms !== null && Math.abs(ms) < 8.64e15 ? new Date(ms).toISOString() : null;

/** Facet rows (entityGuid, location) to results per guid. Rows for guids not asked for are ignored. Pure. */
export function readChecks(
  rows: readonly Record<string, unknown>[],
  wanted: ReadonlySet<string>,
): Map<string, MonitorResults> {
  const perGuid = new Map<string, { loc: LocationResult; at: number }[]>();
  for (const r of rows) {
    const f = r['facet'];
    const guid = Array.isArray(f) ? f[0] : undefined;
    const loc = Array.isArray(f) ? f[1] : undefined;
    const checks = num(r['checks']);
    if (typeof guid !== 'string' || !wanted.has(guid) || typeof loc !== 'string' || checks === null) continue;
    const failures = Math.min(checks, Math.max(0, num(r['failures']) ?? 0));
    const at = num(r['lastAt']);
    const duration = num(r['avgDuration']);
    const lastResult = r['lastResult'];
    const lastError = r['lastError'];
    const entry = {
      loc: {
        location: cleanName(loc, 80),
        checks,
        failures,
        failurePercent: percent(failures, checks),
        avgDurationMs: duration === null ? null : Math.round(duration),
        lastResult: typeof lastResult === 'string' ? label(lastResult) : null,
        lastCheckAt: isoOrNull(at),
        lastError:
          failures > 0 && typeof lastError === 'string' && lastError !== ''
            ? cleanName(lastError, MAX_ERROR_CHARS)
            : null,
      },
      at: at ?? 0,
    };
    perGuid.set(guid, [...(perGuid.get(guid) ?? []), entry]);
  }
  const out = new Map<string, MonitorResults>();
  for (const [guid, entries] of perGuid) {
    const checks = entries.reduce((s, e) => s + e.loc.checks, 0);
    const failures = entries.reduce((s, e) => s + e.loc.failures, 0);
    const newest = entries.reduce((a, b) => (b.at > a.at ? b : a));
    const locations = entries
      .map((e) => e.loc)
      .sort(
        (a, b) =>
          b.failurePercent - a.failurePercent ||
          b.failures - a.failures ||
          a.location.localeCompare(b.location),
      );
    out.set(guid, {
      checks,
      failures,
      failurePercent: percent(failures, checks),
      lastResult: newest.loc.lastResult,
      lastCheckAt: newest.loc.lastCheckAt,
      locations: locations.slice(0, MAX_LOCATIONS_PER_MONITOR),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------------------------------------------------

const input = z.strictObject({
  account: accountInput,
  name_contains: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Only monitors whose name contains this text.'),
  monitor_type: z
    .enum(MONITOR_TYPES)
    .optional()
    .describe('Only this monitor type (applied to the page of monitors returned).'),
  status: z
    .enum(STATUSES)
    .optional()
    .describe('Only monitors with this status (applied to the page of monitors returned).'),
  include_results: z
    .boolean()
    .optional()
    .describe('Add recent check results per monitor and location (default true; costs one more request).'),
  time_range: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(`Window for the check results (default "${DEFAULT_WINDOW}").`),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Monitors per page (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
  cursor: cursorInput,
  minimal_output: z
    .boolean()
    .optional()
    .describe('Fewer fields per monitor: no URL, no per-location detail.'),
});

const locationSchema = z.object({
  location: z.string(),
  checks: z.number(),
  failures: z.number(),
  failurePercent: z.number(),
  avgDurationMs: z.number().nullable(),
  lastResult: z.string().nullable(),
  lastCheckAt: z.string().nullable(),
  lastError: z.string().nullable(),
});

const output = z.object({
  accountId: z.number().int(),
  since: z.string().nullable(),
  until: z.string().nullable(),
  monitors: z.array(
    z.object({
      guid: z.string(),
      name: z.string(),
      monitorType: z.string().nullable(),
      status: z.string().nullable(),
      periodMinutes: z.number().nullable(),
      monitoredUrl: z.string().nullable().optional(),
      alertSeverity: z.string().nullable(),
      /** Null when results were not requested or could not be read. */
      checks: z.number().nullable(),
      failures: z.number().nullable(),
      failurePercent: z.number().nullable(),
      lastResult: z.string().nullable(),
      lastCheckAt: z.string().nullable(),
      locations: z.array(locationSchema).optional(),
    }),
  ),
  total: z.number().int().nullable(),
  nextCursor: z.string().nullable(),
  hiddenOutsideScope: z.boolean(),
  partial: z.boolean(),
  notes: z.array(z.string()),
});

const DESCRIPTION = `List the synthetic monitors of one account (type, status, run period, monitored URL, alert severity) and, by default, their recent results: checks, failures, failure percentage, average duration, latest result and failure message, per monitor and per location (failing first).

Runs 2 requests (monitor search, then SyntheticCheck results); if the second is stopped the monitors still come back (partial). monitor_type and status filter the returned page only. Page with cursor. Scripts, secure credentials and request headers are never read. ${UNTRUSTED}`;

/** `list_synthetic_monitors` (read-only). */
export function createSyntheticTools(deps: ToolDeps = {}): ToolDefinition[] {
  const client = toolClient(deps);

  const readResults = async (
    ctx: ToolContext,
    account: number,
    guids: string[],
    sinceMs: number,
    untilMs: number,
  ): Promise<{ rows: Record<string, unknown>[] } | { note: string }> => {
    try {
      const outcome = await runNrql(
        ctx,
        { nrql: checkQuery(guids, sinceMs, untilMs), accounts: [account], mode: 'auto', maxPolls: 1 },
        { client: client(ctx), ...(deps.sleep ? { sleep: deps.sleep } : {}) },
      );
      if (outcome.status === 'pending') return { note: 'Still running at New Relic; try again shortly.' };
      return { rows: outcome.results as Record<string, unknown>[] };
    } catch (e) {
      if (!(e instanceof RbError) || FATAL_CODES.has(e.code)) throw e;
      if (e.code === ErrorCode.BudgetExhausted) return { note: 'Request budget exhausted.' };
      return { note: errorNote(e) };
    }
  };

  const list = defineTool({
    name: 'list_synthetic_monitors',
    title: 'List synthetic monitors',
    description: DESCRIPTION,
    inputSchema: input,
    outputSchema: output,
    kind: 'read',
    openWorld: true,
    // Monitor search plus the check-results NRQL.
    cost: 1 + NRQL_COST,
    group: 'alerting',
    phase: 6,
    handler: async (args, ctx) => {
      const account = singleAccount(ctx, args.account);
      const wantResults = args.include_results !== false;
      const range = wantResults ? parseTimeRange(args.time_range ?? DEFAULT_WINDOW, ctx.clock.now()) : null;
      if (range) assertWindowWithinLimit(range, ctx.limits, ctx.clock.now());
      const limit = args.limit ?? DEFAULT_LIMIT;

      const parts = [
        entityQuery`accountId = ${account}`,
        entityQuery`domain = 'SYNTH'`,
        entityQuery`type = 'MONITOR'`,
      ];
      if (args.name_contains) parts.push(entityQuery`name LIKE ${`%${args.name_contains}%`}`);
      const query = entityQuery.and(parts);
      let count: unknown;
      const page = await pageUpstream({
        binding: await bindingOf('list_synthetic_monitors', account, query.text),
        cursor: args.cursor,
        limit,
        fetchPage: async (upstream) => {
          const result = await client(ctx).query(SYNTHETIC_MONITORS_QUERY, {
            query: query.text,
            cursor: upstream,
            options: { limit },
          });
          const es = requireField(result.data.actor.entitySearch, result, ctx);
          count = es.count;
          return { items: (es.results?.entities ?? []).filter(isNonNull), next: es.results?.nextCursor };
        },
      });
      const all = page.items;
      // Defence in depth (T3): the filter names the account; drop anything else NerdGraph returns.
      const inScope = (e: SyntheticMonitorOutline) =>
        e.accountId === account && typeof e.guid === 'string' && guidAgrees(e.guid, account);
      const scoped = all.filter(inScope).slice(0, limit);
      const hidden = all.some((e) => !inScope(e));
      const matches = scoped.filter(
        (e) =>
          (args.monitor_type === undefined || e.monitorType === args.monitor_type) &&
          (args.status === undefined || e.monitorSummary?.status === args.status),
      );
      const nextCursor = page.nextCursor;
      const total = num(count);

      const notes: string[] = [];
      if (hidden) notes.push("Results outside this connection's accounts were left out.");
      if (matches.length < scoped.length)
        notes.push(
          `${scoped.length - matches.length} monitor(s) on this page did not match monitor_type/status; more pages may hold matches.`,
        );

      let partial = false;
      let results = new Map<string, MonitorResults>();
      let resultsRead = false;
      if (wantResults && range && matches.length > 0) {
        if (ctx.budget.remaining < NRQL_COST) {
          partial = true;
          notes.push('Check results: Request budget exhausted.');
        } else {
          const guids = matches.map((e) => e.guid as string);
          const read = await readResults(ctx, account, guids, range.sinceMs, range.untilMs);
          if ('note' in read) {
            partial = true;
            notes.push(`Check results: ${read.note}`);
          } else {
            resultsRead = true;
            results = readChecks(read.rows, new Set(guids));
            if (read.rows.length >= RESULT_ROWS)
              notes.push(`Results are based on the first ${RESULT_ROWS} monitor/location combinations.`);
          }
        }
      }

      const minimal = args.minimal_output === true;
      const monitors = matches.map((e) => {
        const guid = e.guid as string;
        const r = results.get(guid);
        const period = typeof e.period === 'number' ? e.period : null;
        const base = {
          guid,
          name: cleanName(e.name ?? ''),
          monitorType: label(e.monitorType),
          status: label(e.monitorSummary?.status),
          periodMinutes: period !== null && Number.isFinite(period) ? period : null,
          alertSeverity: label(e.alertSeverity),
          checks: resultsRead ? (r?.checks ?? 0) : null,
          failures: resultsRead ? (r?.failures ?? 0) : null,
          failurePercent: resultsRead ? (r?.failurePercent ?? 0) : null,
          lastResult: r?.lastResult ?? null,
          lastCheckAt: r?.lastCheckAt ?? null,
        };
        if (minimal) return base;
        return {
          ...base,
          monitoredUrl:
            typeof e.monitoredUrl === 'string' && e.monitoredUrl !== ''
              ? cleanName(e.monitoredUrl, MAX_URL_CHARS)
              : null,
          ...(r ? { locations: r.locations } : {}),
        };
      });

      if (resultsRead) {
        const silent = monitors.filter((m) => m.checks === 0).length;
        if (silent > 0)
          notes.push(`${silent} monitor(s) had no checks in the window (disabled, muted or not yet run).`);
      }

      const lines = [
        `${monitors.length} synthetic monitor${monitors.length === 1 ? '' : 's'} in account ${account}` +
          `${total !== null && total > monitors.length ? ` (${total} match the search in total)` : ''}` +
          `${resultsRead && range ? `; checks ${range.since} to ${range.until} (UTC)` : ''}.` +
          `${partial ? ' Partial result: see notes.' : ''}`,
      ];
      for (const n of notes) lines.push(`Note: ${n}`);
      if (nextCursor)
        lines.push('More monitors: call again with the same filters and cursor set to the nextCursor below.');
      if (monitors.length > 0) {
        lines.push(
          shapeRows(
            monitors.map((m) => {
              const row: Record<string, unknown> = {
                name: m.name,
                type: m.monitorType ?? '',
                status: m.status ?? '',
                period_min: m.periodMinutes ?? '',
                alert: m.alertSeverity ?? '',
              };
              if (resultsRead) {
                row['checks'] = m.checks ?? '';
                row['failed_pct'] = m.failurePercent ?? '';
                row['last'] = m.lastResult ?? '';
              }
              return row;
            }),
            { format: 'table', source: 'New Relic synthetic monitors', maxRows: MAX_LIMIT },
          ).text,
        );
        if (!minimal && resultsRead) {
          const failing: Record<string, unknown>[] = [];
          for (const m of monitors) {
            for (const l of 'locations' in m ? (m.locations ?? []) : []) {
              if (l.failures > 0)
                failing.push({
                  monitor: m.name,
                  location: l.location,
                  failed_pct: l.failurePercent,
                  last_error: l.lastError ?? '',
                });
            }
          }
          if (failing.length > 0)
            lines.push(
              'Locations with failures:',
              shapeRows(failing.slice(0, MAX_LOCATION_LINES), {
                format: 'table',
                source: 'New Relic synthetic checks',
                maxRows: MAX_LOCATION_LINES,
              }).text,
            );
        }
      }
      if (nextCursor) lines.push(`nextCursor: ${nextCursor}`);

      return {
        text: lines.join('\n'),
        structured: {
          accountId: account,
          since: resultsRead && range ? range.since : null,
          until: resultsRead && range ? range.until : null,
          monitors,
          total,
          nextCursor,
          hiddenOutsideScope: hidden,
          partial,
          notes,
        },
      };
    },
  });

  return [list as ToolDefinition];
}
