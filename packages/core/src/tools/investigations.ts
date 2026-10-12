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
import type { TaskJob } from '../tasks.ts';
import { parseTimeRange } from '../time/range.ts';
import { defineTool, type ToolDefinition, type ToolOutput } from '../tool.ts';
import { createChangeTools, FATAL_CODES } from './changes.ts';
import { checkGuid, createEntityTools } from './entities.ts';
import { createErrorTools } from './errors.ts';
import { createGoldenMetricTools, goldenCost, goldenMetricsFor } from './golden.ts';
import { cleanName, errorNote } from './identity.ts';
import { createIssueTools } from './issues.ts';
import { cleanLogMessage } from './logs.ts';
import {
  BUDGET_NOTE,
  MAX_TASK_STATE_CHARS,
  notRun,
  type PlanItem,
  planBudget,
  runSection,
  runSectionStep,
  SECTION_STATUSES,
  type SectionResult,
  type SectionStatus,
  SIZE_NOTE,
  sectionSchema,
} from './reports.ts';
import {
  accountInput,
  assertWindowWithinLimit,
  grantedSibling,
  label,
  NRQL_COST,
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
/** Relationships per page and pages read before choosing neighbours (BUG-10: choose from all of them, within budget). */
const RELATED_FETCH = 100;
const RELATED_PAGES = 3;
/** Neighbours that are not dependencies: key transactions, SLIs, alerting objects, workloads, dashboards (BUG-10). */
const NOT_DEPENDENCY = [/^EXT\/(KEY_TRANSACTION|SERVICE_LEVEL)$/, /^AIOPS\//, /^NR1\/WORKLOAD$/, /^VIZ\//];
const isDependency = (domain: string | null, type: string | null): boolean => {
  const kind = `${(domain ?? '').toUpperCase()}/${(type ?? '').toUpperCase()}`;
  return !NOT_DEPENDENCY.some((re) => re.test(kind));
};
/** 0 = a host or a called service (HOSTS/CALLS edge to APM or INFRA), 1 = anything else that is a dependency. */
const dependencyRank = (r: { domain: string | null; relationship: string | null }): number =>
  (r.domain === 'APM' || r.domain === 'INFRA') && (r.relationship === 'HOSTS' || r.relationship === 'CALLS')
    ? 0
    : 1;
const HEALTH_METRICS = 5;
const DEFAULT_LOOKBACK_DAYS = 7;
/** Relative change of a golden metric that counts as a signal. */
export const SIGNAL_CHANGE = 0.25;

const TRACE_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const GROUP_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const guidInput = (what: string) => z.string().min(8).max(512).describe(`${what} (entity guid).`);
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
    // The word already carries the direction: no sign ("down 39%", not "down -39%").
    const pct = `${Math.abs(m.changeRatio * 100).toFixed(0)}%`;
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
  accountId: z.number().int(),
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

Runs 3 queries (4 with error_group_id); a part that fails or does not fit is noted (partial: true). spansMissing means the trace was sampled out or is outside time_range (default last 24 hours); errors and logs still help. Only log lines with the trace id are returned: for other lines use list_recent_logs with a narrow time_range. One account per call (an entity, by entity_guid or name, implies it); synthetic traffic is skipped unless include_synthetic; query strings are removed from paths. ${UNTRUSTED}`;

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

/** Cheap check for any trace data (BUG-12): spans and error events with a trace id, optionally for one entity. */
export function tracingCheckQuery(
  entityGuid: string | undefined,
  sinceMs: number,
  untilMs: number,
): NrqlQuery {
  const entity =
    entityGuid === undefined
      ? nrql``
      : nrql`WHERE ${nrql.identifier('entity.guid')} = ${entityGuid} OR ${nrql.identifier('entityGuid')} = ${entityGuid}`;
  return nrql`SELECT filter(count(*), WHERE eventType() = 'Span') AS spans, filter(count(*), WHERE eventType() = 'TransactionError' AND traceId IS NOT NULL) AS tracedErrors FROM Span, TransactionError ${entity} SINCE ${Math.floor(sinceMs / 1000)} UNTIL ${Math.ceil(untilMs / 1000)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// dependency_health
// ---------------------------------------------------------------------------------------------------------------------

const depInput = z.strictObject({
  entity_guid: guidInput('The entity whose neighbours to check'),
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
      `Most neighbours to measure (default ${DEFAULT_DEPENDENCIES}, max ${MAX_DEPENDENCIES}); hosts and called services first, then alerting ones (key transactions, SLIs, workloads, dashboards skipped).`,
    ),
  max_metrics: z
    .number()
    .int()
    .min(1)
    .max(MAX_METRICS)
    .optional()
    .describe(`Golden metrics per entity (default ${DEFAULT_METRICS}, max ${MAX_METRICS}).`),
  time_range: rangeInput('last 30 minutes'),
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
  until: z.string(),
  partial: z.boolean(),
  notes: z.array(z.string()),
});

/** One relationship lookup, then the golden metrics of the entity and of each dependency (default depth). */
const DEP_COST = RELATED_PAGES + goldenCost(DEFAULT_METRICS) * (1 + DEFAULT_DEPENDENCIES);

const DEP_DESCRIPTION = `Is the problem in this entity or in what it depends on? For an entity (guid or name) it measures the golden metrics of the entity and of its directly related entities (hosts and called services first, then alerting ones) side by side, flagging clear signals (alerting, not reporting, rising error rate, latency, CPU or memory, throughput down 25% or more).

Runs about ${DEP_COST} requests by default (fewer with max_dependencies or max_metrics); what does not fit is marked skipped (partial: true). Neighbours in accounts outside this connection are left out (hiddenOutsideScope). For the entity alone use entity_health; for the plain list of neighbours use get_related_entities. ${UNTRUSTED}`;

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
  entity_guid: guidInput('The entity to summarise'),
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
  entityGuid: z.string(),
  accountId: z.number().int(),
  since: z.string(),
  until: z.string(),
  sections: z.array(sectionSchema),
  /** Short flags drawn from the golden metrics and alert state (see dependency_health). */
  signals: z.array(z.string()),
  partial: z.boolean(),
  notes: z.array(z.string()),
});

const HEALTH_COST = goldenCost(HEALTH_METRICS) + 1 + 1 + 1 + 1;

const HEALTH_DESCRIPTION = `One-call health check of an entity (guid or name): alert severity and reporting, golden metrics with trends, open alert issues, top unresolved error groups and recent deployments.

Start here for "is this service healthy?". Runs about ${HEALTH_COST} requests in that priority order; a section that does not fit or fails is marked skipped or error (partial: true). time_range (default ${DEFAULT_HEALTH_WINDOW}) applies to metrics and error counts, lookback_days (default ${DEFAULT_LOOKBACK_DAYS}) to issues and deployments. Reads the entity's account only. For metric values alone use get_golden_metrics; to check what it depends on use dependency_health; for one alert issue use generate_alert_insights_report. ${UNTRUSTED}`;

/** Sections / entities run per `tasks/get` of a health task (P7-23). */
const STEP_HEALTH_SECTIONS = 3;
const STEP_DEP_ENTITIES = 2;

/** What an entity_health task keeps between polls (sealed at rest): the call, the window and the sections done. */
const healthTaskState = z.strictObject({
  args: healthInput,
  account: z.number().int(),
  since: z.string().max(100),
  until: z.string().max(100),
  lookback: z.string().max(100),
  notes: z.array(z.string().max(2000)).max(20),
  sections: z
    .array(
      z.strictObject({
        name: z.enum(HEALTH_SECTIONS),
        status: z.enum(SECTION_STATUSES),
        note: z.string().max(5000).nullable(),
        data: z.record(z.string(), z.unknown()).nullable(),
        text: z.string().nullable(),
      }),
    )
    .max(HEALTH_SECTIONS.length),
});
type HealthTaskState = z.infer<typeof healthTaskState>;

/** What a dependency_health task keeps between polls (sealed at rest): the neighbours chosen and the golden metrics done. */
const depTaskState = z.strictObject({
  args: depInput,
  account: z.number().int(),
  since: z.string().max(100),
  until: z.string().max(100),
  selfName: z.string().max(1000).nullable(),
  chosen: z
    .array(
      z.strictObject({
        guid: z.string().max(1000),
        name: z.string().max(1000),
        accountId: z.number().int(),
        domain: z.string().max(200).nullable(),
        type: z.string().max(200).nullable(),
        alertSeverity: z.string().max(200).nullable(),
        reporting: z.boolean().nullable(),
        direction: z.enum(['outgoing', 'incoming']),
        relationship: z.string().max(200).nullable(),
      }),
    )
    .max(MAX_DEPENDENCIES),
  notMeasured: z.number().int(),
  hidden: z.boolean(),
  notes: z.array(z.string().max(2000)).max(20),
  entries: z
    .array(
      z.strictObject({
        guid: z.string().max(1000),
        /** Requests granted to its golden metrics; 0 when it was not run (budget or size). */
        granted: z.number().int(),
        status: z.enum(SECTION_STATUSES),
        note: z.string().max(5000).nullable(),
        data: z.record(z.string(), z.unknown()).nullable(),
      }),
    )
    .max(MAX_DEPENDENCIES + 1),
});
type DepTaskState = z.infer<typeof depTaskState>;

// ---------------------------------------------------------------------------------------------------------------------

/** The tools the composites call for their sections (P6-25): kept in step with the `tool(...)` calls by a test. */
const DEP_SIBLINGS = ['get_related_entities', 'get_golden_metrics'] as const;
const HEALTH_SIBLINGS = [
  'get_entity',
  'get_golden_metrics',
  'list_recent_issues',
  'list_error_groups',
  'list_change_events',
] as const;

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
      return { note: errorNote(e) };
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
    // Spans, error events and logs; one more NRQL to find the trace of an error group.
    cost: 4 * NRQL_COST,
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
      assertWindowWithinLimit(range, ctx.limits, ctx.clock.now());

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
        else {
          notes.push('No traced occurrence of this error group was found in the window.');
          if (ctx.budget.remaining >= NRQL_COST) {
            const check = await query(
              ctx,
              account,
              tracingCheckQuery(args.entity_guid, range.sinceMs, range.untilMs),
            );
            if ('rows' in check) {
              const row = check.rows[0] ?? {};
              if ((num(row['spans']) ?? 0) === 0 && (num(row['tracedErrors']) ?? 0) === 0)
                notes.push(
                  `No Span events or error events with a trace id exist${args.entity_guid ? ' for this entity' : ' in this account'} in the window: distributed tracing appears to be disabled.`,
                );
            }
          }
        }
      }

      const empty = { total: 0, services: [], errorSpans: 0, root: null, shown: [], truncated: false };
      if (traceId === null) {
        return {
          text: `No trace to follow for error group ${args.error_group_id ?? ''} in account ${account}, ${range.since} to ${range.until} (UTC). ${notes.join(' ')} Widen time_range, or include_synthetic if the group comes from monitors.`,
          structured: {
            accountId: account,
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
        { name: 'spans', cost: NRQL_COST },
        { name: 'errors', cost: NRQL_COST },
        { name: 'logs', cost: NRQL_COST },
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
          accountId: account,
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
  type DepEntry = DepTaskState['entries'][number];

  interface DepBase {
    account: number;
    since: string;
    until: string;
    selfName: string | null;
    chosen: DepTaskState['chosen'];
    notMeasured: number;
    hidden: boolean;
    /** Notes of the prepare step. */
    notes: string[];
  }

  /** The relationship lookup (one request): the base of everything, so its errors are the tool's errors. */
  const prepareDep = async (args: z.infer<typeof depInput>, ctx: ToolContext): Promise<DepBase> => {
    const decoded = checkGuid(ctx, args.entity_guid);
    const range = parseTimeRange(args.time_range ?? 'last 30 minutes', ctx.clock.now());
    assertWindowWithinLimit(range, ctx.limits, ctx.clock.now());
    const maxDeps = args.max_dependencies ?? DEFAULT_DEPENDENCIES;
    const notes: string[] = [];
    const relatedTool = tool('get_related_entities');
    type RelData = {
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
      nextCursor: string | null;
    };
    // Read every page (up to RELATED_PAGES) before choosing: the first page alone may hold only key transactions.
    let relData: RelData | undefined;
    let cursor: string | undefined;
    for (let page = 0; page < RELATED_PAGES; page++) {
      const rel = await relatedTool.handler(
        relatedTool.inputSchema.parse({
          entity_guid: args.entity_guid,
          limit: RELATED_FETCH,
          ...(args.direction ? { direction: args.direction } : {}),
          ...(cursor ? { cursor } : {}),
        }),
        ctx,
      );
      const data = rel.structured as RelData;
      relData = relData
        ? {
            ...data,
            related: [...relData.related, ...data.related],
            hiddenOutsideScope: relData.hiddenOutsideScope || data.hiddenOutsideScope,
          }
        : data;
      if (!data.nextCursor) break;
      cursor = data.nextCursor;
    }
    if (!relData) throw new RbError(ErrorCode.NerdGraphError, 'NerdGraph returned no relationships.');
    const seen = new Set<string>([args.entity_guid]);
    const candidates = relData.related
      .filter((r) => {
        if (seen.has(r.guid) || !isDependency(r.domain, r.type)) return false;
        seen.add(r.guid);
        return true;
      })
      .sort(
        (a, b) =>
          dependencyRank(a) - dependencyRank(b) ||
          severityRank(a.alertSeverity) - severityRank(b.alertSeverity),
      );
    const chosen = candidates.slice(0, maxDeps);
    if (relData.hiddenOutsideScope)
      notes.push('Relationships into accounts this connection does not allow were left out.');
    if (relData.nextCursor)
      notes.push(`Only the first ${RELATED_PAGES * RELATED_FETCH} relationships were read.`);
    return {
      account: decoded.accountId,
      since: range.since,
      until: range.until,
      selfName: relData.entity.name,
      chosen: chosen.map((c) => ({
        guid: c.guid,
        name: c.name,
        accountId: c.accountId,
        domain: c.domain,
        type: c.type,
        alertSeverity: c.alertSeverity,
        reporting: c.reporting,
        direction: c.direction,
        relationship: c.relationship,
      })),
      notMeasured: candidates.length - chosen.length,
      hidden: relData.hiddenOutsideScope,
      notes,
    };
  };

  /** The entity itself first, then neighbours in priority order (alerting first). Pure. */
  const depItems = (args: z.infer<typeof depInput>, base: DepBase): PlanItem<string>[] =>
    [args.entity_guid, ...base.chosen.map((c) => c.guid)].map((guid) => ({
      name: guid,
      cost: goldenCost(args.max_metrics ?? DEFAULT_METRICS),
      minCost: goldenCost(1),
    }));

  const runDepEntry = async (
    guid: string,
    granted: number,
    base: DepBase,
    ctx: ToolContext,
  ): Promise<DepEntry> => {
    const s = await runSection(
      guid,
      tool('get_golden_metrics'),
      {
        entity_guid: guid,
        time_range: `${base.since} to ${base.until}`,
        max_metrics: goldenMetricsFor(granted),
      },
      ctx,
    );
    return { guid, granted, status: s.status, note: s.note, data: s.data };
  };

  const notRunDep = (guid: string, note: string): DepEntry => ({
    guid,
    granted: 0,
    status: 'skipped',
    note,
    data: null,
  });

  const assembleDep = (
    args: z.infer<typeof depInput>,
    base: DepBase,
    entries: readonly DepEntry[],
  ): ToolOutput => {
    const metricsEach = args.max_metrics ?? DEFAULT_METRICS;
    const notes = [...base.notes];
    const { notMeasured } = base;
    const entryOf = (guid: string) => entries.find((e) => e.guid === guid);
    const build = (
      guid: string,
      meta: Pick<Entity, 'name' | 'domain' | 'type' | 'accountId' | 'relationship' | 'direction'> &
        Pick<Entity, 'alertSeverity' | 'reporting'>,
    ): Entity => {
      const e = entryOf(guid);
      const ran = e !== undefined && e.granted > 0;
      const data = (e?.data ?? null) as
        | (GoldenOut & { entity?: { name?: string | null; domain?: string | null; type?: string | null } })
        | null;
      const metrics = (data?.metrics ?? []) as MetricLike[] & Record<string, unknown>[];
      const status: Entity['status'] = !ran
        ? 'skipped'
        : e.status === 'error'
          ? 'error'
          : e.status === 'partial' || e.status === 'skipped'
            ? 'partial'
            : 'ok';
      return {
        guid,
        ...meta,
        status,
        note: !ran ? (e?.note ?? BUDGET_NOTE) : e.note,
        signals: healthSignals(metrics, meta.alertSeverity, meta.reporting),
        metrics: (metrics as Record<string, unknown>[]).map(({ nrql: _n, ...m }) => m),
      };
    };
    const selfEntity = build(args.entity_guid, {
      name: base.selfName,
      domain: null,
      type: null,
      accountId: base.account,
      relationship: null,
      direction: 'self',
      alertSeverity: null,
      reporting: null,
    });
    const goldenSelf = entryOf(args.entity_guid)?.data as
      | { entity?: { domain?: string | null; type?: string | null } }
      | null
      | undefined;
    selfEntity.domain = goldenSelf?.entity?.domain ?? null;
    selfEntity.type = goldenSelf?.entity?.type ?? null;
    const deps2 = base.chosen.map((c) =>
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
    const targets = [args.entity_guid, ...base.chosen.map((c) => c.guid)];
    const notRun = targets.map(entryOf).filter((e) => e === undefined || e.granted === 0);
    const bySize = notRun.filter((e) => e?.note === SIZE_NOTE).length;
    if (notRun.length - bySize > 0) notes.push('Some entities were skipped: the request budget ran out.');
    if (bySize > 0) notes.push('Some entities were skipped: the task size limit was reached.');
    if (notMeasured > 0)
      notes.push(
        `${notMeasured} more related entit${notMeasured === 1 ? 'y was' : 'ies were'} not measured: raise max_dependencies.`,
      );
    if (entries.some((e) => e.granted > 0 && goldenMetricsFor(e.granted) < metricsEach))
      notes.push('Golden metrics were reduced to fit the request budget.');

    const flagged = deps2.filter((d) => d.signals.length > 0);
    const lines = [
      `${deps2.length} related entit${deps2.length === 1 ? 'y' : 'ies'} measured next to the entity, ${base.since} to ${base.until} (UTC): ` +
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
        hiddenOutsideScope: base.hidden,
        since: base.since,
        until: base.until,
        partial,
        notes,
      },
    };
  };

  const runDepInline = async (
    args: z.infer<typeof depInput>,
    base: DepBase,
    ctx: ToolContext,
  ): Promise<ToolOutput> => {
    const plan = planBudget(depItems(args, base), ctx.budget.remaining);
    const ran = await Promise.all(plan.run.map(({ name, granted }) => runDepEntry(name, granted, base, ctx)));
    return assembleDep(args, base, [...ran, ...plan.skipped.map((g) => notRunDep(g, BUDGET_NOTE))]);
  };

  const depJob = (state: DepTaskState): TaskJob => ({
    state,
    pollIntervalMs: 1000,
    statusMessage: `Checking the dependencies: ${state.entries.length} of ${1 + state.chosen.length} entities measured.`,
  });

  const dependency = defineTool({
    name: 'dependency_health',
    title: 'Check the health of dependencies',
    description: DEP_DESCRIPTION,
    inputSchema: depInput,
    outputSchema: depOutput,
    kind: 'read',
    openWorld: true,
    // Beyond the defaults (max_dependencies, max_metrics) the plan degrades to a partial result within the budget.
    cost: DEP_COST,
    group: 'incident-response',
    phase: 6,
    siblingTools: DEP_SIBLINGS,
    handler: async (args, ctx) => {
      const base = await prepareDep(args, ctx);
      // MCP Tasks (P7-23): the golden metrics of a few entities per `tasks/get`, each inside its own budget.
      if (ctx.tasks?.accepted === true) {
        const state: DepTaskState = {
          args,
          account: base.account,
          since: base.since,
          until: base.until,
          selfName: base.selfName,
          chosen: base.chosen,
          notMeasured: base.notMeasured,
          hidden: base.hidden,
          notes: base.notes,
          entries: [],
        };
        return {
          text: 'The check continues as a task.',
          task: depJob(state),
          taskFallback: () => runDepInline(args, base, ctx),
        };
      }
      return runDepInline(args, base, ctx);
    },
    resumeTask: async (raw, ctx) => {
      const state = depTaskState.parse(raw);
      checkGuid(ctx, state.args.entity_guid);
      const base: DepBase = {
        account: state.account,
        since: state.since,
        until: state.until,
        selfName: state.selfName,
        chosen: state.chosen,
        notMeasured: state.notMeasured,
        hidden: state.hidden,
        notes: [...state.notes],
      };
      const items = depItems(state.args, base);
      const pending = items.filter((i) => !state.entries.some((e) => e.guid === i.name));
      const entries: DepEntry[] = [...state.entries];
      const { plan, ran } = await runSectionStep({
        pending,
        max: STEP_DEP_ENTITIES,
        remaining: ctx.budget.remaining,
        run: async (name, granted) => {
          const e = await runDepEntry(name, granted, base, ctx);
          return { name, status: e.status, note: e.note, data: e.data, text: null };
        },
      });
      // The entry keeps what the section ran with (`granted`), so rebuild it from the result.
      for (const { name, granted } of plan.run) {
        const r = ran.find((x) => x.name === name) as SectionResult;
        entries.push({ guid: name, granted, status: r.status, note: r.note, data: r.data });
      }
      for (const g of plan.skipped) entries.push(notRunDep(g, BUDGET_NOTE));
      let remaining = items.filter((i) => !entries.some((e) => e.guid === i.name));
      // The sealed record is capped: past the cap the rest is skipped and the check completes with what it has.
      if (remaining.length > 0 && JSON.stringify({ ...state, entries }).length > MAX_TASK_STATE_CHARS) {
        for (const i of remaining) entries.push(notRunDep(i.name, SIZE_NOTE));
        remaining = [];
      }
      if (remaining.length > 0)
        return { text: 'The check continues as a task.', task: depJob({ ...state, entries }) };
      return assembleDep(state.args, base, entries);
    },
  });

  // ------------------------------------------------------------------------------------------------ entity_health
  interface HealthBase {
    account: number;
    since: string;
    until: string;
    lookback: string;
    notes: string[];
  }

  /** Validation and the window (no request). */
  const prepareHealth = (args: z.infer<typeof healthInput>, ctx: ToolContext): HealthBase => {
    const decoded = checkGuid(ctx, args.entity_guid);
    const account = singleAccount(ctx, decoded.accountId);
    const range = parseTimeRange(args.time_range ?? DEFAULT_HEALTH_WINDOW, ctx.clock.now());
    assertWindowWithinLimit(range, ctx.limits, ctx.clock.now());
    const days = Math.max(
      1,
      Math.min(args.lookback_days ?? DEFAULT_LOOKBACK_DAYS, Math.floor(ctx.limits.maxWindowDays)),
    );
    const notes: string[] = [];
    if (days < (args.lookback_days ?? DEFAULT_LOOKBACK_DAYS))
      notes.push(`Issues and deployments cover ${days} days: this connection's window limit.`);
    // Fixed at the call (a task polls later): the lookback is an absolute range, like the window.
    const back = parseTimeRange(`last ${days} days`, ctx.clock.now());
    return {
      account,
      since: range.since,
      until: range.until,
      lookback: `${back.since} to ${back.until}`,
      notes,
    };
  };

  const healthItems = (args: z.infer<typeof healthInput>): PlanItem<HealthSection>[] => [
    { name: 'entity', cost: 1 },
    { name: 'golden_metrics', cost: goldenCost(args.max_metrics ?? HEALTH_METRICS), minCost: goldenCost(1) },
    { name: 'issues', cost: 1 },
    { name: 'errors', cost: 1 },
    { name: 'changes', cost: 1 },
  ];

  const runHealthSection = (
    args: z.infer<typeof healthInput>,
    base: HealthBase,
    name: HealthSection,
    granted: number,
    ctx: ToolContext,
  ): Promise<SectionResult> => {
    const window = `${base.since} to ${base.until}`;
    const [toolName, toolArgs]: [string, Record<string, unknown>] = (() => {
      switch (name) {
        case 'entity':
          return ['get_entity', { entity_guid: args.entity_guid }];
        case 'golden_metrics':
          return [
            'get_golden_metrics',
            { entity_guid: args.entity_guid, time_range: window, max_metrics: goldenMetricsFor(granted) },
          ];
        case 'issues':
          return [
            'list_recent_issues',
            {
              entity_guid: args.entity_guid,
              states: ['CREATED', 'ACTIVATED'],
              time_range: base.lookback,
              minimal_output: true,
            },
          ];
        case 'errors':
          return [
            'list_error_groups',
            {
              entity_guid: args.entity_guid,
              states: ['UNRESOLVED'],
              sort_by: 'occurrences',
              time_range: window,
              minimal_output: true,
            },
          ];
        case 'changes':
          return [
            'list_change_events',
            { entity_guid: args.entity_guid, time_range: base.lookback, limit: 5, minimal_output: true },
          ];
      }
    })();
    return runSection(name, tool(toolName), toolArgs, ctx);
  };

  /** The summary from the sections that ran; the others are skipped (budget). */
  const assembleHealth = (
    args: z.infer<typeof healthInput>,
    base: HealthBase,
    ran: readonly SectionResult[],
    extraNotes: readonly string[],
  ): ToolOutput => {
    const notes = [...base.notes, ...extraNotes];
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
      `Health of ${args.entity_guid} in account ${base.account}, ${base.since} to ${base.until} (UTC): ` +
        `${count('ok')} section(s) complete` +
        `${count('partial') ? `, ${count('partial')} partial` : ''}` +
        `${count('error') ? `, ${count('error')} failed` : ''}` +
        `${count('skipped') ? `, ${count('skipped')} skipped (budget or grant, see the section notes)` : ''}.` +
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
        entityGuid: args.entity_guid,
        accountId: base.account,
        since: base.since,
        until: base.until,
        sections: sections.map(({ text: _text, ...s }) => s),
        signals,
        partial,
        notes,
      },
    };
  };

  const reducedNote = (
    args: z.infer<typeof healthInput>,
    plan: { run: { name: string; granted: number }[] },
  ): string[] => {
    const golden = plan.run.find((r) => r.name === 'golden_metrics');
    return golden && goldenMetricsFor(golden.granted) < (args.max_metrics ?? HEALTH_METRICS)
      ? [`Golden metrics reduced to ${goldenMetricsFor(golden.granted)} to fit the request budget.`]
      : [];
  };

  const healthJob = (state: HealthTaskState): TaskJob => ({
    state,
    pollIntervalMs: 1000,
    statusMessage: `Checking the entity health: ${state.sections.length} of ${HEALTH_SECTIONS.length} sections done.`,
  });

  const runHealthInline = async (
    args: z.infer<typeof healthInput>,
    base: HealthBase,
    ctx: ToolContext,
  ): Promise<ToolOutput> => {
    const plan = planBudget(healthItems(args), ctx.budget.remaining);
    const ran = await Promise.all(
      plan.run.map(({ name, granted }) => runHealthSection(args, base, name, granted, ctx)),
    );
    return assembleHealth(args, base, ran, reducedNote(args, plan));
  };

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
    siblingTools: HEALTH_SIBLINGS,
    handler: async (args, ctx) => {
      const base = prepareHealth(args, ctx);
      // MCP Tasks (P7-23): up to three sections per `tasks/get`, each inside its own budget.
      if (ctx.tasks?.accepted === true) {
        const state: HealthTaskState = {
          args,
          account: base.account,
          since: base.since,
          until: base.until,
          lookback: base.lookback,
          notes: base.notes,
          sections: [],
        };
        return {
          text: 'The check continues as a task.',
          task: healthJob(state),
          taskFallback: async () => runHealthInline(args, base, ctx),
        };
      }
      return runHealthInline(args, base, ctx);
    },
    resumeTask: async (raw, ctx) => {
      const state = healthTaskState.parse(raw);
      // Re-checks the scope; the window of the call is kept, not recomputed.
      const base = prepareHealth(state.args, ctx);
      const fixed: HealthBase = { ...base, since: state.since, until: state.until, lookback: state.lookback };
      const done = new Set(state.sections.map((s) => s.name));
      const pending = healthItems(state.args).filter((i) => !done.has(i.name));
      const { plan, ran } = await runSectionStep({
        pending,
        max: STEP_HEALTH_SECTIONS,
        remaining: ctx.budget.remaining,
        run: (name, granted) => runHealthSection(state.args, fixed, name, granted, ctx),
      });
      const notes = [...state.notes, ...reducedNote(state.args, plan)];
      const sections: SectionResult[] = [
        ...state.sections,
        ...ran,
        ...plan.skipped.map((name) => notRun(name, 'skipped', BUDGET_NOTE)),
      ];
      let remaining = HEALTH_SECTIONS.filter((n) => !sections.some((s) => s.name === n));
      const next: HealthTaskState = { ...state, notes, sections: sections as HealthTaskState['sections'] };
      // The sealed record is capped: past the cap the rest is skipped and the check completes with what it has.
      if (remaining.length > 0 && JSON.stringify(next).length > MAX_TASK_STATE_CHARS) {
        for (const n of remaining) sections.push(notRun(n, 'skipped', SIZE_NOTE));
        remaining = [];
      }
      if (remaining.length > 0) return { text: 'The check continues as a task.', task: healthJob(next) };
      return assembleHealth(state.args, { ...fixed, notes }, sections, []);
    },
  });

  return [trace, dependency, health] as unknown as ToolDefinition[];
}
