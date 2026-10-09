// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { ToolContext } from '../context.ts';
import { ErrorCode, RbError } from '../errors.ts';
import {
  CHANGE_EVENTS_QUERY,
  type ChangeEventData,
  type DeploymentData,
  ENTITY_DEPLOYMENTS_QUERY,
} from '../nerdgraph/change-tracking.ts';
import { decodeEntityGuid } from '../nerdgraph/entity-guid.ts';
import { type NrqlComplete, runNrql } from '../nrql/engine.ts';
import { type NrqlQuery, nrql } from '../nrql/template.ts';
import { pickFields } from '../output/compact.ts';
import { shapeRows } from '../output/format.ts';
import { parseTimeRange } from '../time/range.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { checkGuid, guidAgrees, isNonNull, outOfScope, requireField } from './entities.ts';
import { cleanName, maskEmail } from './identity.ts';
import {
  accountInput,
  assertWindowWithinLimit,
  label,
  num,
  singleAccount,
  type ToolDeps,
  timeRangeInput,
  toolClient,
  UNTRUSTED,
} from './shared.ts';

const DEFAULT_WINDOW = 'last 7 days';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_TEXT_CHARS = 500;
const MINUTE_MS = 60_000;
const DEFAULT_COMPARE_MINUTES = 30;
const MAX_COMPARE_MINUTES = 720;
/** The after window must be at least this long before a comparison means anything. */
export const MIN_AFTER_MS: number = 5 * MINUTE_MS;
/** A deployment at `deployment_time` is looked up this far around it to find its record (version, commit…). */
const MATCH_WINDOW_MS = 60 * MINUTE_MS;
/** Fewest transactions in each window before latency or error rate verdicts are given. */
export const MIN_SAMPLES = 30;
/** Latency moves smaller than this fraction count as noise. */
export const LATENCY_BAND = 0.15;
/** Throughput moves smaller than this fraction count as noise. */
export const THROUGHPUT_BAND = 0.25;
/** Error rate moves smaller than this many percentage points count as noise. */
export const ERROR_RATE_MIN_PP = 0.5;
/** |z| of the two-proportion test that counts as a real change in error rate (about p < 0.003). */
export const ERROR_RATE_Z = 3;

const instant = (ms: unknown): string | null => {
  const n = num(ms);
  return n === null || Math.abs(n) > 8.64e15 ? null : new Date(n).toISOString();
};

/** Users are often email addresses: shown masked, like every other email the tools return. */
const person = (v: string | null | undefined): string | null => {
  if (typeof v !== 'string' || v === '') return null;
  const clean = cleanName(v, 128);
  return clean.includes('@') ? maskEmail(clean) : clean;
};

const text = (v: string | null | undefined, max = MAX_TEXT_CHARS): string | null =>
  typeof v === 'string' && v !== '' ? cleanName(v, max) : null;

// ---------------------------------------------------------------------------------------------------------------------
// list_change_events
// ---------------------------------------------------------------------------------------------------------------------

const listInput = z.strictObject({
  entity_guid: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('Only deployments of this entity (guid). Implies its account.'),
  time_range: timeRangeInput(DEFAULT_WINDOW),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Most events to return, newest first (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
  account: accountInput,
  minimal_output: z
    .boolean()
    .optional()
    .describe('Only id, time, type, entity, version and a short description.'),
});

const listOutput = z.object({
  account: z.number().int(),
  since: z.string(),
  until: z.string(),
  scope: z.enum(['account', 'entity_deployments']),
  events: z.array(z.record(z.string(), z.unknown())),
  /** The page is full: older events in the window may exist. Narrow the window or raise limit. */
  maybeMore: z.boolean(),
  hiddenOutsideScope: z.boolean(),
});

const LIST_DESCRIPTION = `List change events, newest first: deployments, feature flag and configuration changes and other change-tracking markers, with time, type, user, entity, description and, for deployments, version, commit, changelog and link.

Use it for "what changed before things broke?". With an entity (guid or name) it lists that entity's deployments; without one, every change event of one account. No paging: if maybe_more is true, narrow time_range or raise limit. To judge whether a deployment hurt use analyze_deployment_impact. It cannot record a change. ${UNTRUSTED}`;

function eventRow(e: ChangeEventData, entityGuid: string | null) {
  return {
    id: cleanName(e.changeTrackingId ?? '', 128),
    time: instant(e.timestamp),
    category: label(e.category),
    type: label(e.type),
    categoryAndType: label(e.categoryAndType),
    entityGuid,
    entityName: text(e.entity?.name, 200),
    user: person(e.user),
    shortDescription: text(e.shortDescription, 200),
    description: text(e.description),
    version: text(e.version, 128),
    commit: text(e.commit, 128),
    changelog: text(e.changelog),
    link: text(e.deepLink, 500),
    featureFlagId: text(e.featureFlagId, 128),
    groupId: text(e.groupId, 128),
  };
}

function deploymentRow(d: DeploymentData, entityName: string | null) {
  return {
    id: cleanName(d.deploymentId ?? '', 128),
    time: instant(d.timestamp),
    category: 'DEPLOYMENT',
    type: label(d.deploymentType),
    categoryAndType: null,
    entityGuid: d.entityGuid ?? null,
    entityName,
    user: person(d.user),
    shortDescription: null,
    description: text(d.description),
    version: text(d.version, 128),
    commit: text(d.commit, 128),
    changelog: text(d.changelog),
    link: text(d.deepLink, 500),
    featureFlagId: null,
    groupId: text(d.groupId, 128),
  };
}

type EventRow = ReturnType<typeof eventRow>;
const newestFirst = (a: EventRow, b: EventRow) => (b.time ?? '').localeCompare(a.time ?? '');
const MINIMAL_FIELDS = ['id', 'time', 'type', 'entityGuid', 'version', 'shortDescription'] as const;

// ---------------------------------------------------------------------------------------------------------------------
// analyze_deployment_impact
// ---------------------------------------------------------------------------------------------------------------------

const analyzeInput = z.strictObject({
  entity_guid: z
    .string()
    .min(1)
    .max(256)
    .describe('The APM application to analyse (guid from search_entities).'),
  deployment_time: z
    .string()
    .min(10)
    .max(40)
    .optional()
    .describe(
      'When the change happened, ISO 8601 (UTC unless offset), e.g. "2026-10-01T14:30:00Z". Default: the entity\'s latest deployment in the lookback window.',
    ),
  compare_minutes: z
    .number()
    .int()
    .min(5)
    .max(MAX_COMPARE_MINUTES)
    .optional()
    .describe(
      `Minutes compared before and after the deployment (default ${DEFAULT_COMPARE_MINUTES}, max ${MAX_COMPARE_MINUTES}); shrinks if the deployment is recent.`,
    ),
  lookback: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      `Where to find the latest deployment when deployment_time is omitted. Default "${DEFAULT_WINDOW}".`,
    ),
});

export const VERDICTS = ['worse', 'better', 'similar', 'changed', 'inconclusive', 'not_run'] as const;
export type Verdict = (typeof VERDICTS)[number];

const metricOut = z.object({
  metric: z.string(),
  unit: z.string(),
  before: z.number().nullable(),
  after: z.number().nullable(),
  delta: z.number().nullable(),
  /** (after - before) / before; null when before is 0 or missing. */
  changeRatio: z.number().nullable(),
  verdict: z.enum(VERDICTS),
  note: z.string().nullable(),
});

const analyzeOutput = z.object({
  status: z.enum(['analyzed', 'no_deployment', 'too_recent']),
  entity: z.object({
    guid: z.string(),
    name: z.string().nullable(),
    accountId: z.number().int(),
  }),
  deployment: z
    .object({
      time: z.string(),
      recorded: z.boolean(),
      id: z.string().nullable(),
      version: z.string().nullable(),
      commit: z.string().nullable(),
      user: z.string().nullable(),
      description: z.string().nullable(),
      changelog: z.string().nullable(),
      link: z.string().nullable(),
    })
    .nullable(),
  windows: z
    .object({
      minutes: z.number(),
      before: z.object({ since: z.string(), until: z.string() }),
      after: z.object({ since: z.string(), until: z.string() }),
    })
    .nullable(),
  metrics: z.array(metricOut),
  overall: z
    .enum(['regression_suspected', 'improvement', 'no_significant_change', 'inconclusive'])
    .nullable(),
  /** A window was not queried (budget) or failed. */
  partial: z.boolean(),
  notes: z.array(z.string()),
});

const ANALYZE_DESCRIPTION = `Compare an APM application's throughput, error rate and response time in equal windows before and after a deployment, with a verdict per metric (worse, better, similar, changed, inconclusive) and an overall call.

Takes the application (guid or name). Uses its latest deployment of the last 7 days (see list_change_events) unless deployment_time is given, e.g. for an unrecorded rollout. Windows default to 30 minutes each, shorter for a recent deployment. Runs about 3 requests; a stopped window leaves the other (partial). An indication, not proof: traffic shifts and other changes also move these numbers; verdicts need at least ${MIN_SAMPLES} transactions per window. APM applications only. Without a deployment, compare with the previous window using analyze_transactions. ${UNTRUSTED}`;

export interface WindowStats {
  /** Transactions counted. */
  readonly requests: number | null;
  /** Percentage (0-100). */
  readonly errorRate: number | null;
  readonly avgDuration: number | null;
  readonly p95Duration: number | null;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** A plain number, or the first numeric member of an object (percentile results are keyed by percentile). */
export const numberOf = (v: unknown): number | null => {
  if (isNum(v)) return v;
  if (v !== null && typeof v === 'object')
    return Object.values(v as Record<string, unknown>).find(isNum) ?? null;
  return null;
};

/** The one result row of the window query. Pure. */
export function windowStats(rows: readonly Record<string, unknown>[]): WindowStats {
  const r = rows[0] ?? {};
  return {
    requests: numberOf(r['requests']),
    errorRate: numberOf(r['errorRate']),
    avgDuration: numberOf(r['avgDuration']),
    p95Duration: numberOf(r['p95Duration']),
  };
}

const ratio = (before: number | null, after: number | null): number | null =>
  before === null || after === null || before === 0 ? null : (after - before) / Math.abs(before);

/** Two-proportion z of error counts (pooled). Null when it cannot be computed. Pure. */
export function errorRateZ(before: WindowStats, after: WindowStats): number | null {
  const { requests: n1, errorRate: r1 } = before;
  const { requests: n2, errorRate: r2 } = after;
  if (n1 === null || n2 === null || r1 === null || r2 === null || n1 <= 0 || n2 <= 0) return null;
  const p1 = r1 / 100;
  const p2 = r2 / 100;
  const pooled = (p1 * n1 + p2 * n2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  return se === 0 ? 0 : (p2 - p1) / se;
}

export interface MetricOut {
  metric: string;
  unit: string;
  before: number | null;
  after: number | null;
  delta: number | null;
  changeRatio: number | null;
  verdict: Verdict;
  note: string | null;
}

const metric = (
  name: string,
  unit: string,
  before: number | null,
  after: number | null,
  verdict: Verdict,
  note: string | null = null,
): MetricOut => ({
  metric: name,
  unit,
  before,
  after,
  delta: before === null || after === null ? null : after - before,
  changeRatio: ratio(before, after),
  verdict,
  note,
});

/**
 * Compare two windows. Pure: no clock, no I/O. `before`/`after` null = that window was not evaluated.
 * Verdicts need MIN_SAMPLES transactions in both windows (except throughput, which is the sample size itself).
 */
export function compareWindows(
  before: WindowStats | null,
  after: WindowStats | null,
  minutes: number,
): {
  metrics: MetricOut[];
  overall: 'regression_suspected' | 'improvement' | 'no_significant_change' | 'inconclusive';
} {
  if (!before || !after) {
    const why = before ? 'The after window was not evaluated.' : 'The before window was not evaluated.';
    const row = (name: string, unit: string, k: (s: WindowStats) => number | null) =>
      metric(name, unit, before ? k(before) : null, after ? k(after) : null, 'not_run', why);
    return {
      metrics: [
        row('throughput', 'requests/min', (s) => (s.requests === null ? null : s.requests / minutes)),
        row('error_rate', 'percent', (s) => s.errorRate),
        row('avg_response_time', 'seconds', (s) => s.avgDuration),
        row('p95_response_time', 'seconds', (s) => s.p95Duration),
      ],
      overall: 'inconclusive',
    };
  }
  const enough =
    before.requests !== null &&
    after.requests !== null &&
    before.requests >= MIN_SAMPLES &&
    after.requests >= MIN_SAMPLES;
  const few = `Fewer than ${MIN_SAMPLES} transactions in a window.`;

  const tput0 = before.requests === null ? null : before.requests / minutes;
  const tput1 = after.requests === null ? null : after.requests / minutes;
  const tputChange = ratio(tput0, tput1);
  const tput = metric(
    'throughput',
    'requests/min',
    tput0,
    tput1,
    tputChange === null ? 'inconclusive' : Math.abs(tputChange) > THROUGHPUT_BAND ? 'changed' : 'similar',
    tputChange === null ? 'No traffic in the before window.' : null,
  );

  let errVerdict: Verdict = 'inconclusive';
  let errNote: string | null = few;
  if (enough && before.errorRate !== null && after.errorRate !== null) {
    const z = errorRateZ(before, after);
    const pp = after.errorRate - before.errorRate;
    errNote = z === null ? null : `z = ${z.toFixed(1)}`;
    if (z === null || Math.abs(z) < ERROR_RATE_Z || Math.abs(pp) < ERROR_RATE_MIN_PP) errVerdict = 'similar';
    else errVerdict = pp > 0 ? 'worse' : 'better';
  }
  const err = metric('error_rate', 'percent', before.errorRate, after.errorRate, errVerdict, errNote);

  const latency = (name: string, b: number | null, a: number | null) => {
    if (!enough || b === null || a === null) return metric(name, 'seconds', b, a, 'inconclusive', few);
    const r = ratio(b, a);
    if (r === null) return metric(name, 'seconds', b, a, 'inconclusive', 'No baseline latency.');
    return metric(
      name,
      'seconds',
      b,
      a,
      Math.abs(r) <= LATENCY_BAND ? 'similar' : r > 0 ? 'worse' : 'better',
    );
  };
  const avg = latency('avg_response_time', before.avgDuration, after.avgDuration);
  const p95 = latency('p95_response_time', before.p95Duration, after.p95Duration);

  const metrics = [tput, err, avg, p95];
  const judged = [err, avg, p95];
  const overall = judged.some((m) => m.verdict === 'worse')
    ? 'regression_suspected'
    : judged.every((m) => m.verdict === 'inconclusive')
      ? 'inconclusive'
      : judged.some((m) => m.verdict === 'better')
        ? 'improvement'
        : 'no_significant_change';
  return { metrics, overall };
}

/** ISO 8601 date-time (UTC when no offset is given) to epoch ms, or null. */
export function parseInstant(value: string): number | null {
  const m =
    /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(:\d{2}(?:\.\d{1,3})?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(
      value.trim(),
    );
  if (!m) return null;
  const [, date, hm, sec, zone] = m;
  const zoneNorm = zone
    ? zone.toUpperCase() === 'Z'
      ? 'Z'
      : zone.replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2')
    : 'Z';
  const ms = Date.parse(`${date}T${hm ?? '00:00'}${sec ?? ':00'}${zoneNorm}`);
  return Number.isFinite(ms) ? ms : null;
}

const windowQuery = (guid: string, sinceMs: number, untilMs: number): NrqlQuery => {
  const since = Math.floor(sinceMs / 1000);
  const until = Math.ceil(untilMs / 1000);
  return nrql`SELECT count(*) AS requests, percentage(count(*), WHERE error IS true) AS errorRate, average(duration) AS avgDuration, percentile(duration, 95) AS p95Duration FROM Transaction WHERE entityGuid = ${guid} SINCE ${since} UNTIL ${until}`;
};

/** Errors that make every window fail the same way: abort instead of reporting two identical failures. */
export const FATAL_CODES: ReadonlySet<string> = new Set([
  ErrorCode.AuthUnauthorized,
  ErrorCode.AuthForbidden,
  ErrorCode.AuthInvalidKey,
  ErrorCode.AuthWrongRegion,
]);

const fmt = (v: number | null) => (v === null ? '' : String(Number(v.toPrecision(4))));
const pct = (r: number | null) => (r === null ? '' : `${r >= 0 ? '+' : ''}${(r * 100).toFixed(1)}%`);

/** `list_change_events` and `analyze_deployment_impact` (read-only, change tracking). */
export function createChangeTools(deps: ToolDeps = {}): ToolDefinition[] {
  const client = toolClient(deps);

  const listChangeEvents = defineTool({
    name: 'list_change_events',
    title: 'List change events',
    description: LIST_DESCRIPTION,
    inputSchema: listInput,
    outputSchema: listOutput,
    kind: 'read',
    openWorld: true,
    cost: 1,
    group: 'incident-response',
    phase: 6,
    handler: async (args, ctx) => {
      const limit = args.limit ?? DEFAULT_LIMIT;
      const range = parseTimeRange(args.time_range ?? DEFAULT_WINDOW, ctx.clock.now());
      assertWindowWithinLimit(range, ctx.limits);
      const timeWindow = { startTime: range.sinceMs, endTime: range.untilMs };

      let account: number;
      let rows: EventRow[];
      let hiddenOutsideScope = false;
      let maybeMore: boolean;
      let scope: 'account' | 'entity_deployments';

      if (args.entity_guid !== undefined) {
        const guid = args.entity_guid;
        const decoded = checkGuid(ctx, guid);
        if (args.account !== undefined && args.account !== decoded.accountId) {
          throw new RbError(
            ErrorCode.InputInvalid,
            `entity_guid belongs to account ${decoded.accountId}, not ${args.account}.`,
            { hint: 'Omit account, or pass the entity account.' },
          );
        }
        account = singleAccount(ctx, decoded.accountId);
        scope = 'entity_deployments';
        const result = await client(ctx).query(ENTITY_DEPLOYMENTS_QUERY, {
          guid: guid,
          filter: { limit, timeWindow },
        });
        const entity = requireField(result.data.actor.entity, result, ctx);
        const reported = entity.accountId ?? account;
        if (reported !== account || !ctx.accounts.allowed.includes(reported)) throw outOfScope(reported);
        const all = (entity.deploymentSearch?.results ?? []).filter(isNonNull);
        // Every deployment must belong to the entity asked for.
        const mine = all.filter(
          (d) => d.entityGuid === undefined || d.entityGuid === null || d.entityGuid === guid,
        );
        hiddenOutsideScope = all.length > mine.length;
        const name = typeof entity.name === 'string' ? cleanName(entity.name, 200) : null;
        rows = mine.map((d) => deploymentRow({ ...d, entityGuid: d.entityGuid ?? guid }, name));
        maybeMore = all.length >= limit;
      } else {
        account = singleAccount(ctx, args.account);
        scope = 'account';
        const result = await client(ctx).query(CHANGE_EVENTS_QUERY, {
          filter: { accountIds: [account], limit, timeWindow },
        });
        const all = (result.data.actor.changeTracking?.changeTrackingSearch?.changeEvents ?? []).filter(
          isNonNull,
        );
        // An event is shown only if its entity decodes to the requested, allowed account (T3).
        const vouched = all.flatMap((e) => {
          const guid = e.entity?.guid;
          if (typeof guid !== 'string') return [];
          try {
            const { accountId } = decodeEntityGuid(guid);
            return accountId === account &&
              ctx.accounts.allowed.includes(accountId) &&
              guidAgrees(guid, account)
              ? [eventRow(e, guid)]
              : [];
          } catch {
            return [];
          }
        });
        hiddenOutsideScope = all.length > vouched.length;
        rows = vouched;
        maybeMore = all.length >= limit;
      }
      rows = rows.sort(newestFirst).slice(0, limit);
      const events = args.minimal_output
        ? pickFields(rows, MINIMAL_FIELDS)
        : (rows as Record<string, unknown>[]);

      const lines = [
        `${rows.length} change event${rows.length === 1 ? '' : 's'} ${scope === 'entity_deployments' ? '(deployments of the entity) ' : ''}in account ${account}, ${range.since} to ${range.until} (UTC), newest first.`,
      ];
      if (hiddenOutsideScope) lines.push("Note: events outside this connection's accounts were left out.");
      if (maybeMore)
        lines.push('The page is full: older events may exist. Narrow time_range or raise limit.');
      if (rows.length > 0) {
        lines.push(
          shapeRows(
            rows.map((r) => ({
              time: r.time ?? '',
              type: r.categoryAndType ?? r.type ?? r.category ?? '',
              entity: r.entityName ?? r.entityGuid ?? '',
              version: r.version ?? '',
              user: r.user ?? '',
              description: r.shortDescription ?? r.description ?? '',
              ...(args.minimal_output
                ? {}
                : { commit: r.commit ?? '', changelog: r.changelog ?? '', link: r.link ?? '' }),
            })),
            {
              format: 'csv',
              source: 'New Relic change tracking',
              maxRows: MAX_LIMIT,
              maxCellChars: MAX_TEXT_CHARS,
            },
          ).text,
        );
      }
      return {
        text: lines.join('\n'),
        structured: {
          account,
          since: range.since,
          until: range.until,
          scope,
          events,
          maybeMore,
          hiddenOutsideScope,
        },
      };
    },
  });

  type Outcome = { ok: true; stats: WindowStats } | { ok: false; note: string };

  async function runWindow(
    ctx: ToolContext,
    account: number,
    guid: string,
    sinceMs: number,
    untilMs: number,
  ): Promise<Outcome> {
    try {
      const outcome = await runNrql(
        ctx,
        // One poll at most: a slow window is reported rather than spending the budget.
        { nrql: windowQuery(guid, sinceMs, untilMs), accounts: [account], mode: 'auto', maxPolls: 1 },
        { client: client(ctx), ...(deps.sleep ? { sleep: deps.sleep } : {}) },
      );
      if (outcome.status === 'pending')
        return { ok: false, note: 'Still running at New Relic; try again shortly.' };
      const done: NrqlComplete = outcome;
      return { ok: true, stats: windowStats(done.results) };
    } catch (e) {
      if (!(e instanceof RbError) || FATAL_CODES.has(e.code)) throw e;
      if (e.code === ErrorCode.BudgetExhausted) return { ok: false, note: 'Request budget exhausted.' };
      return { ok: false, note: cleanName(e.message, 300) };
    }
  }

  const analyze = defineTool({
    name: 'analyze_deployment_impact',
    title: 'Analyze deployment impact',
    description: ANALYZE_DESCRIPTION,
    inputSchema: analyzeInput,
    outputSchema: analyzeOutput,
    kind: 'read',
    openWorld: true,
    // One entity and deployments lookup plus one NRQL query for each of the two windows.
    cost: 3,
    group: 'incident-response',
    phase: 6,
    handler: async (args, ctx) => {
      const decoded = checkGuid(ctx, args.entity_guid);
      const account = singleAccount(ctx, decoded.accountId);
      const now = ctx.clock.now();
      const compareMs = (args.compare_minutes ?? DEFAULT_COMPARE_MINUTES) * MINUTE_MS;

      let explicitAt: number | null = null;
      if (args.deployment_time !== undefined) {
        explicitAt = parseInstant(args.deployment_time);
        if (explicitAt === null) {
          throw new RbError(ErrorCode.InputInvalid, 'deployment_time is not an ISO 8601 date-time.', {
            hint: 'Use e.g. "2026-10-01T14:30:00Z".',
          });
        }
        if (explicitAt > now) {
          throw new RbError(ErrorCode.InputInvalid, 'deployment_time is in the future.');
        }
      }
      let search: { startTime: number; endTime: number };
      if (explicitAt !== null) {
        search = {
          startTime: explicitAt - MATCH_WINDOW_MS,
          endTime: Math.min(now, explicitAt + MATCH_WINDOW_MS),
        };
      } else {
        const lookback = parseTimeRange(args.lookback ?? DEFAULT_WINDOW, now);
        assertWindowWithinLimit(lookback, ctx.limits);
        search = { startTime: lookback.sinceMs, endTime: lookback.untilMs };
      }
      assertWindowWithinLimit({ windowMs: 2 * compareMs }, ctx.limits);

      const result = await client(ctx).query(ENTITY_DEPLOYMENTS_QUERY, {
        guid: args.entity_guid,
        filter: { limit: 100, timeWindow: search },
      });
      const e = requireField(result.data.actor.entity, result, ctx);
      const reported = e.accountId ?? account;
      if (reported !== account || !ctx.accounts.allowed.includes(reported)) throw outOfScope(reported);
      if (e.domain !== 'APM' || e.type !== 'APPLICATION') {
        throw new RbError(
          ErrorCode.InputInvalid,
          'analyze_deployment_impact supports APM applications only.',
          {
            hint: 'Use search_entities with domain APM and type APPLICATION, or run_nrql for other entities.',
          },
        );
      }
      const entity = {
        guid: args.entity_guid,
        name: typeof e.name === 'string' ? cleanName(e.name, 200) : null,
        accountId: account,
      };
      const deployments = (e.deploymentSearch?.results ?? [])
        .filter(isNonNull)
        .filter((d) => typeof d.timestamp === 'number' && Number.isFinite(d.timestamp));
      const target = explicitAt ?? Math.max(-1, ...deployments.map((d) => d.timestamp as number));
      const record =
        explicitAt === null
          ? deployments.find((d) => d.timestamp === target)
          : deployments.reduce<DeploymentData | undefined>((best, d) => {
              const dist = Math.abs((d.timestamp as number) - explicitAt);
              return dist <= MATCH_WINDOW_MS &&
                (!best || dist < Math.abs((best.timestamp as number) - explicitAt))
                ? d
                : best;
            }, undefined);

      const base = { entity, metrics: [] as MetricOut[], overall: null, partial: false };
      if (explicitAt === null && target < 0) {
        const notes = ['No deployment is recorded for this entity in the lookback window.'];
        return {
          text: `${notes[0]} Pass deployment_time to analyse a specific moment, or widen lookback.`,
          structured: { status: 'no_deployment' as const, ...base, deployment: null, windows: null, notes },
        };
      }

      const deployment = {
        time: new Date(target).toISOString(),
        recorded: record !== undefined,
        id: record ? text(record.deploymentId, 128) : null,
        version: record ? text(record.version, 128) : null,
        commit: record ? text(record.commit, 128) : null,
        user: record ? person(record.user) : null,
        description: record ? text(record.description) : null,
        changelog: record ? text(record.changelog) : null,
        link: record ? text(record.deepLink, 500) : null,
      };
      const afterMs = Math.min(compareMs, now - target);
      if (afterMs < MIN_AFTER_MS) {
        const notes = [
          `The deployment (${deployment.time}) is less than ${MIN_AFTER_MS / MINUTE_MS} minutes old: not enough data after it. Try again later.`,
        ];
        return {
          text: notes[0] as string,
          structured: { status: 'too_recent' as const, ...base, deployment, windows: null, notes },
        };
      }
      const minutes = afterMs / MINUTE_MS;
      const beforeWin = { sinceMs: target - afterMs, untilMs: target };
      const afterWin = { sinceMs: target, untilMs: target + afterMs };

      // Budget-aware: the after window is the more useful half, so it is started first; the rest are skipped.
      const order = [
        { name: 'after', win: afterWin },
        { name: 'before', win: beforeWin },
      ] as const;
      const startable = Math.min(order.length, ctx.budget.remaining);
      const ran = await Promise.all(
        order
          .slice(0, startable)
          .map((w) => runWindow(ctx, account, args.entity_guid, w.win.sinceMs, w.win.untilMs)),
      );
      const outcomes = new Map<string, Outcome>();
      order.forEach((w, i) => {
        outcomes.set(w.name, ran[i] ?? { ok: false, note: 'Request budget exhausted.' });
      });
      const beforeO = outcomes.get('before') as Outcome;
      const afterO = outcomes.get('after') as Outcome;
      const notes: string[] = [];
      if (!beforeO.ok) notes.push(`Before window: ${beforeO.note}`);
      if (!afterO.ok) notes.push(`After window: ${afterO.note}`);
      const { metrics, overall } = compareWindows(
        beforeO.ok ? beforeO.stats : null,
        afterO.ok ? afterO.stats : null,
        minutes,
      );
      const partial = !beforeO.ok || !afterO.ok;
      if (afterMs < compareMs) {
        notes.push(
          `Only ${Math.round(minutes)} minutes have passed since the deployment, so both windows are ${Math.round(minutes)} minutes long.`,
        );
      }
      const windows = {
        minutes: Math.round(minutes * 100) / 100,
        before: {
          since: new Date(beforeWin.sinceMs).toISOString(),
          until: new Date(beforeWin.untilMs).toISOString(),
        },
        after: {
          since: new Date(afterWin.sinceMs).toISOString(),
          until: new Date(afterWin.untilMs).toISOString(),
        },
      };

      const lines = [
        `Deployment impact for the application (account ${account}), deployment at ${deployment.time}${deployment.recorded ? '' : ' (not recorded in change tracking; time as given)'}: ${windows.minutes} minutes before vs after.`,
        `Overall: ${overall.replaceAll('_', ' ')}.${partial ? ' Partial result: see notes.' : ''}`,
      ];
      for (const n of notes) lines.push(`Note: ${n}`);
      lines.push(
        shapeRows(
          metrics.map((m) => ({
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
      if (deployment.recorded) {
        lines.push(
          shapeRows(
            [
              {
                version: deployment.version ?? '',
                commit: deployment.commit ?? '',
                user: deployment.user ?? '',
                description: deployment.description ?? '',
                changelog: deployment.changelog ?? '',
                link: deployment.link ?? '',
              },
            ],
            { format: 'csv', source: 'New Relic change tracking', maxRows: 1, maxCellChars: MAX_TEXT_CHARS },
          ).text,
        );
      }
      lines.push(
        'This is an indication, not proof of cause: other changes or traffic shifts in the same period move these numbers too.',
      );
      return {
        text: lines.join('\n'),
        structured: {
          status: 'analyzed' as const,
          entity,
          deployment,
          windows,
          metrics,
          overall,
          partial,
          notes,
        },
      };
    },
  });

  return [listChangeEvents as ToolDefinition, analyze as ToolDefinition];
}
