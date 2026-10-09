// SPDX-License-Identifier: Apache-2.0
// trace_error, dependency_health, entity_health (P6-16). Investigation-shaped compound tools. Like the P6-10 reports they
// reuse the sibling tools (same scope checks, cleaning and envelopes, T3/T6) and plan their requests against the remaining
// budget before anything runs (ADR-0010): what does not fit is reported as skipped, never silently dropped.
import { z } from 'zod';
import type { ToolContext } from '../context.ts';
import { ErrorCode, RbError } from '../errors.ts';
import type { NrqlComplete } from '../nrql/engine.ts';
import { runNrql } from '../nrql/engine.ts';
import { type NrqlQuery, nrql } from '../nrql/template.ts';
import { envelope } from '../output/envelope.ts';
import { shapeRows } from '../output/format.ts';
import { parseTimeRange } from '../time/range.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { createChangeTools, FATAL_CODES } from './changes.ts';
import { checkGuid, createEntityTools } from './entities.ts';
import { createErrorTools } from './errors.ts';
import { createGoldenMetricTools } from './golden.ts';
import { cleanName } from './identity.ts';
import { createIssueTools } from './issues.ts';
import { cleanLogMessage } from './logs.ts';
import {
  BUDGET_NOTE,
  notRun,
  type PlanItem,
  planBudget,
  runSection,
  type SectionResult,
  type SectionStatus,
  sectionSchema,
} from './reports.ts';
import {
  accountInput,
  assertWindowWithinLimit,
  grantedSibling,
  label,
  num,
  singleAccount,
  type ToolDeps,
  timeRangeInput,
  toolClient,
  UNTRUSTED,
} from './shared.ts';

const DEFAULT_TRACE_WINDOW = 'last 24 hours';
const DEFAULT_HEALTH_WINDOW = 'last 6 hours';
const SPAN_LIMIT = 500;
const SPAN_ROWS_SHOWN = 30;
const LOG_LIMIT = 25;
const ERROR_LIMIT = 10;
const MAX_TEXT = 300;
const DEFAULT_DEPENDENCIES = 3;
const MAX_DEPENDENCIES = 5;
const DEFAULT_METRICS = 3;
const MAX_METRICS = 5;
const RELATED_FETCH = 25;
const HEALTH_METRICS = 5;
const DEFAULT_LOOKBACK_DAYS = 7;
/** Relative change of a golden metric that counts as a signal. */
export const SIGNAL_CHANGE = 0.25;

const TRACE_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const GROUP_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const guidInput = (what: string) =>
  z.string().min(8).max(512).describe(`${what} (guid from search_entities or resolve_entity).`);
const rangeInput = (fallback: string) => timeRangeInput(fallback);

// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------------

const isoOf = (ms: unknown): string | null => {
  const n = num(ms);
  return n === null || Math.abs(n) > 8.64e15 ? null : new Date(n).toISOString();
};

const str = (v: unknown, max = MAX_TEXT): string | null =>
  typeof v === 'string' && v !== '' ? cleanName(v, max) : null;

/** The path of a request URI, without query string or fragment (they carry tokens and personal data). */
export function uriPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const cut = raw.search(/[?#]/);
  return cleanName(cut === -1 ? raw : raw.slice(0, cut), 200) || null;
}

export interface SpanRow {
  readonly id: string | null;
  readonly parentId: string | null;
  readonly name: string | null;
  readonly service: string | null;
  readonly category: string | null;
  readonly durationMs: number | null;
  readonly timestamp: string | null;
  readonly errorClass: string | null;
  readonly errorMessage: string | null;
}

export function toSpan(row: Record<string, unknown>): SpanRow {
  return {
    id: str(row['id'], 64),
    parentId: str(row['parentId'], 64),
    name: str(row['name'], 200),
    service: str(row['service'], 128),
    category: label(typeof row['category'] === 'string' ? row['category'] : null),
    durationMs: num(row['durationMs']),
    timestamp: isoOf(row['timestamp']),
    errorClass: str(row['errorClass'], 200),
    errorMessage: str(row['errorMessage'], 300),
  };
}

export interface TraceShape {
  readonly total: number;
  readonly services: string[];
  readonly root: SpanRow | null;
  readonly errorSpans: number;
  readonly shown: SpanRow[];
  readonly truncated: boolean;
}

/**
 * The part of a trace worth reading: every error span first, then the slowest ones, up to `max` rows, in time order.
 * Roots are spans whose parent is absent from the trace. Pure.
 */
export function shapeTrace(spans: readonly SpanRow[], max: number = SPAN_ROWS_SHOWN): TraceShape {
  const ids = new Set(spans.flatMap((s) => (s.id ? [s.id] : [])));
  const roots = spans.filter((s) => s.parentId === null || !ids.has(s.parentId));
  const root = [...roots].sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''))[0] ?? null;
  const services = [...new Set(spans.flatMap((s) => (s.service ? [s.service] : [])))].sort();
  const isError = (s: SpanRow) => s.errorClass !== null || s.errorMessage !== null;
  const errors = spans.filter(isError);
  const byDuration = spans
    .filter((s) => !isError(s))
    .sort((a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1));
  const picked = [...errors, ...byDuration].slice(0, max);
  const shown = picked.sort(
    (a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '') || (a.id ?? '').localeCompare(b.id ?? ''),
  );
  return {
    total: spans.length,
    services,
    root,
    errorSpans: errors.length,
    shown,
    truncated: spans.length > shown.length,
  };
}

const LATENCY_TITLE = /error|fail|latenc|response|duration|time|cpu|memory|saturation|restart/i;
const VOLUME_TITLE = /throughput|apdex|request|rpm|invocation|count|rate of/i;

interface MetricLike {
  title: string;
  status: string;
  trend: string;
  changeRatio: number | null;
}

/** Short flags for an entity from its golden metrics and alert state. Pure. */
export function healthSignals(
  metrics: readonly MetricLike[],
  alertSeverity: string | null,
  reporting: boolean | null,
): string[] {
  const out: string[] = [];
  if (alertSeverity === 'CRITICAL' || alertSeverity === 'WARNING')
    out.push(`alert_${alertSeverity.toLowerCase()}`);
  if (reporting === false) out.push('not_reporting');
  for (const m of metrics) {
    if (m.status !== 'ok' || m.changeRatio === null) continue;
    const pct = `${m.changeRatio >= 0 ? '+' : ''}${(m.changeRatio * 100).toFixed(0)}%`;
    if (m.trend === 'up' && m.changeRatio >= SIGNAL_CHANGE && LATENCY_TITLE.test(m.title))
      out.push(`${m.title} up ${pct}`);
    else if (m.trend === 'down' && m.changeRatio <= -SIGNAL_CHANGE && VOLUME_TITLE.test(m.title))
      out.push(`${m.title} down ${pct}`);
  }
  return out;
}

const SEVERITY_RANK: Record<string, number> = { CRITICAL: 0, WARNING: 1, NOT_ALERTING: 3 };
const severityRank = (s: string | null) => (s === null ? 2 : (SEVERITY_RANK[s] ?? 2));

// ---------------------------------------------------------------------------------------------------------------------
// trace_error
// ---------------------------------------------------------------------------------------------------------------------

const traceInput = z.strictObject({
  trace_id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('A distributed trace id (trace.id). Give this or error_group_id.'),
  error_group_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'An error group id (list_error_groups): its latest traced occurrence is followed. Give this or trace_id.',
    ),
  entity_guid: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('With error_group_id: only occurrences from this entity. Implies its account.'),
  include_synthetic: z
    .boolean()
    .optional()
    .describe('With error_group_id: also pick occurrences caused by synthetic monitors (default false).'),
  time_range: rangeInput(DEFAULT_TRACE_WINDOW),
  account: accountInput,
});

const spanSchema = z.object({
  id: z.string().nullable(),
  parentId: z.string().nullable(),
  name: z.string().nullable(),
  service: z.string().nullable(),
  category: z.string().nullable(),
  durationMs: z.number().nullable(),
  timestamp: z.string().nullable(),
  errorClass: z.string().nullable(),
  errorMessage: z.string().nullable(),
});

const traceOutput = z.object({
  account: z.number().int(),
  traceId: z.string().nullable(),
  errorGroupId: z.string().nullable(),
  since: z.string(),
  until: z.string(),
  spans: z.object({
    total: z.number().int(),
    services: z.array(z.string()),
    errorSpans: z.number().int(),
    root: spanSchema.nullable(),
    shown: z.array(spanSchema),
    /** The trace has more spans than the rows shown (or than the 500 fetched). */
    truncated: z.boolean(),
  }),
  errors: z.array(z.record(z.string(), z.unknown())),
  logs: z.array(
    z.object({ timestamp: z.string().nullable(), level: z.string().nullable(), message: z.string() }),
  ),
  /** No spans were found for the trace: Span events are sampled, so it may have been dropped or be outside the window. */
  spansMissing: z.boolean(),
  partial: z.boolean(),
  notes: z.array(z.string()),
});

const TRACE_DESCRIPTION = `Follow one failing request through the system: from a trace_id, or from an error group (error_group_id from list_error_groups: its latest occurrence with a trace), get the trace's spans (services, root, error and slowest spans), the error events with request attributes (class, message, path, method, status) and the log lines with that trace id.

Use it for "follow this error" or "where did this request fail?". Runs 3 requests (4 with error_group_id); a part that fails or does not fit is noted (partial: true). spans_missing means the trace was sampled out or is outside time_range (default last 24 hours); errors and logs still help. Only log lines with the trace id are returned: for other lines use list_recent_logs with a narrow time_range. One account per call (an entity, by entity_guid or name, implies it); synthetic traffic is skipped unless include_synthetic; query strings are removed from paths. ${UNTRUSTED}`;

const spanQuery = (traceId: string, sinceMs: number, untilMs: number): NrqlQuery =>
  nrql`SELECT ${nrql.identifier('timestamp')}, id, ${nrql.identifier('parent.id')} AS parentId, name, ${nrql.identifier('entity.name')} AS service, category, ${nrql.identifier('duration.ms')} AS durationMs, ${nrql.identifier('error.class')} AS errorClass, ${nrql.identifier('error.message')} AS errorMessage FROM Span WHERE ${nrql.identifier('trace.id')} = ${traceId} LIMIT ${SPAN_LIMIT} SINCE ${Math.floor(sinceMs / 1000)} UNTIL ${Math.ceil(untilMs / 1000)}`;

const errorQuery = (traceId: string, sinceMs: number, untilMs: number): NrqlQuery =>
  nrql`SELECT ${nrql.identifier('timestamp')}, appName, ${nrql.identifier('error.class')} AS errorClass, ${nrql.identifier('error.message')} AS errorMessage, ${nrql.identifier('request.method')} AS requestMethod, ${nrql.identifier('request.uri')} AS requestUri, httpResponseCode, transactionName FROM TransactionError WHERE traceId = ${traceId} ORDER BY timestamp DESC LIMIT ${ERROR_LIMIT} SINCE ${Math.floor(sinceMs / 1000)} UNTIL ${Math.ceil(untilMs / 1000)}`;

const logQuery = (traceId: string, sinceMs: number, untilMs: number): NrqlQuery =>
  nrql`SELECT timestamp, level, message FROM Log WHERE ${nrql.identifier('trace.id')} = ${traceId} ORDER BY timestamp ASC LIMIT ${LOG_LIMIT} SINCE ${Math.floor(sinceMs / 1000)} UNTIL ${Math.ceil(untilMs / 1000)}`;

export function groupTraceQuery(
  groupId: string,
  entityGuid: string | undefined,
  includeSynthetic: boolean,
  sinceMs: number,
  untilMs: number,
): NrqlQuery {
  const entity =
    entityGuid === undefined ? nrql`` : nrql`AND ${nrql.identifier('entityGuid')} = ${entityGuid}`;
  const synthetic = includeSynthetic
    ? nrql``
    : nrql`AND ${nrql.identifier('nr.syntheticsMonitorId')} IS NULL`;
  return nrql`SELECT traceId, ${nrql.identifier('timestamp')} FROM TransactionError WHERE ${nrql.identifier('error.group.guid')} = ${groupId} AND traceId IS NOT NULL ${entity} ${synthetic} ORDER BY timestamp DESC LIMIT 1 SINCE ${Math.floor(sinceMs / 1000)} UNTIL ${Math.ceil(untilMs / 1000)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// dependency_health
// ---------------------------------------------------------------------------------------------------------------------

const depInput = z.strictObject({
  guid: guidInput('The entity whose neighbours to check'),
  direction: z
    .enum(['OUTBOUND', 'INBOUND', 'BOTH'])
    .optional()
    .describe('OUTBOUND (what it calls), INBOUND (what calls it) or BOTH (default).'),
  max_dependencies: z
    .number()
    .int()
    .min(1)
    .max(MAX_DEPENDENCIES)
    .optional()
    .describe(
      `Most neighbours to measure (default ${DEFAULT_DEPENDENCIES}, max ${MAX_DEPENDENCIES}); alerting ones are chosen first.`,
    ),
  max_metrics: z
    .number()
    .int()
    .min(1)
    .max(MAX_METRICS)
    .optional()
    .describe(`Golden metrics per entity (default ${DEFAULT_METRICS}, max ${MAX_METRICS}).`),
  since: rangeInput('last 30 minutes'),
});

const depEntity = z.object({
  guid: z.string(),
  name: z.string().nullable(),
  domain: z.string().nullable(),
  type: z.string().nullable(),
  accountId: z.number().int(),
  relationship: z.string().nullable(),
  direction: z.enum(['self', 'outgoing', 'incoming']),
  alertSeverity: z.string().nullable(),
  reporting: z.boolean().nullable(),
  status: z.enum(['ok', 'partial', 'error', 'skipped']),
  note: z.string().nullable(),
  signals: z.array(z.string()),
  metrics: z.array(z.record(z.string(), z.unknown())),
});

const depOutput = z.object({
  entity: depEntity,
  dependencies: z.array(depEntity),
  /** Related entities that were not measured (more than max_dependencies, or no budget). */
  notMeasured: z.number().int(),
  hiddenOutsideScope: z.boolean(),
  since: z.string(),
  partial: z.boolean(),
  notes: z.array(z.string()),
});

const DEP_DESCRIPTION = `Is the problem in this entity or in what it depends on? For an entity (guid or name) it measures the golden metrics of the entity and of its directly related entities (alerting ones first) side by side, flagging clear signals (alerting, not reporting, rising error rate, latency, CPU or memory, throughput down 25% or more).

Use it for "is it my dependency?". Runs about ${1 + (1 + DEFAULT_METRICS) * (1 + DEFAULT_DEPENDENCIES)} requests by default (fewer with max_dependencies or max_metrics); what does not fit is marked skipped (partial: true). Neighbours in accounts outside this connection are left out (hidden_outside_scope). For the entity alone use entity_health; for the plain list of neighbours use get_related_entities.. ${UNTRUSTED}`;

// ---------------------------------------------------------------------------------------------------------------------
// entity_health
// ---------------------------------------------------------------------------------------------------------------------

const HEALTH_SECTIONS = ['entity', 'golden_metrics', 'issues', 'errors', 'changes'] as const;
type HealthSection = (typeof HEALTH_SECTIONS)[number];
const SECTION_TITLES: Record<HealthSection, string> = {
  entity: 'Entity',
  golden_metrics: 'Golden metrics',
  issues: 'Open alert issues',
  errors: 'Unresolved error groups',
  changes: 'Recent deployments',
};

const healthInput = z.strictObject({
  guid: guidInput('The entity to summarise'),
  time_range: rangeInput(DEFAULT_HEALTH_WINDOW).describe(
    `Window for golden metrics and error group counts. Default: "${DEFAULT_HEALTH_WINDOW}".`,
  ),
  lookback_days: z
    .number()
    .int()
    .min(1)
    .max(90)
    .optional()
    .describe(
      `Days back for open issues and deployments (default ${DEFAULT_LOOKBACK_DAYS}, capped by the window limit).`,
    ),
  max_metrics: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(`Golden metrics to run (default ${HEALTH_METRICS}, max 10).`),
});

const healthOutput = z.object({
  guid: z.string(),
  account: z.number().int(),
  since: z.string(),
  until: z.string(),
  sections: z.array(sectionSchema),
  /** Short flags drawn from the golden metrics and alert state (see dependency_health). */
  signals: z.array(z.string()),
  partial: z.boolean(),
  notes: z.array(z.string()),
});

const HEALTH_COST = 1 + (1 + HEALTH_METRICS) + 1 + 1 + 1;

const HEALTH_DESCRIPTION = `One-call health check of an entity (guid or name): alert severity and reporting, golden metrics with trends, open alert issues, top unresolved error groups and recent deployments.

Start here for "is this service healthy?". Runs about ${HEALTH_COST} requests in that priority order; a section that does not fit or fails is marked skipped or error (partial: true). time_range (default ${DEFAULT_HEALTH_WINDOW}) applies to metrics and error counts, lookback_days (default ${DEFAULT_LOOKBACK_DAYS}) to issues and deployments. Reads the entity's account only. For metric values alone use get_golden_metrics; to check what it depends on use dependency_health; for one alert issue use generate_alert_insights_report. ${UNTRUSTED}`;

// ---------------------------------------------------------------------------------------------------------------------

/** `trace_error`, `dependency_health`, `entity_health` (read-only composites). */
export function createInvestigationTools(deps: ToolDeps = {}): ToolDefinition[] {
  const client = toolClient(deps);
  const siblings = new Map(
    [
      ...createEntityTools(deps),
      ...createGoldenMetricTools(deps),
      ...createErrorTools(deps),
      ...createIssueTools(deps),
      ...createChangeTools(deps),
    ].map((t) => [t.name, t]),
  );
  const tool = (name: string): ToolDefinition => {
    const t = siblings.get(name);
    if (!t) throw new RbError(ErrorCode.Internal, `Investigation tool ${name} is missing.`);
    return grantedSibling(t);
  };

  type Outcome = { rows: Record<string, unknown>[] } | { note: string };
  const query = async (ctx: ToolContext, account: number, q: NrqlQuery): Promise<Outcome> => {
    try {
      const outcome = await runNrql(
        ctx,
        { nrql: q, accounts: [account], mode: 'auto', maxPolls: 1 },
        { client: client(ctx), ...(deps.sleep ? { sleep: deps.sleep } : {}) },
      );
      if (outcome.status === 'pending') return { note: 'Still running at New Relic; try again shortly.' };
      return { rows: (outcome as NrqlComplete).results as Record<string, unknown>[] };
    } catch (e) {
      if (!(e instanceof RbError) || FATAL_CODES.has(e.code) || e.code === ErrorCode.LimitQuery) throw e;
      if (e.code === ErrorCode.BudgetExhausted) return { note: BUDGET_NOTE };
      return { note: cleanName(e.message, MAX_TEXT) };
    }
  };

  // ------------------------------------------------------------------------------------------------ trace_error
  const trace = defineTool({
    name: 'trace_error',
    title: 'Trace an error end to end',
    description: TRACE_DESCRIPTION,
    inputSchema: traceInput,
    outputSchema: traceOutput,
    kind: 'read',
    openWorld: true,
    // Spans, error events, logs; one more to find the trace of an error group.
    cost: 4,
    group: 'incident-response',
    phase: 6,
    handler: async (args, ctx) => {
      if ((args.trace_id === undefined) === (args.error_group_id === undefined)) {
        throw new RbError(ErrorCode.InputInvalid, 'Give exactly one of trace_id or error_group_id.', {
          hint: 'Use list_error_groups to find an error group id.',
        });
      }
      if (args.trace_id !== undefined && !TRACE_ID_RE.test(args.trace_id)) {
        throw new RbError(ErrorCode.InputInvalid, 'trace_id is not a valid trace id.', {
          hint: 'Trace ids are 8 to 64 letters, digits, dots, dashes or underscores.',
        });
      }
      if (args.error_group_id !== undefined && !GROUP_ID_RE.test(args.error_group_id)) {
        throw new RbError(ErrorCode.InputInvalid, 'error_group_id is not a valid error group id.');
      }
      if (args.entity_guid !== undefined && args.error_group_id === undefined) {
        throw new RbError(ErrorCode.InputInvalid, 'entity_guid only applies with error_group_id.');
      }
      let account: number;
      if (args.entity_guid !== undefined) {
        const decoded = checkGuid(ctx, args.entity_guid);
        if (args.account !== undefined && args.account !== decoded.accountId) {
          throw new RbError(
            ErrorCode.InputInvalid,
            `entity_guid belongs to account ${decoded.accountId}, not ${args.account}.`,
            { hint: 'Omit account, or pass the entity account.' },
          );
        }
        account = singleAccount(ctx, decoded.accountId);
      } else {
        account = singleAccount(ctx, args.account);
      }
      const range = parseTimeRange(args.time_range ?? DEFAULT_TRACE_WINDOW, ctx.clock.now());
      assertWindowWithinLimit(range, ctx.limits);

      const notes: string[] = [];
      let traceId = args.trace_id ?? null;
      if (traceId === null && args.error_group_id !== undefined) {
        const found = await query(
          ctx,
          account,
          groupTraceQuery(
            args.error_group_id,
            args.entity_guid,
            args.include_synthetic ?? false,
            range.sinceMs,
            range.untilMs,
          ),
        );
        if ('note' in found) {
          throw new RbError(
            ErrorCode.NerdGraphError,
            `Could not look up the error group's trace: ${found.note}`,
            {
              hint: 'Retry, or pass a trace_id.',
            },
          );
        }
        const id = found.rows[0]?.['traceId'];
        if (typeof id === 'string' && TRACE_ID_RE.test(id)) traceId = id;
        else notes.push('No traced occurrence of this error group was found in the window.');
      }

      const empty = { total: 0, services: [], errorSpans: 0, root: null, shown: [], truncated: false };
      if (traceId === null) {
        return {
          text: `No trace to follow for error group ${args.error_group_id ?? ''} in account ${account}, ${range.since} to ${range.until} (UTC). ${notes.join(' ')} Widen time_range, or include_synthetic if the group comes from monitors.`,
          structured: {
            account,
            traceId: null,
            errorGroupId: args.error_group_id ?? null,
            since: range.since,
            until: range.until,
            spans: empty,
            errors: [],
            logs: [],
            spansMissing: true,
            partial: false,
            notes,
          },
        };
      }

      const items: PlanItem<'spans' | 'errors' | 'logs'>[] = [
        { name: 'spans', cost: 1 },
        { name: 'errors', cost: 1 },
        { name: 'logs', cost: 1 },
      ];
      const plan = planBudget(items, ctx.budget.remaining);
      const builders = {
        spans: spanQuery,
        errors: errorQuery,
        logs: logQuery,
      } as const;
      const results = new Map<string, Outcome>();
      await Promise.all(
        plan.run.map(async ({ name }) => {
          results.set(name, await query(ctx, account, builders[name](traceId, range.sinceMs, range.untilMs)));
        }),
      );
      for (const name of plan.skipped) results.set(name, { note: BUDGET_NOTE });
      const rowsOf = (name: string): Record<string, unknown>[] => {
        const r = results.get(name);
        if (r && 'rows' in r) return r.rows;
        notes.push(`${name}: ${r && 'note' in r ? r.note : 'not run'}`);
        return [];
      };
      const spanRows = rowsOf('spans').map(toSpan);
      const errorRows = rowsOf('errors').map((r) => ({
        timestamp: isoOf(r['timestamp']),
        app: str(r['appName'], 128),
        transaction: str(r['transactionName'], 200),
        errorClass: str(r['errorClass'], 200),
        errorMessage: str(r['errorMessage'], 500),
        requestMethod: label(typeof r['requestMethod'] === 'string' ? r['requestMethod'] : null),
        requestPath: uriPath(r['requestUri']),
        httpStatus: num(r['httpResponseCode']),
      }));
      const logRows = rowsOf('logs').map((r) => ({
        timestamp: isoOf(r['timestamp']),
        level: label(typeof r['level'] === 'string' ? r['level'] : null),
        message: cleanLogMessage(typeof r['message'] === 'string' ? r['message'] : ''),
      }));
      const spansRan = results.get('spans') !== undefined && 'rows' in (results.get('spans') as Outcome);
      const shape = shapeTrace(spanRows);
      const spansMissing = spansRan && shape.total === 0;
      if (spansMissing)
        notes.push(
          'No spans found: the trace may have been sampled out, be older than the window, or live in another account.',
        );
      if (shape.total >= SPAN_LIMIT) notes.push(`Only the first ${SPAN_LIMIT} spans were read.`);
      const partial = [...results.values()].some((r) => 'note' in r);

      const lines = [
        `Trace ${traceId} in account ${account}, ${range.since} to ${range.until} (UTC): ${shape.total} span${shape.total === 1 ? '' : 's'}` +
          `${shape.services.length ? ` across ${shape.services.length} service${shape.services.length === 1 ? '' : 's'}` : ''}` +
          `, ${shape.errorSpans} with errors; ${errorRows.length} error event${errorRows.length === 1 ? '' : 's'}; ${logRows.length} log line${logRows.length === 1 ? '' : 's'}.` +
          `${partial ? ' Partial result: see the notes.' : ''}`,
      ];
      for (const n of notes) lines.push(`Note: ${n}`);
      if (shape.shown.length > 0) {
        if (shape.truncated)
          lines.push(
            `Showing ${shape.shown.length} of ${shape.total} spans: the error spans, then the slowest.`,
          );
        lines.push(
          shapeRows(
            shape.shown.map((s) => ({
              time: s.timestamp ?? '',
              service: s.service ?? '',
              span: s.name ?? '',
              duration_ms: s.durationMs ?? '',
              error: [s.errorClass, s.errorMessage].filter(Boolean).join(': '),
            })),
            {
              format: 'csv',
              source: 'New Relic trace spans',
              maxRows: SPAN_ROWS_SHOWN,
              maxCellChars: MAX_TEXT,
            },
          ).text,
        );
      }
      if (errorRows.length > 0)
        lines.push(
          shapeRows(
            errorRows.map((e) => ({
              time: e.timestamp ?? '',
              app: e.app ?? '',
              class: e.errorClass ?? '',
              message: e.errorMessage ?? '',
              request: `${e.requestMethod ?? ''} ${e.requestPath ?? ''}`.trim(),
              status: e.httpStatus ?? '',
            })),
            { format: 'csv', source: 'New Relic error events', maxRows: ERROR_LIMIT, maxCellChars: 500 },
          ).text,
        );
      if (logRows.length > 0)
        lines.push(
          shapeRows(
            logRows.map((l) => ({ time: l.timestamp ?? '', level: l.level ?? '', message: l.message })),
            { format: 'csv', source: 'New Relic Log data', maxRows: LOG_LIMIT },
          ).text,
        );
      return {
        text: lines.join('\n'),
        structured: {
          account,
          traceId,
          errorGroupId: args.error_group_id ?? null,
          since: range.since,
          until: range.until,
          spans: {
            total: shape.total,
            services: shape.services,
            errorSpans: shape.errorSpans,
            root: shape.root,
            shown: shape.shown,
            truncated: shape.truncated || shape.total >= SPAN_LIMIT,
          },
          errors: errorRows,
          logs: logRows,
          spansMissing,
          partial,
          notes,
        },
      };
    },
  });

  // ------------------------------------------------------------------------------------------- dependency_health
  type Entity = z.infer<typeof depEntity>;
  type GoldenOut = { metrics?: MetricLike[] & Record<string, unknown>[] };

  const dependency = defineTool({
    name: 'dependency_health',
    title: 'Check the health of dependencies',
    description: DEP_DESCRIPTION,
    inputSchema: depInput,
    outputSchema: depOutput,
    kind: 'read',
    openWorld: true,
    cost: 1 + (1 + DEFAULT_METRICS) * (1 + DEFAULT_DEPENDENCIES),
    group: 'incident-response',
    phase: 6,
    handler: async (args, ctx) => {
      const decoded = checkGuid(ctx, args.guid);
      const range = parseTimeRange(args.since ?? 'last 30 minutes', ctx.clock.now());
      assertWindowWithinLimit(range, ctx.limits);
      const maxDeps = args.max_dependencies ?? DEFAULT_DEPENDENCIES;
      const metricsEach = args.max_metrics ?? DEFAULT_METRICS;
      const notes: string[] = [];

      // The relationship lookup is the base of everything: its errors are the tool's errors.
      const relatedTool = tool('get_related_entities');
      const rel = await relatedTool.handler(
        relatedTool.inputSchema.parse({
          guid: args.guid,
          limit: RELATED_FETCH,
          ...(args.direction ? { direction: args.direction } : {}),
        }),
        ctx,
      );
      const relData = rel.structured as {
        entity: { guid: string; name: string | null };
        related: {
          guid: string;
          accountId: number;
          name: string;
          domain: string | null;
          type: string | null;
          alertSeverity: string | null;
          reporting: boolean | null;
          direction: 'outgoing' | 'incoming';
          relationship: string | null;
        }[];
        hiddenOutsideScope: boolean;
        hasMore: boolean;
      };
      const seen = new Set<string>([args.guid]);
      const candidates = relData.related
        .filter((r) => {
          if (seen.has(r.guid)) return false;
          seen.add(r.guid);
          return true;
        })
        .sort((a, b) => severityRank(a.alertSeverity) - severityRank(b.alertSeverity));
      const chosen = candidates.slice(0, maxDeps);
      const notMeasured = candidates.length - chosen.length;
      if (relData.hiddenOutsideScope)
        notes.push('Relationships into accounts this connection does not allow were left out.');
      if (relData.hasMore) notes.push(`Only the first ${RELATED_FETCH} relationships were read.`);

      // Plan: the entity itself first, then neighbours in priority order (alerting first).
      const targets = [
        { guid: args.guid, who: 'self' as const },
        ...chosen.map((c) => ({ guid: c.guid, who: c })),
      ];
      const planItems: PlanItem<string>[] = targets.map((t) => ({
        name: t.guid,
        cost: 1 + metricsEach,
        minCost: 2,
      }));
      const plan = planBudget(planItems, ctx.budget.remaining);
      const granted = new Map(plan.run.map((r) => [r.name, r.granted]));
      const golden = tool('get_golden_metrics');
      const sections = new Map<string, SectionResult>();
      await Promise.all(
        plan.run.map(async ({ name, granted: g }) => {
          sections.set(
            name,
            await runSection(
              name,
              golden,
              { guid: name, since: range.since + ' to ' + range.until, max_metrics: Math.max(1, g - 1) },
              ctx,
            ),
          );
        }),
      );

      const build = (
        guid: string,
        meta: Pick<Entity, 'name' | 'domain' | 'type' | 'accountId' | 'relationship' | 'direction'> &
          Pick<Entity, 'alertSeverity' | 'reporting'>,
      ): Entity => {
        const s = sections.get(guid);
        const data = (s?.data ?? null) as
          | (GoldenOut & { entity?: { name?: string | null; domain?: string | null; type?: string | null } })
          | null;
        const metrics = (data?.metrics ?? []) as MetricLike[] & Record<string, unknown>[];
        const status: Entity['status'] = !granted.has(guid)
          ? 'skipped'
          : s?.status === 'error'
            ? 'error'
            : s?.status === 'partial' || s?.status === 'skipped'
              ? 'partial'
              : 'ok';
        return {
          guid,
          ...meta,
          status,
          note: !granted.has(guid) ? BUDGET_NOTE : (s?.note ?? null),
          signals: healthSignals(metrics, meta.alertSeverity, meta.reporting),
          metrics: (metrics as Record<string, unknown>[]).map(({ nrql: _n, ...m }) => m),
        };
      };
      const selfEntity = build(args.guid, {
        name: relData.entity.name,
        domain: null,
        type: null,
        accountId: decoded.accountId,
        relationship: null,
        direction: 'self',
        alertSeverity: null,
        reporting: null,
      });
      const goldenSelf = sections.get(args.guid)?.data as
        | { entity?: { domain?: string | null; type?: string | null } }
        | null
        | undefined;
      selfEntity.domain = goldenSelf?.entity?.domain ?? null;
      selfEntity.type = goldenSelf?.entity?.type ?? null;
      const deps2 = chosen.map((c) =>
        build(c.guid, {
          name: c.name,
          domain: c.domain,
          type: c.type,
          accountId: c.accountId,
          relationship: c.relationship,
          direction: c.direction,
          alertSeverity: c.alertSeverity,
          reporting: c.reporting,
        }),
      );
      const all = [selfEntity, ...deps2];
      const partial = all.some((e) => e.status !== 'ok') || notMeasured > 0;
      if (plan.skipped.length > 0) notes.push('Some entities were skipped: the request budget ran out.');
      if (notMeasured > 0)
        notes.push(
          `${notMeasured} more related entit${notMeasured === 1 ? 'y was' : 'ies were'} not measured: raise max_dependencies.`,
        );
      if (granted.size > 0 && [...granted.values()].some((g) => g - 1 < metricsEach))
        notes.push('Golden metrics were reduced to fit the request budget.');

      const flagged = deps2.filter((d) => d.signals.length > 0);
      const lines = [
        `${deps2.length} related entit${deps2.length === 1 ? 'y' : 'ies'} measured next to the entity, ${range.since} to ${range.until} (UTC): ` +
          `${flagged.length} with signals.${partial ? ' Partial result: see the notes and the status column.' : ''}`,
      ];
      for (const n of notes) lines.push(`Note: ${n}`);
      lines.push(
        shapeRows(
          all.map((e) => ({
            entity: e.name ?? e.guid,
            role: e.direction === 'self' ? 'self' : `${e.direction} ${e.relationship ?? ''}`.trim(),
            kind: [e.domain, e.type].filter(Boolean).join('/'),
            alert: e.alertSeverity ?? '',
            status: e.status,
            signals: e.signals.join('; '),
          })),
          { format: 'table', source: 'New Relic related entities', maxRows: MAX_DEPENDENCIES + 1 },
        ).text,
      );
      const metricRows = all.flatMap((e) =>
        e.metrics.map((m) => ({
          entity: e.name ?? e.guid,
          metric: String(m['title'] ?? ''),
          value:
            m['value'] === null || m['value'] === undefined
              ? ''
              : String(Number(Number(m['value']).toPrecision(4))),
          trend: String(m['trend'] ?? ''),
          status: String(m['status'] ?? ''),
        })),
      );
      if (metricRows.length > 0)
        lines.push(
          shapeRows(metricRows, {
            format: 'table',
            source: 'New Relic golden metrics',
            maxRows: (MAX_DEPENDENCIES + 1) * MAX_METRICS,
          }).text,
        );
      return {
        text: lines.join('\n'),
        structured: {
          entity: selfEntity,
          dependencies: deps2,
          notMeasured,
          hiddenOutsideScope: relData.hiddenOutsideScope,
          since: range.since,
          partial,
          notes,
        },
      };
    },
  });

  // ------------------------------------------------------------------------------------------------ entity_health
  const health = defineTool({
    name: 'entity_health',
    title: 'Summarise entity health',
    description: HEALTH_DESCRIPTION,
    inputSchema: healthInput,
    outputSchema: healthOutput,
    kind: 'read',
    openWorld: true,
    cost: HEALTH_COST,
    group: 'health',
    phase: 6,
    handler: async (args, ctx) => {
      const decoded = checkGuid(ctx, args.guid);
      const account = singleAccount(ctx, decoded.accountId);
      const range = parseTimeRange(args.time_range ?? DEFAULT_HEALTH_WINDOW, ctx.clock.now());
      assertWindowWithinLimit(range, ctx.limits);
      const days = Math.max(
        1,
        Math.min(args.lookback_days ?? DEFAULT_LOOKBACK_DAYS, Math.floor(ctx.limits.maxWindowDays)),
      );
      const lookback = `last ${days} days`;
      const metrics = args.max_metrics ?? HEALTH_METRICS;
      const notes: string[] = [];
      if (days < (args.lookback_days ?? DEFAULT_LOOKBACK_DAYS))
        notes.push(`Issues and deployments cover ${days} days: this connection's window limit.`);

      const items: PlanItem<HealthSection>[] = [
        { name: 'entity', cost: 1 },
        { name: 'golden_metrics', cost: 1 + metrics, minCost: 2 },
        { name: 'issues', cost: 1 },
        { name: 'errors', cost: 1 },
        { name: 'changes', cost: 1 },
      ];
      const plan = planBudget(items, ctx.budget.remaining);
      const argsFor = (name: HealthSection, granted: number): [string, Record<string, unknown>] => {
        switch (name) {
          case 'entity':
            return ['get_entity', { guid: args.guid }];
          case 'golden_metrics':
            return [
              'get_golden_metrics',
              {
                guid: args.guid,
                since: range.since + ' to ' + range.until,
                max_metrics: Math.max(1, granted - 1),
              },
            ];
          case 'issues':
            return [
              'list_recent_issues',
              {
                entity_guid: args.guid,
                states: ['CREATED', 'ACTIVATED'],
                time_range: lookback,
                minimal_output: true,
              },
            ];
          case 'errors':
            return [
              'list_error_groups',
              {
                entity_guid: args.guid,
                states: ['UNRESOLVED'],
                sort_by: 'occurrences',
                time_range: range.since + ' to ' + range.until,
                minimal_output: true,
              },
            ];
          case 'changes':
            return [
              'list_change_events',
              { entity_guid: args.guid, time_range: lookback, limit: 5, minimal_output: true },
            ];
        }
      };
      const ran = await Promise.all(
        plan.run.map(({ name, granted }) => {
          const [toolName, toolArgs] = argsFor(name, granted);
          return runSection(name, tool(toolName), toolArgs, ctx);
        }),
      );
      const golden = plan.run.find((r) => r.name === 'golden_metrics');
      if (golden && golden.granted - 1 < metrics)
        notes.push(`Golden metrics reduced to ${golden.granted - 1} to fit the request budget.`);
      const sections: SectionResult[] = HEALTH_SECTIONS.map(
        (name) => ran.find((s) => s.name === name) ?? notRun(name, 'skipped', BUDGET_NOTE),
      );
      const partial = sections.some((s) => s.status !== 'ok');
      const entityData = sections.find((s) => s.name === 'entity')?.data as
        | { alertSeverity?: string | null; reporting?: boolean | null }
        | null
        | undefined;
      const goldenData = sections.find((s) => s.name === 'golden_metrics')?.data as
        | { metrics?: MetricLike[] }
        | null
        | undefined;
      const signals = healthSignals(
        goldenData?.metrics ?? [],
        entityData?.alertSeverity ?? null,
        entityData?.reporting ?? null,
      );
      const count = (s: SectionStatus) => sections.filter((x) => x.status === s).length;
      const lines = [
        `Health of ${args.guid} in account ${account}, ${range.since} to ${range.until} (UTC): ` +
          `${count('ok')} section(s) complete` +
          `${count('partial') ? `, ${count('partial')} partial` : ''}` +
          `${count('error') ? `, ${count('error')} failed` : ''}` +
          `${count('skipped') ? `, ${count('skipped')} skipped (budget)` : ''}.` +
          `${signals.length ? ` ${signals.length} signal(s), below.` : ''}` +
          `${partial ? ' Partial summary: see the section notes.' : ''}`,
      ];
      // Signals quote golden-metric titles, which New Relic users can customise: untrusted data (T6).
      if (signals.length)
        lines.push(envelope(`Signals: ${signals.join('; ')}.`, { source: 'New Relic signals' }));
      for (const n of notes) lines.push(`Note: ${n}`);
      for (const s of sections) {
        lines.push(`## ${SECTION_TITLES[s.name as HealthSection]} [${s.status}]`);
        if (s.note) lines.push(`Note: ${s.note}`);
        if (s.text) lines.push(s.text);
      }
      return {
        text: lines.join('\n'),
        structured: {
          guid: args.guid,
          account,
          since: range.since,
          until: range.until,
          sections: sections.map(({ text: _text, ...s }) => s),
          signals,
          partial,
          notes,
        },
      };
    },
  });

  return [trace, dependency, health] as unknown as ToolDefinition[];
}
