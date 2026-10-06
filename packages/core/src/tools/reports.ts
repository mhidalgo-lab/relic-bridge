// SPDX-License-Identifier: Apache-2.0
// generate_alert_insights_report, generate_user_impact_report (P6-10). Composite reports reuse the sibling tools: every
// section calls that tool's handler with schema-parsed arguments and the same per-request context, so each section keeps
// its own scope checks (T3), cleaning and untrusted-data envelopes (T6) and budget spend (ADR-0010). Sections are planned
// against the remaining budget before anything runs; what does not fit is reported as skipped, never silently dropped.
import { z } from 'zod';
import type { ToolContext } from '../context.ts';
import { ErrorCode, RbError } from '../errors.ts';
import { decodeEntityGuid } from '../nerdgraph/entity-guid.ts';
import { runNrql } from '../nrql/engine.ts';
import { type NrqlQuery, nrql } from '../nrql/template.ts';
import { envelope } from '../output/envelope.ts';
import { shapeRows } from '../output/format.ts';
import { parseTimeRange } from '../time/range.ts';
import { defineTool, type ToolDefinition, type ToolOutput } from '../tool.ts';
import { createChangeTools, FATAL_CODES } from './changes.ts';
import { checkGuid, createEntityTools } from './entities.ts';
import { createErrorTools } from './errors.ts';
import { createGoldenMetricTools, goldenCost, goldenMetricsFor } from './golden.ts';
import { errorNote } from './identity.ts';
import { ISSUE_ID_RE, type IssueRow, lookupIssue } from './issues.ts';
import { createLogTools } from './logs.ts';
import {
  accountInput,
  assertWindowWithinLimit,
  DAY_MS,
  grantedSibling,
  NRQL_COST,
  num,
  singleAccount,
  type ToolDeps,
  toolClient,
  UNTRUSTED,
} from './shared.ts';
import { checkQuery, readChecks } from './synthetics.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DEFAULT_LOOKBACK_HOURS = 7 * 24;
const DEFAULT_BEFORE_MINUTES = 30;
const DEFAULT_CHANGE_LOOKBACK_HOURS = 24;
const DEFAULT_REPORT_METRICS = 5;
const MAX_REPORT_METRICS = 10;
const RELATED_LIMIT = 25;
const DEFAULT_IMPACT_WINDOW = 'last 1 hour';
const DEFAULT_MAX_FRONT_ENDS = 20;
const MAX_FRONT_ENDS = 50;
/** Back-end entities whose related front ends are looked up (one request each). */
const MAX_RELATED_LOOKUPS = 3;
const FACET_ROWS = 100;
const SYNTH_ROWS = 2000;

/** Thresholds of the user-impact flags (fixed, like the P6-04 ones; see docs/RESEARCH.md). */
export const IMPACT_RATE_FACTOR = 1.5;
export const IMPACT_SLOWER_FACTOR = 1.25;
export const IMPACT_DROP_FACTOR = 0.75;
export const IMPACT_MIN_VOLUME = 30;
export const IMPACT_MIN_ERRORS = 10;
export const IMPACT_MIN_CRASHES = 5;

const SECTION_STATUSES = ['ok', 'partial', 'error', 'skipped', 'not_applicable'] as const;
export type SectionStatus = (typeof SECTION_STATUSES)[number];

export const INSIGHT_SECTIONS = ['entity', 'golden_metrics', 'errors', 'logs', 'changes', 'related'] as const;
type InsightSection = (typeof INSIGHT_SECTIONS)[number];

const SECTION_TITLES: Record<InsightSection, string> = {
  entity: 'Entity',
  golden_metrics: 'Golden metrics',
  errors: 'Error groups',
  logs: 'Logs',
  changes: 'Change events',
  related: 'Related entities',
};

// ---------------------------------------------------------------------------------------------------------------------
// Budget planning (pure)
// ---------------------------------------------------------------------------------------------------------------------

export interface PlanItem<N extends string> {
  readonly name: N;
  /** Requests the item needs at full depth. */
  readonly cost: number;
  /** Fewest requests it can still run with at reduced depth (default: `cost`, i.e. all or nothing). */
  readonly minCost?: number;
}

export interface Plan<N extends string> {
  /** Items to run, in priority order, with the requests granted to each. */
  readonly run: { name: N; granted: number }[];
  readonly skipped: N[];
}

/**
 * Grant requests in priority order: an item runs at full cost when it fits, at reduced depth (all that is left, at least
 * `minCost`) when it does not, and is skipped otherwise. The grants never add up to more than `remaining`, so items can run
 * in parallel without starving each other. Pure.
 */
export function planBudget<N extends string>(items: readonly PlanItem<N>[], remaining: number): Plan<N> {
  let left = Math.max(0, Math.floor(remaining));
  const run: { name: N; granted: number }[] = [];
  const skipped: N[] = [];
  for (const item of items) {
    const min = item.minCost ?? item.cost;
    if (item.cost <= left) {
      run.push({ name: item.name, granted: item.cost });
      left -= item.cost;
    } else if (min <= left && left > 0) {
      run.push({ name: item.name, granted: left });
      left = 0;
    } else {
      skipped.push(item.name);
    }
  }
  return { run, skipped };
}

// ---------------------------------------------------------------------------------------------------------------------
// Windows (pure)
// ---------------------------------------------------------------------------------------------------------------------

export interface IssueWindow {
  readonly sinceMs: number;
  readonly untilMs: number;
  /** The window was cut to the connection's window limit. */
  readonly cut: boolean;
}

/**
 * The analysis window of an issue: `beforeMs` before it opened until it closed (or now), cut to `maxWindowMs` from its
 * start (the onset matters most). Returns null when the issue carries no usable start time. Pure.
 */
export function issueWindow(
  issue: Pick<IssueRow, 'activatedAt' | 'createdAt' | 'closedAt'>,
  nowMs: number,
  beforeMs: number,
  maxWindowMs: number,
): IssueWindow | null {
  const onset = Date.parse(issue.activatedAt ?? issue.createdAt ?? '');
  if (!Number.isFinite(onset)) return null;
  const closed = Date.parse(issue.closedAt ?? '');
  let until = Math.min(Number.isFinite(closed) ? closed : nowMs, nowMs);
  let since = Math.min(onset, until) - beforeMs;
  if (until - since < MINUTE_MS) until = since + MINUTE_MS;
  let cut = false;
  if (until - since > maxWindowMs) {
    until = since + maxWindowMs;
    cut = true;
  }
  since = Math.max(since, 0);
  return { sinceMs: since, untilMs: until, cut };
}

const isoText = (ms: number) => new Date(ms).toISOString();
const rangeText = (sinceMs: number, untilMs: number) => `${isoText(sinceMs)} to ${isoText(untilMs)}`;

/** The default issue lookback, never longer than the connection allows. */
function lookbackRange(ctx: ToolContext, text: string | undefined) {
  const hours = Math.max(
    1,
    Math.min(DEFAULT_LOOKBACK_HOURS, Math.floor((ctx.limits.maxWindowDays * DAY_MS) / HOUR_MS)),
  );
  const range = parseTimeRange(text ?? `last ${hours} hours`, ctx.clock.now());
  assertWindowWithinLimit(range, ctx.limits);
  return range;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------------------------------

export interface Section {
  readonly name: string;
  readonly status: SectionStatus;
  /** Why the section is not `ok` (budget, error message, not applicable). */
  readonly note: string | null;
  /** The structured result of the tool the section reuses (same shape as calling that tool). */
  readonly data: Record<string, unknown> | null;
}
export const sectionSchema: z.ZodType<Section> = z.object({
  name: z.string(),
  status: z.enum(SECTION_STATUSES),
  note: z.string().nullable(),
  data: z.record(z.string(), z.unknown()).nullable(),
});

export interface SectionResult extends Section {
  readonly text: string | null;
}

export const BUDGET_NOTE = 'Request budget exhausted: not run.';

/**
 * Run one sibling tool as a section. Credential and authorization errors abort the whole report (fail closed, like every
 * other multi-part tool); budget exhaustion makes the section `skipped`; other errors make it `error` with the message.
 */
export async function runSection(
  name: string,
  tool: ToolDefinition,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<SectionResult> {
  try {
    const out: ToolOutput = await tool.handler(tool.inputSchema.parse(args), ctx);
    const data = (out.structured ?? null) as Record<string, unknown> | null;
    const partial = data !== null && data['partial'] === true;
    return {
      name,
      status: partial ? 'partial' : 'ok',
      note: partial ? 'Partial result: see the section.' : null,
      data,
      text: out.text,
    };
  } catch (e) {
    if (!(e instanceof RbError) || FATAL_CODES.has(e.code)) throw e;
    if (e.code === ErrorCode.BudgetExhausted)
      return { name, status: 'skipped', note: BUDGET_NOTE, data: null, text: null };
    if (e.code === ErrorCode.ToolDisabled)
      return { name, status: 'skipped', note: e.message, data: null, text: null };
    return { name, status: 'error', note: errorNote(e), data: null, text: null };
  }
}

export const notRun = (name: string, status: SectionStatus, note: string): SectionResult => ({
  name,
  status,
  note,
  data: null,
  text: null,
});

/** Issue fields shown in the report, inside an untrusted-data envelope (T6). */
function issueBlock(issue: IssueRow): string {
  const body = [
    `id: ${issue.id}`,
    `title: ${issue.title}`,
    `state: ${issue.state ?? ''}`,
    `priority: ${issue.priority ?? ''}`,
    `opened: ${issue.activatedAt ?? issue.createdAt ?? ''}`,
    `closed: ${issue.closedAt ?? ''}`,
    `acknowledged: ${issue.acknowledgedAt ?? ''}`,
    `entities: ${issue.entities.join('; ')}`,
    `policies: ${issue.policies.join('; ')}`,
    `conditions: ${issue.conditions.join('; ')}`,
    `incidents: ${issue.incidentCount ?? ''}`,
    `description: ${issue.description ?? ''}`,
    `link: ${issue.link ?? ''}`,
  ];
  return envelope(body.join('\n'), { source: 'New Relic alert issue' });
}

// ---------------------------------------------------------------------------------------------------------------------
// generate_alert_insights_report
// ---------------------------------------------------------------------------------------------------------------------

const issueIdInput = z.string().regex(ISSUE_ID_RE).describe('The alert issue id (from list_recent_issues).');
const lookbackInput = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(
    'Where to find the issue, e.g. "last 30 days". Default: last 7 days (or the window limit if shorter).',
  );

const insightsInput = z.strictObject({
  issue_id: issueIdInput,
  account: accountInput,
  lookback: lookbackInput,
  before_minutes: z
    .number()
    .int()
    .min(5)
    .max(720)
    .optional()
    .describe(
      `Minutes before the issue opened to include (default ${DEFAULT_BEFORE_MINUTES}). The window ends when the issue closed, or now.`,
    ),
  change_lookback_hours: z
    .number()
    .int()
    .min(1)
    .max(168)
    .optional()
    .describe(`Hours before the window to look for changes (default ${DEFAULT_CHANGE_LOOKBACK_HOURS}).`),
  sections: z
    .array(z.enum(INSIGHT_SECTIONS))
    .min(1)
    .max(INSIGHT_SECTIONS.length)
    .optional()
    .describe('Only these sections (default all): entity, golden_metrics, errors, logs, changes, related.'),
  max_metrics: z
    .number()
    .int()
    .min(1)
    .max(MAX_REPORT_METRICS)
    .optional()
    .describe(`Most golden metrics to run (default ${DEFAULT_REPORT_METRICS}, max ${MAX_REPORT_METRICS}).`),
});

const issueSchema = z.record(z.string(), z.unknown());

const insightsOutput = z.object({
  account: z.number().int(),
  issue: issueSchema,
  since: z.string().nullable(),
  until: z.string().nullable(),
  /** The entity the sections are about: the issue's first entity. */
  entityGuid: z.string().nullable(),
  sections: z.array(sectionSchema),
  /** Some section was skipped (budget), failed or is partial. */
  partial: z.boolean(),
  notes: z.array(z.string()),
});

/** Issue lookup, entity, golden metrics, error groups, logs (3 NRQL), changes and related entities. */
const INSIGHTS_COST = 1 + 1 + goldenCost(DEFAULT_REPORT_METRICS) + 1 + 3 * NRQL_COST + 1 + 1;

const INSIGHTS_DESCRIPTION = `Investigation report for one alert issue (issue_id from list_recent_issues): the issue, then for its first entity the details, golden metrics, Errors Inbox groups and a log summary over the issue window (${DEFAULT_BEFORE_MINUTES} minutes before it opened until it closed, or now), the changes in the ${DEFAULT_CHANGE_LOOKBACK_HOURS} hours before, and the related entities.

Use it to start investigating a specific alert. Each section is the result of the matching tool (get_entity, get_golden_metrics, list_error_groups, analyze_entity_logs, list_change_events, get_related_entities): drill in with those. Runs up to ${INSIGHTS_COST} requests in that priority order; what does not fit or fails is marked skipped or error (partial: true): ask for fewer sections or max_metrics. For an entity without a specific issue use entity_health. Uses New Relic's experimental aiIssues API. ${UNTRUSTED}`;

// ---------------------------------------------------------------------------------------------------------------------
// generate_user_impact_report
// ---------------------------------------------------------------------------------------------------------------------

type FrontEndKind = 'browser' | 'mobile' | 'synthetic';

/** The front-end kind of a decoded GUID, or null for anything else. */
export function frontEndKind(domain: string, type: string): FrontEndKind | null {
  if (domain === 'BROWSER' && type === 'APPLICATION') return 'browser';
  if (domain === 'MOBILE' && type === 'APPLICATION') return 'mobile';
  if (domain === 'SYNTH' && type === 'MONITOR') return 'synthetic';
  return null;
}

const FRONT_END_TYPES = [
  { domain: 'BROWSER', type: 'APPLICATION' },
  { domain: 'MOBILE', type: 'APPLICATION' },
  { domain: 'SYNTH', type: 'MONITOR' },
];

const secondsOf = (sinceMs: number, untilMs: number) => ({
  since: Math.floor(sinceMs / 1000),
  until: Math.ceil(untilMs / 1000),
});

const PAGE_VIEW = nrql`eventType() = 'PageView'`;
const JS_ERROR = nrql`eventType() = 'JavaScriptError'`;
const MOBILE_SESSION = nrql`eventType() = 'MobileSession'`;
const MOBILE_CRASH = nrql`eventType() = 'MobileCrash'`;

/** Browser signals per app (unverified attribute names, see RESEARCH). Only the `nrql` tag builds it (T4). */
export function browserQuery(guids: readonly string[], sinceMs: number, untilMs: number): NrqlQuery {
  const { since, until } = secondsOf(sinceMs, untilMs);
  const session = nrql.identifier('session');
  return nrql`SELECT filter(count(*), WHERE ${PAGE_VIEW}) AS pageViews, filter(average(${nrql.identifier('duration')}), WHERE ${PAGE_VIEW}) AS avgLoadSeconds, filter(uniqueCount(${session}), WHERE ${PAGE_VIEW}) AS sessions, filter(count(*), WHERE ${JS_ERROR}) AS jsErrors, filter(uniqueCount(${session}), WHERE ${JS_ERROR}) AS sessionsWithErrors FROM PageView, JavaScriptError WHERE ${nrql.identifier('entityGuid')} IN ${guids} FACET entityGuid LIMIT ${FACET_ROWS} SINCE ${since} UNTIL ${until}`;
}

/** Mobile signals per app (unverified attribute names, see RESEARCH). Only the `nrql` tag builds it (T4). */
export function mobileQuery(guids: readonly string[], sinceMs: number, untilMs: number): NrqlQuery {
  const { since, until } = secondsOf(sinceMs, untilMs);
  const uuid = nrql.identifier('uuid');
  return nrql`SELECT filter(count(*), WHERE ${MOBILE_SESSION}) AS sessions, filter(uniqueCount(${uuid}), WHERE ${MOBILE_SESSION}) AS users, filter(count(*), WHERE ${MOBILE_CRASH}) AS crashes, filter(uniqueCount(${uuid}), WHERE ${MOBILE_CRASH}) AS usersWithCrashes FROM MobileSession, MobileCrash WHERE ${nrql.identifier('entityGuid')} IN ${guids} FACET entityGuid LIMIT ${FACET_ROWS} SINCE ${since} UNTIL ${until}`;
}

const BROWSER_FIELDS = ['pageViews', 'avgLoadSeconds', 'sessions', 'jsErrors', 'sessionsWithErrors'] as const;
const MOBILE_FIELDS = ['sessions', 'users', 'crashes', 'usersWithCrashes'] as const;
type Numbers = Record<string, number | null>;

/** Facet rows (FACET entityGuid) to numbers per guid; rows for guids not asked for are ignored. Pure. */
export function readFacetNumbers(
  rows: readonly Record<string, unknown>[],
  fields: readonly string[],
  wanted: ReadonlySet<string>,
): Map<string, Numbers> {
  const out = new Map<string, Numbers>();
  for (const r of rows) {
    const f = r['facet'];
    const guid = typeof f === 'string' ? f : Array.isArray(f) ? f[0] : r['entityGuid'];
    if (typeof guid !== 'string' || !wanted.has(guid)) continue;
    const values: Numbers = {};
    for (const k of fields) {
      const v = num(r[k]);
      values[k] = v === null ? null : Number(v.toPrecision(6));
    }
    out.set(guid, values);
  }
  return out;
}

const ratio = (a: number | null | undefined, b: number | null | undefined): number | null =>
  a == null || b == null || b === 0 ? null : a / b;

/** Impact flags of a browser app from the current and (optional) previous window. Pure. */
export function browserSignals(cur: Numbers, prev: Numbers | null): string[] {
  const out: string[] = [];
  const pv = cur['pageViews'] ?? 0;
  const errs = cur['jsErrors'] ?? 0;
  if (pv === 0 && errs === 0) return ['no_data'];
  if (prev) {
    const rateNow = ratio(errs, pv);
    const rateBefore = ratio(prev['jsErrors'] ?? 0, prev['pageViews'] ?? 0);
    if (
      errs >= IMPACT_MIN_ERRORS &&
      rateNow !== null &&
      (rateBefore === null || rateNow > rateBefore * IMPACT_RATE_FACTOR)
    )
      out.push('js_errors_up');
    const loadNow = cur['avgLoadSeconds'];
    const loadBefore = prev['avgLoadSeconds'];
    if (
      pv >= IMPACT_MIN_VOLUME &&
      loadNow != null &&
      loadBefore != null &&
      loadNow > loadBefore * IMPACT_SLOWER_FACTOR
    )
      out.push('slower_page_loads');
    const pvBefore = prev['pageViews'] ?? 0;
    if (pvBefore >= IMPACT_MIN_VOLUME && pv < pvBefore * IMPACT_DROP_FACTOR) out.push('fewer_page_views');
  }
  if ((cur['sessionsWithErrors'] ?? 0) > 0) out.push('sessions_with_js_errors');
  return out;
}

/** Impact flags of a mobile app from the current and (optional) previous window. Pure. */
export function mobileSignals(cur: Numbers, prev: Numbers | null): string[] {
  const out: string[] = [];
  const sessions = cur['sessions'] ?? 0;
  const crashes = cur['crashes'] ?? 0;
  if (sessions === 0 && crashes === 0) return ['no_data'];
  if (prev) {
    const rateNow = ratio(crashes, sessions);
    const rateBefore = ratio(prev['crashes'] ?? 0, prev['sessions'] ?? 0);
    if (
      crashes >= IMPACT_MIN_CRASHES &&
      rateNow !== null &&
      (rateBefore === null || rateNow > rateBefore * IMPACT_RATE_FACTOR)
    )
      out.push('crashes_up');
    const before = prev['sessions'] ?? 0;
    if (before >= IMPACT_MIN_VOLUME && sessions < before * IMPACT_DROP_FACTOR) out.push('fewer_sessions');
  }
  if ((cur['usersWithCrashes'] ?? 0) > 0) out.push('users_with_crashes');
  return out;
}

const impactInput = z.strictObject({
  issue_id: issueIdInput
    .optional()
    .describe(
      'An alert issue id (list_recent_issues): its entities are the affected ones. Give this or entity_guid.',
    ),
  entity_guid: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('The affected entity guid. Give this or issue_id.'),
  account: accountInput.describe('Account of the issue (with issue_id). Default: the default.'),
  lookback: lookbackInput,
  time_range: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      `Window to measure, e.g. "last 6 hours". Default: the issue window (from ${DEFAULT_BEFORE_MINUTES} minutes before it opened until it closed or now), or "${DEFAULT_IMPACT_WINDOW}" with entity_guid.`,
    ),
  compare: z
    .boolean()
    .optional()
    .describe('Also measure the window before, to flag changes (default true; one more request per kind).'),
  max_entities: z
    .number()
    .int()
    .min(1)
    .max(MAX_FRONT_ENDS)
    .optional()
    .describe(`Most front ends to measure (default ${DEFAULT_MAX_FRONT_ENDS}, max ${MAX_FRONT_ENDS}).`),
});

const frontEndSchema = z.object({
  guid: z.string(),
  name: z.string().nullable(),
  kind: z.enum(['browser', 'mobile', 'synthetic']),
  accountId: z.number().int(),
  /** `affected`: an entity of the issue (or the one given); `related`: related to one of them. */
  via: z.enum(['affected', 'related']),
  status: z.enum(['ok', 'not_run']),
  current: z.record(z.string(), z.unknown()).nullable(),
  previous: z.record(z.string(), z.unknown()).nullable(),
  signals: z.array(z.string()),
});

const impactOutput = z.object({
  issue: issueSchema.nullable(),
  entityGuid: z.string().nullable(),
  since: z.string(),
  until: z.string(),
  previousSince: z.string().nullable(),
  affected: z.array(z.string()),
  frontEnds: z.array(frontEndSchema),
  totals: z.object({
    browserSessionsWithErrors: z.number().nullable(),
    mobileUsersWithCrashes: z.number().nullable(),
    failedSyntheticChecks: z.number().nullable(),
  }),
  partial: z.boolean(),
  notes: z.array(z.string()),
});

/**
 * Queries the impact report runs at most: browser, mobile and synthetic for the window, then browser and mobile for the
 * comparison. Front ends in more accounts add groups; the extra ones are not run (P6-20), so the cost stays a bound.
 */
const IMPACT_MAX_QUERIES = 5;
/** Issue lookup, related lookups (at most MAX_RELATED_LOOKUPS) and the queries. */
const IMPACT_COST = 1 + MAX_RELATED_LOOKUPS + IMPACT_MAX_QUERIES * NRQL_COST;

const IMPACT_DESCRIPTION = `Measure what end users saw while something was wrong: for an alert issue (issue_id) or an affected entity (entity_guid or name), find the front ends involved (browser apps, mobile apps, synthetic monitors) and report page views, load time, sessions and JavaScript errors; mobile sessions, users and crashes; synthetic checks, failures and failing locations.

By default it also measures the equal window before and flags clear changes (js_errors_up, slower_page_loads, fewer_page_views, crashes_up, fewer_sessions, failing_checks). Runs up to ${IMPACT_COST} requests (${IMPACT_MAX_QUERIES} queries at most); what does not fit is marked not_run (partial: true). Only front ends in this connection's accounts are measured. ${UNTRUSTED}`;

interface FrontEnd {
  guid: string;
  name: string | null;
  kind: FrontEndKind;
  accountId: number;
  via: 'affected' | 'related';
}

/** `generate_alert_insights_report`, `generate_user_impact_report` (read-only composites). */
export function createReportTools(deps: ToolDeps = {}): ToolDefinition[] {
  const client = toolClient(deps);
  // Sibling tools (definitions only; every call gets the per-request context).
  const siblings = new Map(
    [
      ...createEntityTools(deps),
      ...createGoldenMetricTools(deps),
      ...createErrorTools(deps),
      ...createLogTools(deps),
      ...createChangeTools(deps),
    ].map((t) => [t.name, t]),
  );
  const tool = (name: string): ToolDefinition => {
    const t = siblings.get(name);
    if (!t) throw new RbError(ErrorCode.Internal, `Report section tool ${name} is missing.`);
    return grantedSibling(t);
  };

  const insights = defineTool({
    name: 'generate_alert_insights_report',
    title: 'Generate alert insights report',
    description: INSIGHTS_DESCRIPTION,
    inputSchema: insightsInput,
    outputSchema: insightsOutput,
    kind: 'read',
    openWorld: true,
    cost: INSIGHTS_COST,
    group: 'incident-response',
    phase: 6,
    handler: async (args, ctx) => {
      const account = singleAccount(ctx, args.account);
      const lookback = lookbackRange(ctx, args.lookback);
      const issue = await lookupIssue(client(ctx), ctx, account, args.issue_id, lookback);
      const now = ctx.clock.now();
      const maxWindowMs = ctx.limits.maxWindowDays * DAY_MS;
      const win = issueWindow(
        issue,
        now,
        (args.before_minutes ?? DEFAULT_BEFORE_MINUTES) * MINUTE_MS,
        maxWindowMs,
      );
      const guid = issue.entityGuids[0] ?? null;
      const wanted = new Set<InsightSection>(args.sections ?? INSIGHT_SECTIONS);
      const notes: string[] = [];
      if (win?.cut)
        notes.push(
          "The issue lasted longer than this connection's window limit: the window was cut after its start.",
        );
      if (issue.entityGuids.length > 1)
        notes.push(
          `The issue has ${issue.entityGuids.length} entities; the sections cover the first one. Rerun the tools with another guid for the rest.`,
        );

      const sections: SectionResult[] = [];
      if (guid === null || win === null) {
        const why = guid === null ? 'The issue names no entity.' : 'The issue has no start time.';
        for (const name of INSIGHT_SECTIONS)
          if (wanted.has(name)) sections.push(notRun(name, 'not_applicable', why));
      } else {
        const window = rangeText(win.sinceMs, win.untilMs);
        const changeSince = Math.max(
          win.sinceMs - (args.change_lookback_hours ?? DEFAULT_CHANGE_LOOKBACK_HOURS) * HOUR_MS,
          win.untilMs - maxWindowMs,
        );
        const metrics = args.max_metrics ?? DEFAULT_REPORT_METRICS;
        const items: PlanItem<InsightSection>[] = [
          { name: 'entity' as const, cost: 1 },
          { name: 'golden_metrics' as const, cost: goldenCost(metrics), minCost: goldenCost(1) },
          { name: 'errors' as const, cost: 1 },
          { name: 'logs' as const, cost: 3 * NRQL_COST },
          { name: 'changes' as const, cost: 1 },
          { name: 'related' as const, cost: 1 },
        ].filter((i) => wanted.has(i.name));
        const plan = planBudget(items, ctx.budget.remaining);
        const argsFor = (name: InsightSection, granted: number): [string, Record<string, unknown>] => {
          switch (name) {
            case 'entity':
              return ['get_entity', { guid }];
            case 'golden_metrics':
              return ['get_golden_metrics', { guid, since: window, max_metrics: goldenMetricsFor(granted) }];
            case 'errors':
              return [
                'list_error_groups',
                { entity_guid: guid, time_range: window, sort_by: 'occurrences', minimal_output: true },
              ];
            case 'logs':
              return ['analyze_entity_logs', { entity_guid: guid, time_range: window }];
            case 'changes':
              return [
                'list_change_events',
                {
                  entity_guid: guid,
                  time_range: rangeText(changeSince, win.untilMs),
                  limit: 10,
                  minimal_output: true,
                },
              ];
            case 'related':
              return ['get_related_entities', { guid, limit: RELATED_LIMIT }];
          }
        };
        const ran = await Promise.all(
          plan.run.map(({ name, granted }) => {
            const [toolName, toolArgs] = argsFor(name, granted);
            return runSection(name, tool(toolName), toolArgs, ctx);
          }),
        );
        const golden = plan.run.find((r) => r.name === 'golden_metrics');
        if (golden && goldenMetricsFor(golden.granted) < metrics)
          notes.push(
            `Golden metrics reduced to ${goldenMetricsFor(golden.granted)} to fit the request budget.`,
          );
        for (const name of INSIGHT_SECTIONS) {
          if (!wanted.has(name)) continue;
          sections.push(ran.find((s) => s.name === name) ?? notRun(name, 'skipped', BUDGET_NOTE));
        }
      }

      const partial = sections.some(
        (s) => s.status === 'partial' || s.status === 'error' || s.status === 'skipped',
      );
      const count = (s: SectionStatus) => sections.filter((x) => x.status === s).length;
      const lines = [
        `Alert insights for issue ${issue.id} in account ${account}` +
          `${win ? `, window ${isoText(win.sinceMs)} to ${isoText(win.untilMs)} (UTC)` : ''}: ` +
          `${count('ok')} section(s) complete` +
          `${count('partial') ? `, ${count('partial')} partial` : ''}` +
          `${count('error') ? `, ${count('error')} failed` : ''}` +
          `${count('skipped') ? `, ${count('skipped')} skipped (budget)` : ''}` +
          `${count('not_applicable') ? `, ${count('not_applicable')} not applicable` : ''}.` +
          `${partial ? ' Partial report: see the section notes.' : ''}`,
      ];
      for (const n of notes) lines.push(`Note: ${n}`);
      lines.push('## Issue', issueBlock(issue));
      for (const s of sections) {
        lines.push(`## ${SECTION_TITLES[s.name as InsightSection]} [${s.status}]`);
        if (s.note) lines.push(`Note: ${s.note}`);
        if (s.text) lines.push(s.text);
      }
      return {
        text: lines.join('\n'),
        structured: {
          account,
          issue,
          since: win ? isoText(win.sinceMs) : null,
          until: win ? isoText(win.untilMs) : null,
          entityGuid: guid,
          sections: sections.map(({ text: _text, ...s }) => s),
          partial,
          notes,
        },
      };
    },
  });

  type QueryOutcome = { rows: Record<string, unknown>[] } | { note: string };

  const query = async (ctx: ToolContext, account: number, q: NrqlQuery): Promise<QueryOutcome> => {
    try {
      const outcome = await runNrql(
        ctx,
        { nrql: q, accounts: [account], mode: 'auto', maxPolls: 1 },
        { client: client(ctx), ...(deps.sleep ? { sleep: deps.sleep } : {}) },
      );
      if (outcome.status === 'pending') return { note: 'Still running at New Relic; try again shortly.' };
      return { rows: outcome.results as Record<string, unknown>[] };
    } catch (e) {
      if (!(e instanceof RbError) || FATAL_CODES.has(e.code)) throw e;
      if (e.code === ErrorCode.BudgetExhausted) return { note: BUDGET_NOTE };
      return { note: errorNote(e) };
    }
  };

  const impact = defineTool({
    name: 'generate_user_impact_report',
    title: 'Generate user impact report',
    description: IMPACT_DESCRIPTION,
    inputSchema: impactInput,
    outputSchema: impactOutput,
    kind: 'read',
    openWorld: true,
    cost: IMPACT_COST,
    group: 'incident-response',
    phase: 6,
    handler: async (args, ctx) => {
      if ((args.issue_id === undefined) === (args.entity_guid === undefined)) {
        throw new RbError(ErrorCode.InputInvalid, 'Give exactly one of issue_id or entity_guid.', {
          hint: 'issue_id for an alert issue, entity_guid for one affected entity.',
        });
      }
      const notes: string[] = [];
      let issue: IssueRow | null = null;
      let affected: { guid: string; name: string | null }[];
      let defaultWindow: { sinceMs: number; untilMs: number } | null = null;
      if (args.issue_id !== undefined) {
        const account = singleAccount(ctx, args.account);
        issue = await lookupIssue(
          client(ctx),
          ctx,
          account,
          args.issue_id,
          lookbackRange(ctx, args.lookback),
        );
        const names = issue.entities;
        affected = issue.entityGuids.map((guid, i) => ({ guid, name: names[i] ?? null }));
        defaultWindow = issueWindow(
          issue,
          ctx.clock.now(),
          DEFAULT_BEFORE_MINUTES * MINUTE_MS,
          ctx.limits.maxWindowDays * DAY_MS,
        );
      } else {
        const guid = args.entity_guid as string;
        const decoded = checkGuid(ctx, guid);
        if (args.account !== undefined && args.account !== decoded.accountId) {
          throw new RbError(
            ErrorCode.InputInvalid,
            `entity_guid belongs to account ${decoded.accountId}, not ${args.account}.`,
            {
              hint: 'Omit account, or pass the entity account.',
            },
          );
        }
        singleAccount(ctx, decoded.accountId);
        affected = [{ guid, name: null }];
      }
      const range =
        args.time_range !== undefined || defaultWindow === null
          ? parseTimeRange(args.time_range ?? DEFAULT_IMPACT_WINDOW, ctx.clock.now())
          : {
              sinceMs: defaultWindow.sinceMs,
              untilMs: defaultWindow.untilMs,
              windowMs: defaultWindow.untilMs - defaultWindow.sinceMs,
            };
      assertWindowWithinLimit(range, ctx.limits);
      const compare = args.compare !== false;
      const prevSince = range.sinceMs - range.windowMs;
      const cap = args.max_entities ?? DEFAULT_MAX_FRONT_ENDS;

      // Front ends among the affected entities; the others are looked up for related front ends.
      const fronts = new Map<string, FrontEnd>();
      const backends: string[] = [];
      for (const a of affected) {
        let d: ReturnType<typeof decodeEntityGuid>;
        try {
          d = decodeEntityGuid(a.guid);
        } catch {
          continue;
        }
        if (!ctx.accounts.allowed.includes(d.accountId)) continue;
        const kind = frontEndKind(d.domain, d.type);
        if (kind)
          fronts.set(a.guid, { guid: a.guid, name: a.name, kind, accountId: d.accountId, via: 'affected' });
        else backends.push(a.guid);
      }
      let partial = false;
      const lookups = backends.slice(0, MAX_RELATED_LOOKUPS);
      if (backends.length > lookups.length)
        notes.push(
          `Related front ends were looked up for the first ${MAX_RELATED_LOOKUPS} of ${backends.length} affected entities.`,
        );
      const relatedPlan = planBudget(
        lookups.map((g) => ({ name: g, cost: 1 })),
        ctx.budget.remaining,
      );
      if (relatedPlan.skipped.length > 0) {
        partial = true;
        notes.push(
          `Related front ends of ${relatedPlan.skipped.length} entit(ies) not looked up: request budget exhausted.`,
        );
      }
      const related = await Promise.all(
        relatedPlan.run.map(({ name }) =>
          runSection(
            name,
            tool('get_related_entities'),
            { guid: name, types: FRONT_END_TYPES, limit: MAX_FRONT_ENDS },
            ctx,
          ),
        ),
      );
      for (const r of related) {
        if (r.status !== 'ok' && r.status !== 'partial') {
          partial = true;
          notes.push(`Related front ends: ${r.note ?? 'not available'}`);
          continue;
        }
        const rows = (r.data?.['related'] ?? []) as { guid: string; name: string; accountId: number }[];
        for (const row of rows) {
          if (fronts.has(row.guid)) continue;
          let d: ReturnType<typeof decodeEntityGuid>;
          try {
            d = decodeEntityGuid(row.guid);
          } catch {
            continue;
          }
          const kind = frontEndKind(d.domain, d.type);
          // get_related_entities already dropped rows outside the connection's accounts (T3); checked again here.
          if (!kind || d.accountId !== row.accountId || !ctx.accounts.allowed.includes(d.accountId)) continue;
          fronts.set(row.guid, {
            guid: row.guid,
            name: row.name,
            kind,
            accountId: d.accountId,
            via: 'related',
          });
        }
      }
      const all = [...fronts.values()];
      const measured = all.slice(0, cap);
      if (all.length > measured.length)
        notes.push(`${all.length - measured.length} more front end(s) not measured: raise max_entities.`);

      // One query per kind and account, current windows first, then the comparison.
      const groups = new Map<string, { kind: FrontEndKind; account: number; guids: string[] }>();
      for (const f of measured) {
        const key = `${f.kind}:${f.accountId}`;
        const g = groups.get(key) ?? { kind: f.kind, account: f.accountId, guids: [] };
        g.guids.push(f.guid);
        groups.set(key, g);
      }
      const ORDER: Record<FrontEndKind, number> = { synthetic: 0, browser: 1, mobile: 2 };
      const ordered = [...groups.entries()].sort((a, b) => ORDER[a[1].kind] - ORDER[b[1].kind]);
      const wantedJobs: PlanItem<string>[] = [
        ...ordered.map(([key]) => ({ name: `cur|${key}`, cost: NRQL_COST })),
        ...(compare
          ? ordered
              .filter(([, g]) => g.kind !== 'synthetic')
              .map(([key]) => ({ name: `prev|${key}`, cost: NRQL_COST }))
          : []),
      ];
      const jobs = wantedJobs.slice(0, IMPACT_MAX_QUERIES);
      if (wantedJobs.length > jobs.length) {
        partial = true;
        notes.push(
          `${wantedJobs.length - jobs.length} query(ies) not run: the report sends at most ${IMPACT_MAX_QUERIES} (narrow with max_entities or an entity in one account).`,
        );
      }
      const queryPlan = planBudget(jobs, ctx.budget.remaining);
      const results = new Map<string, QueryOutcome>();
      await Promise.all(
        queryPlan.run.map(async ({ name }) => {
          const [when, key] = name.split('|') as ['cur' | 'prev', string];
          const g = groups.get(key) as { kind: FrontEndKind; account: number; guids: string[] };
          const [s, u] = when === 'cur' ? [range.sinceMs, range.untilMs] : [prevSince, range.sinceMs];
          const q =
            g.kind === 'browser'
              ? browserQuery(g.guids, s, u)
              : g.kind === 'mobile'
                ? mobileQuery(g.guids, s, u)
                : checkQuery(g.guids, s, u);
          results.set(name, await query(ctx, g.account, q));
        }),
      );
      if (queryPlan.skipped.length > 0) {
        partial = true;
        notes.push(`${queryPlan.skipped.length} query(ies) not run: request budget exhausted.`);
      }
      const KIND_LABEL: Record<FrontEndKind, string> = {
        browser: 'Browser',
        mobile: 'Mobile',
        synthetic: 'Synthetic',
      };
      for (const [name, r] of results) {
        if ('note' in r) {
          partial = true;
          const [when, key] = name.split('|') as [string, string];
          const g = groups.get(key);
          notes.push(
            `${g ? KIND_LABEL[g.kind] : ''} ${when === 'cur' ? 'signals' : 'comparison'} (account ${g?.account}): ${r.note}`,
          );
        }
      }

      for (const [name, r] of results) {
        if (name.startsWith('cur|synthetic') && 'rows' in r && r.rows.length >= SYNTH_ROWS)
          notes.push(`Synthetic results are based on the first ${SYNTH_ROWS} monitor/location rows.`);
      }
      const frontEnds: z.infer<typeof frontEndSchema>[] = measured.map((f) => {
        const key = `${f.kind}:${f.accountId}`;
        const cur = results.get(`cur|${key}`);
        const prev = results.get(`prev|${key}`);
        const wanted = new Set([f.guid]);
        const base = { guid: f.guid, name: f.name, kind: f.kind, accountId: f.accountId, via: f.via };
        if (!cur || 'note' in cur)
          return { ...base, status: 'not_run' as const, current: null, previous: null, signals: [] };
        if (f.kind === 'synthetic') {
          const r = readChecks(cur.rows, wanted).get(f.guid);
          const current = r
            ? {
                checks: r.checks,
                failures: r.failures,
                failurePercent: r.failurePercent,
                lastResult: r.lastResult,
                failingLocations: r.locations
                  .filter((l) => l.failures > 0)
                  .map((l) => ({
                    location: l.location,
                    failurePercent: l.failurePercent,
                    lastError: l.lastError,
                  })),
              }
            : { checks: 0, failures: 0, failurePercent: 0, lastResult: null, failingLocations: [] };
          const signals = current.checks === 0 ? ['no_data'] : current.failures > 0 ? ['failing_checks'] : [];
          return { ...base, status: 'ok' as const, current, previous: null, signals };
        }
        const fields = f.kind === 'browser' ? BROWSER_FIELDS : MOBILE_FIELDS;
        const empty = Object.fromEntries(fields.map((k) => [k, 0])) as Numbers;
        const current = readFacetNumbers(cur.rows, fields, wanted).get(f.guid) ?? empty;
        const previous =
          prev && !('note' in prev)
            ? (readFacetNumbers(prev.rows, fields, wanted).get(f.guid) ?? empty)
            : null;
        const signals =
          f.kind === 'browser' ? browserSignals(current, previous) : mobileSignals(current, previous);
        return { ...base, status: 'ok' as const, current, previous, signals };
      });

      const sum = (kind: FrontEndKind, field: string): number | null => {
        const rows = frontEnds.filter((f) => f.kind === kind && f.current !== null);
        if (rows.length === 0) return null;
        return rows.reduce((n, f) => n + (num((f.current as Record<string, unknown>)[field]) ?? 0), 0);
      };
      const totals = {
        browserSessionsWithErrors: sum('browser', 'sessionsWithErrors'),
        mobileUsersWithCrashes: sum('mobile', 'usersWithCrashes'),
        failedSyntheticChecks: sum('synthetic', 'failures'),
      };

      const lines = [
        `User impact ${issue ? `of issue ${issue.id}` : 'around the entity'}, ${isoText(range.sinceMs)} to ${isoText(range.untilMs)} (UTC)` +
          `${compare ? ', compared with the equal window before' : ''}: ${frontEnds.length} front end(s) measured` +
          ` (${frontEnds.filter((f) => f.signals.some((s) => s !== 'no_data')).length} with impact signals).` +
          `${partial ? ' Partial report: see notes.' : ''}`,
      ];
      if (frontEnds.length === 0)
        lines.push(
          'No browser app, mobile app or synthetic monitor is affected or directly related. Check the entity relationships with get_related_entities.',
        );
      const totalBits = [
        totals.browserSessionsWithErrors !== null
          ? `browser sessions with JS errors: ${totals.browserSessionsWithErrors}`
          : null,
        totals.mobileUsersWithCrashes !== null
          ? `mobile users with crashes: ${totals.mobileUsersWithCrashes}`
          : null,
        totals.failedSyntheticChecks !== null
          ? `failed synthetic checks: ${totals.failedSyntheticChecks}`
          : null,
      ].filter((x) => x !== null);
      if (totalBits.length > 0)
        lines.push(
          `Totals (per-app counts added up, so a user of several apps counts more than once): ${totalBits.join('; ')}.`,
        );
      for (const n of notes) lines.push(`Note: ${n}`);
      if (issue) lines.push('## Issue', issueBlock(issue));
      const cell = (v: unknown) =>
        typeof v === 'number' ? v : v === null || v === undefined ? '' : String(v);
      for (const kind of ['browser', 'mobile', 'synthetic'] as const) {
        const rows = frontEnds.filter((f) => f.kind === kind);
        if (rows.length === 0) continue;
        lines.push(`## ${KIND_LABEL[kind]}`);
        lines.push(
          shapeRows(
            rows.map((f) => {
              const c = (f.current ?? {}) as Record<string, unknown>;
              const p = (f.previous ?? {}) as Record<string, unknown>;
              const row: Record<string, unknown> = { name: f.name ?? f.guid, via: f.via, status: f.status };
              if (kind === 'synthetic') {
                row['checks'] = cell(c['checks']);
                row['failed_pct'] = cell(c['failurePercent']);
                row['failing_locations'] = Array.isArray(c['failingLocations'])
                  ? (c['failingLocations'] as { location: string }[]).map((l) => l.location).join('; ')
                  : '';
              } else {
                for (const k of kind === 'browser' ? BROWSER_FIELDS : MOBILE_FIELDS) {
                  row[k] = cell(c[k]);
                  if (f.previous) row[`${k}_before`] = cell(p[k]);
                }
              }
              row['signals'] = f.signals.join(' ');
              return row;
            }),
            { format: 'csv', source: `New Relic ${kind} signals`, maxRows: MAX_FRONT_ENDS },
          ).text,
        );
      }

      return {
        text: lines.join('\n'),
        structured: {
          issue,
          entityGuid: args.entity_guid ?? null,
          since: isoText(range.sinceMs),
          until: isoText(range.untilMs),
          previousSince: compare ? isoText(prevSince) : null,
          affected: affected.map((a) => a.guid),
          frontEnds,
          totals,
          partial,
          notes,
        },
      };
    },
  });

  return [insights as ToolDefinition, impact as ToolDefinition];
}
