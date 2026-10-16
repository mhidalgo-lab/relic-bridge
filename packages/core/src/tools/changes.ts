// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { ToolContext } from '../context.ts';
import { ErrorCode, RbError } from '../errors.ts';
import {
  CHANGE_EVENTS_QUERY,
  type ChangeEventData,
  type DeploymentData,
  ENTITIES_DEPLOYMENTS_QUERY,
  ENTITY_DEPLOYMENTS_QUERY,
} from '../nerdgraph/change-tracking.ts';
import { ENTITY_SEARCH_QUERY } from '../nerdgraph/entities.ts';
import { decodeEntityGuid } from '../nerdgraph/entity-guid.ts';
import { entityQuery } from '../nerdgraph/entity-query.ts';
import { type NrqlComplete, runNrql } from '../nrql/engine.ts';
import { type NrqlQuery, nrql } from '../nrql/template.ts';
import { pickFields } from '../output/compact.ts';
import { shapeRows } from '../output/format.ts';
import { parseTimeRange } from '../time/range.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { checkGuid, guidAgrees, isNonNull, outOfScope, requireField } from './entities.ts';
import { accountFilter } from './entity-common.ts';
import { cleanName, errorNote, maskEmail } from './identity.ts';
import {
  bindingOf,
  listLimit,
  nextTimePosition,
  pageByTime,
  readTimeCursor,
  timeCursor,
  timeFetchSize,
} from './paging.ts';
import {
  accountInput,
  assertWindowWithinLimit,
  cursorInput,
  label,
  NRQL_COST,
  num,
  singleAccount,
  startableNrql,
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
/** APM applications whose deployments account scope reads (two batched requests of 25). */
const APM_APP_BUDGET = 50;
const ENTITIES_BATCH = 25;
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
/** Fewest extra (or missing) errors, against the before rate, for an error rate change to count (with |z| >= 3). */
export const ERROR_MIN_DELTA = 5;
/** Latency moves smaller than this many seconds count as noise, whatever the ratio. */
export const LATENCY_MIN_DELTA_S = 0.005;
/** |z| of the throughput (Poisson) test that counts as a real shift. */
export const THROUGHPUT_Z = 3;
/** |z| of the latency test (Welch on averages; approximate for p95) that counts as a real change. */
export const LATENCY_Z = 3;
/** A control comparison explains a change when it moved the same way by at least this fraction of it. */
export const BASELINE_EXPLAINS = 0.5;
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
    .describe('Only change events of this entity (guid). Implies its account.'),
  time_range: timeRangeInput(DEFAULT_WINDOW),
  limit: listLimit('events, newest first', DEFAULT_LIMIT, MAX_LIMIT),
  cursor: cursorInput,
  account: accountInput,
  minimal_output: z
    .boolean()
    .optional()
    .describe('Only id, time, type, entity, version and a short description.'),
});

const listOutput = z.object({
  accountId: z.number().int(),
  since: z.string(),
  until: z.string(),
  scope: z.enum(['account', 'entity_deployments']),
  events: z.array(z.record(z.string(), z.unknown())),
  /** Older events in the window exist: pass this as cursor (same filters) to read them. */
  nextCursor: z.string().nullable(),
  hiddenOutsideScope: z.boolean(),
  /** Limits of this answer (for example more APM applications than were checked). */
  notes: z.array(z.string()),
});

const LIST_DESCRIPTION = `List change events, newest first: deployments, feature flag and configuration changes and other change-tracking markers, with time, type, user, entity, description and, for deployments, version, commit, changelog and link.

Use it for "what changed before things broke?". With an entity (guid or name) it lists that entity's changes; without one, the account's change events plus deployments of up to 50 APM applications (beyond that, see notes; use entity_guid). Older events: page with cursor (keeps the first window). To judge whether a deployment hurt use analyze_deployment_impact. It cannot record a change. ${UNTRUSTED}`;

/** NerdGraph leaves `type` null on some events: fall back to what `categoryAndType` ("DEPLOYMENT__BASIC") or `category` say. */
function typeFromCategory(e: ChangeEventData): string | null {
  const split = typeof e.categoryAndType === 'string' ? e.categoryAndType.split('__') : [];
  const fromPair = split.length > 1 ? split.slice(1).join('__') : '';
  return label(fromPair !== '' ? fromPair : e.category) ?? (e.version != null ? 'DEPLOYMENT' : null);
}

function eventRow(e: ChangeEventData, entityGuid: string | null) {
  return {
    id: cleanName(e.changeTrackingId ?? '', 128),
    time: instant(e.timestamp),
    category: label(e.category),
    type: label(e.type) ?? typeFromCategory(e),
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
    type: label(d.deploymentType) ?? 'DEPLOYMENT',
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
/** The same change reported by the feed and by deployment search is shown once. */
const dedupeKey = (r: EventRow): string =>
  r.id !== '' ? `${r.entityGuid ?? ''}|${r.id}` : `${r.entityGuid ?? ''}|${r.time}|${r.version ?? ''}`;
const MINIMAL_FIELDS = ['id', 'time', 'type', 'entityGuid', 'version', 'shortDescription'] as const;

// ---------------------------------------------------------------------------------------------------------------------
// analyze_deployment_impact
// ---------------------------------------------------------------------------------------------------------------------

export const BASELINES = ['previous_window', 'same_window_1d_ago', 'same_window_7d_ago'] as const;
export type Baseline = (typeof BASELINES)[number];
const BASELINE_OFFSET_MS: Record<Baseline, number> = {
  previous_window: 0,
  same_window_1d_ago: 86_400_000,
  same_window_7d_ago: 7 * 86_400_000,
};
export const baselineOffsetMs = (b: Baseline): number => BASELINE_OFFSET_MS[b];

/** Shared `baseline` input of the tools that compare windows. */
export const baselineField: z.ZodOptional<z.ZodType<Baseline>> = z
  .enum(BASELINES)
  .optional()
  .describe(
    'Control for traffic swings: previous_window (none) or the same windows 1 or 7 days earlier (2 more queries). After a big throughput shift the default is 7d or 1d.',
  );

/** The baseline that was applied, as reported. */
export const baselineOut: z.ZodType<BaselineOut> = z.object({
  /** What ran: previous_window means no control comparison. */
  used: z.enum(BASELINES),
  /** Chosen by the automatic rule (no baseline input). */
  automatic: z.boolean(),
  reason: z.string(),
});
export interface BaselineOut {
  used: Baseline;
  automatic: boolean;
  reason: string;
}

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
  baseline: baselineField,
});

export const VERDICTS = [
  'worse',
  'better',
  'similar',
  'changed',
  'warning',
  'inconclusive',
  'not_run',
] as const;
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
  /** The control that was applied (null when nothing was compared). */
  baseline: baselineOut.nullable(),
  /** A window was not queried (budget) or failed. */
  partial: z.boolean(),
  notes: z.array(z.string()),
});

const ANALYZE_DESCRIPTION = `Compare an APM application's throughput, error rate and response time in equal windows before and after a deployment, with a verdict per metric (worse, better, similar, changed, inconclusive) and an overall call.

Takes the application (guid or name). Uses its latest deployment of the last 7 days (see list_change_events) unless deployment_time is given, e.g. for an unrecorded rollout. Windows default to 30 minutes each, shorter for a recent deployment. Runs about 3 requests (+2 for a baseline control); a stopped window leaves the other (partial). Changes need |z| >= 3 and a minimum delta; notes name the rule. With a large throughput shift the same windows 1 day earlier act as a control (see baseline). An indication, not proof (traffic and other changes also move these numbers); verdicts need at least ${MIN_SAMPLES} transactions per window. APM applications only. Without a deployment, compare with the previous window using analyze_transactions. ${UNTRUSTED}`;

export interface WindowStats {
  /** Transactions counted. */
  readonly requests: number | null;
  /** Percentage (0-100). */
  readonly errorRate: number | null;
  readonly avgDuration: number | null;
  readonly p95Duration: number | null;
  /** Standard deviation of duration (seconds); absent = no latency z-score. */
  readonly stdDuration?: number | null;
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
    stdDuration: numberOf(r['stdDuration']),
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

/** Standard error of a 95th percentile under a normal approximation: sigma * sqrt(.95 * .05) / (phi(1.645) * sqrt(n)). */
const P95_SE_FACTOR = 2.113;

/**
 * Welch z of a latency change. `kind` average compares means; p95 uses the normal-approximation standard error of the
 * percentile (a rough spread). Null when the standard deviation or sample size is missing. Pure.
 */
export function latencyZ(kind: 'avg' | 'p95', before: WindowStats, after: WindowStats): number | null {
  const { requests: n1, stdDuration: s1 } = before;
  const { requests: n2, stdDuration: s2 } = after;
  const [b, a] =
    kind === 'avg' ? [before.avgDuration, after.avgDuration] : [before.p95Duration, after.p95Duration];
  if (n1 == null || n2 == null || s1 == null || s2 == null || b === null || a === null) return null;
  if (n1 <= 0 || n2 <= 0) return null;
  const k = kind === 'avg' ? 1 : P95_SE_FACTOR;
  const se = k * Math.sqrt((s1 * s1) / n1 + (s2 * s2) / n2);
  return se === 0 ? (a === b ? 0 : Math.sign(a - b) * Infinity) : (a - b) / se;
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

/** The same pair of windows one or seven days earlier: what a change looks like with no deployment. */
export interface ControlWindows {
  readonly before: WindowStats | null;
  readonly after: WindowStats | null;
  /** For notes, e.g. "same windows 1 day earlier". */
  readonly label: string;
}

const CHANGED = new Set<Verdict>(['worse', 'better', 'changed']);

/** A change the control comparison shows too (same direction, at least half the size) is a warning. Pure. */
function explainByControl(m: MetricOut, c: MetricOut, label: string): MetricOut {
  if (!CHANGED.has(m.verdict) || m.delta === null) return m;
  if (!CHANGED.has(c.verdict) || c.delta === null) {
    return c.verdict === 'inconclusive' || c.verdict === 'not_run'
      ? { ...m, note: `${m.note ?? ''} Baseline (${label}) could not judge it.`.trim() }
      : { ...m, note: `${m.note ?? ''} Not seen in the baseline (${label}).`.trim() };
  }
  const same =
    Math.sign(c.delta) === Math.sign(m.delta) && Math.abs(c.delta) >= BASELINE_EXPLAINS * Math.abs(m.delta);
  if (!same) return { ...m, note: `${m.note ?? ''} Not seen in the baseline (${label}).`.trim() };
  const shown =
    c.changeRatio === null ? '' : ` (${c.changeRatio >= 0 ? '+' : ''}${(c.changeRatio * 100).toFixed(0)}%)`;
  return {
    ...m,
    verdict: 'warning',
    note: `Warning, not a regression: the same move${shown} appears in the baseline (${label}), so it is likely a normal swing.`,
  };
}

/**
 * Compare two windows. Pure: no clock, no I/O. `before`/`after` null = that window was not evaluated.
 * Verdicts need MIN_SAMPLES transactions in both windows (except throughput, which is the sample size itself).
 */
export function compareWindows(
  before: WindowStats | null,
  after: WindowStats | null,
  minutes: number,
  control: ControlWindows | null = null,
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
  // Equal-length windows: the difference of two Poisson counts has z = (n2 - n1) / sqrt(n1 + n2).
  const n1 = before.requests ?? 0;
  const n2 = after.requests ?? 0;
  const tputZ = n1 + n2 === 0 ? 0 : (n2 - n1) / Math.sqrt(n1 + n2);
  const tputBig = tputChange !== null && Math.abs(tputChange) > THROUGHPUT_BAND;
  const tputChanged = tputBig && Math.abs(tputZ) >= THROUGHPUT_Z;
  const tput = metric(
    'throughput',
    'requests/min',
    tput0,
    tput1,
    tputChange === null ? 'inconclusive' : tputChanged ? 'changed' : 'similar',
    tputChange === null
      ? 'No traffic in the before window.'
      : tputChanged
        ? `Rule: beyond the ${THROUGHPUT_BAND * 100}% band and |z| >= ${THROUGHPUT_Z} (z = ${tputZ.toFixed(1)}).`
        : tputBig
          ? `Beyond the ${THROUGHPUT_BAND * 100}% band but |z| = ${Math.abs(tputZ).toFixed(1)} < ${THROUGHPUT_Z}: too few requests to call it.`
          : null,
  );

  let errVerdict: Verdict = 'inconclusive';
  let errNote: string | null = few;
  if (enough && before.errorRate !== null && after.errorRate !== null) {
    const z = errorRateZ(before, after);
    const pp = after.errorRate - before.errorRate;
    // Errors beyond (or short of) what the before rate predicts for the after window.
    const extra = ((after.errorRate - before.errorRate) / 100) * (after.requests ?? 0);
    if (z === null) errVerdict = 'similar';
    else if (Math.abs(z) < ERROR_RATE_Z) {
      errVerdict = 'similar';
      errNote = `Rule: |z| = ${Math.abs(z).toFixed(1)} < ${ERROR_RATE_Z}.`;
    } else if (Math.abs(extra) < ERROR_MIN_DELTA) {
      errVerdict = 'similar';
      errNote = `|z| = ${Math.abs(z).toFixed(1)} >= ${ERROR_RATE_Z} but only ${Math.abs(extra).toFixed(1)} errors more or fewer than expected (minimum ${ERROR_MIN_DELTA}).`;
    } else {
      errVerdict = pp > 0 ? 'worse' : 'better';
      errNote = `Rule: |z| = ${Math.abs(z).toFixed(1)} >= ${ERROR_RATE_Z} and ${Math.abs(extra).toFixed(0)} errors ${pp > 0 ? 'more' : 'fewer'} than expected (minimum ${ERROR_MIN_DELTA}).`;
    }
  }
  const err = metric('error_rate', 'percent', before.errorRate, after.errorRate, errVerdict, errNote);

  const latency = (name: string, b: number | null, a: number | null, z: number | null) => {
    if (!enough || b === null || a === null) return metric(name, 'seconds', b, a, 'inconclusive', few);
    const r = ratio(b, a);
    if (r === null) return metric(name, 'seconds', b, a, 'inconclusive', 'No baseline latency.');
    if (Math.abs(r) <= LATENCY_BAND)
      return metric(name, 'seconds', b, a, 'similar', `Rule: within the ${LATENCY_BAND * 100}% band.`);
    if (Math.abs(a - b) < LATENCY_MIN_DELTA_S)
      return metric(
        name,
        'seconds',
        b,
        a,
        'similar',
        `Beyond the ${LATENCY_BAND * 100}% band but under ${LATENCY_MIN_DELTA_S * 1000} ms.`,
      );
    if (z === null)
      return metric(
        name,
        'seconds',
        b,
        a,
        r > 0 ? 'worse' : 'better',
        `Rule: beyond the ${LATENCY_BAND * 100}% band and at least ${LATENCY_MIN_DELTA_S * 1000} ms (no spread data for a z-score).`,
      );
    if (Math.abs(z) < LATENCY_Z)
      return metric(
        name,
        'seconds',
        b,
        a,
        'similar',
        `Beyond the ${LATENCY_BAND * 100}% band but |z| = ${Math.abs(z).toFixed(1)} < ${LATENCY_Z}: within normal variation.`,
      );
    return metric(
      name,
      'seconds',
      b,
      a,
      r > 0 ? 'worse' : 'better',
      `Rule: beyond the ${LATENCY_BAND * 100}% band, at least ${LATENCY_MIN_DELTA_S * 1000} ms and |z| = ${Number.isFinite(z) ? Math.abs(z).toFixed(1) : '>100'} >= ${LATENCY_Z}.`,
    );
  };
  const avg = latency(
    'avg_response_time',
    before.avgDuration,
    after.avgDuration,
    latencyZ('avg', before, after),
  );
  const p95 = latency(
    'p95_response_time',
    before.p95Duration,
    after.p95Duration,
    latencyZ('p95', before, after),
  );

  let metrics = [tput, err, avg, p95];
  if (control) {
    const ctl = compareWindows(control.before, control.after, minutes).metrics;
    metrics = metrics.map((m, i) => explainByControl(m, ctl[i] as MetricOut, control.label));
  }
  const judged = metrics.slice(1);
  const overall = judged.some((m) => m.verdict === 'worse')
    ? 'regression_suspected'
    : judged.every((m) => m.verdict === 'inconclusive')
      ? 'inconclusive'
      : judged.some((m) => m.verdict === 'better')
        ? 'improvement'
        : 'no_significant_change';
  return { metrics, overall };
}

const DAY_MS = 86_400_000;
type Span = { sinceMs: number; untilMs: number };
const isWeekendDay = (ms: number): boolean => [0, 6].includes(new Date(ms).getUTCDay());

/** A seasonal (weekly) control fits when the analysed window is a day or more, or touches both weekday and weekend (UTC). */
const wantsWeekly = (windows: readonly Span[]): boolean =>
  windows.some(
    (w) =>
      w.untilMs - w.sinceMs >= DAY_MS ||
      isWeekendDay(w.sinceMs) !== isWeekendDay(Math.max(w.sinceMs, w.untilMs - 1)),
  );

/** What the automatic rule needs to aim for a weekly control: the analysed windows and the lookback limit. */
export interface BaselinePlan {
  windows: readonly Span[];
  limits: { maxWindowDays: number };
  now: number;
}

/**
 * Which baseline to apply after the first comparison. An explicit request wins; otherwise, when throughput shifted a
 * lot between the windows (a traffic trough or peak can fake a regression), the automatic rule picks the same windows
 * 7 days earlier for a window of 24 h or more or one crossing a weekend boundary, if the connection's lookback limit
 * allows it (the limit is never relaxed); else `same_window_1d_ago`, saying which `maxWindowDays` a weekly control
 * would need. Otherwise `previous_window` (no control). Pure.
 */
export function chooseBaseline(
  requested: Baseline | undefined,
  first: readonly MetricOut[],
  plan?: BaselinePlan,
): BaselineOut {
  if (requested !== undefined) {
    return { used: requested, automatic: false, reason: 'Requested in the baseline input.' };
  }
  const tput = first.find((m) => m.metric === 'throughput');
  if (tput?.verdict === 'changed') {
    const pctText = tput.changeRatio === null ? '' : ` (${(tput.changeRatio * 100).toFixed(0)}%)`;
    const shifted = `Throughput shifted a lot between the windows${pctText}`;
    if (plan && wantsWeekly(plan.windows)) {
      const fits = plan.windows.every((w) => controlRange('same_window_7d_ago', w, plan.limits, plan.now));
      if (fits) {
        return {
          used: 'same_window_7d_ago',
          automatic: true,
          reason: `${shifted}, and the window spans a day or a weekend boundary, so the same windows 7 days earlier act as a control.`,
        };
      }
      const needed = Math.max(
        ...plan.windows.map((w) =>
          Math.max(
            Math.ceil((plan.now - w.sinceMs) / DAY_MS) + 7,
            Math.ceil((w.untilMs - w.sinceMs) / DAY_MS),
          ),
        ),
      );
      return {
        used: 'same_window_1d_ago',
        automatic: true,
        reason: `${shifted}. A weekly control suits this window but needs maxWindowDays of at least ${needed} (this connection allows ${plan.limits.maxWindowDays}), so the same windows one day earlier act as a control.`,
      };
    }
    return {
      used: 'same_window_1d_ago',
      automatic: true,
      reason: `${shifted}, so the same windows one day earlier act as a control.`,
    };
  }
  return {
    used: 'previous_window',
    automatic: true,
    reason: 'No large throughput shift between the windows.',
  };
}

/** Control windows as epoch ms, or null when the baseline is previous_window or reaches past the window limit. */
export function controlRange(
  baseline: Baseline,
  win: { sinceMs: number; untilMs: number },
  limits: { maxWindowDays: number },
  now: number,
): { sinceMs: number; untilMs: number } | null {
  const off = baselineOffsetMs(baseline);
  if (off === 0) return null;
  const range = { sinceMs: win.sinceMs - off, untilMs: win.untilMs - off };
  try {
    assertWindowWithinLimit({ windowMs: range.untilMs - range.sinceMs, sinceMs: range.sinceMs }, limits, now);
  } catch {
    return null;
  }
  return range;
}

/**
 * An explicit `same_window_7d_ago` whose control reaches past the lookback limit falls back to the best control that
 * fits (`same_window_1d_ago`); the reported `used` and `reason` say what was requested and what ran. The limit is never
 * relaxed. When no seasonal control fits, `used` is `previous_window`. Pure; returns the baseline unchanged otherwise.
 */
export function fitBaseline(
  baseline: BaselineOut,
  windows: readonly Span[],
  limits: { maxWindowDays: number },
  now: number,
): { baseline: BaselineOut; note: string | null } {
  const fits = (b: Baseline) => windows.every((w) => controlRange(b, w, limits, now));
  if (baseline.used !== 'same_window_7d_ago' || baseline.automatic || fits('same_window_7d_ago')) {
    return { baseline, note: null };
  }
  const used: Baseline = fits('same_window_1d_ago') ? 'same_window_1d_ago' : 'previous_window';
  const outside = `The ${controlLabel('same_window_7d_ago')} fall outside this connection's window limit`;
  return {
    baseline: {
      used,
      automatic: false,
      reason:
        used === 'previous_window'
          ? 'Requested same_window_7d_ago is outside the lookback limit and no other control fits; no control was run.'
          : `Requested same_window_7d_ago is outside the lookback limit; used ${used}.`,
    },
    note:
      used === 'previous_window'
        ? `${outside}: no control was run.`
        : `${outside}: the ${controlLabel(used)} act as the control.`,
  };
}

export const controlLabel = (b: Baseline): string =>
  b === 'same_window_7d_ago' ? 'same windows 7 days earlier' : 'same windows 1 day earlier';

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
  return nrql`SELECT count(*) AS requests, percentage(count(*), WHERE error IS true) AS errorRate, average(duration) AS avgDuration, percentile(duration, 95) AS p95Duration, stddev(duration) AS stdDuration FROM Transaction WHERE entityGuid = ${guid} SINCE ${since} UNTIL ${until}`;
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

  /** Deployments of the account's APM applications (account scope). Every guid is checked against the account (T3). */
  async function apmDeployments(
    ctx: ToolContext,
    account: number,
    fetchSize: number,
    sinceMs: number,
    untilMs: number,
    notes: string[],
  ): Promise<{ rows: EventRow[]; full: boolean }> {
    const query = entityQuery.and([
      accountFilter([account]),
      entityQuery`domain = ${'APM'}`,
      entityQuery`type = ${'APPLICATION'}`,
    ]);
    const search = await client(ctx).query(ENTITY_SEARCH_QUERY, {
      query: query.text,
      cursor: null,
      options: { limit: APM_APP_BUDGET },
    });
    const es = requireField(search.data.actor.entitySearch, search, ctx);
    const apps = (es.results?.entities ?? [])
      .filter(isNonNull)
      .flatMap((e) =>
        typeof e.guid === 'string' && e.accountId === account && guidAgrees(e.guid, account)
          ? [{ guid: e.guid, name: typeof e.name === 'string' ? cleanName(e.name, 200) : null }]
          : [],
      );
    const total = typeof es.count === 'number' ? es.count : apps.length;
    if (total > apps.length || es.results?.nextCursor)
      notes.push(
        `Deployments of ${apps.length} of ${Math.max(total, apps.length)} APM applications are included; pass entity_guid for the others.`,
      );
    const rows: EventRow[] = [];
    let full = false;
    const names = new Map(apps.map((a) => [a.guid, a.name]));
    for (let i = 0; i < apps.length; i += ENTITIES_BATCH) {
      const guids = apps.slice(i, i + ENTITIES_BATCH).map((a) => a.guid);
      const result = await client(ctx).query(ENTITIES_DEPLOYMENTS_QUERY, {
        guids,
        filter: { limit: fetchSize, timeWindow: { startTime: sinceMs, endTime: untilMs } },
      });
      for (const entity of (result.data.actor.entities ?? []).filter(isNonNull)) {
        const guid = entity.guid;
        if (typeof guid !== 'string' || !names.has(guid)) continue;
        const results = (entity.deploymentSearch?.results ?? []).filter(isNonNull);
        if (results.length >= fetchSize) full = true;
        for (const d of results) {
          if (d.entityGuid != null && d.entityGuid !== guid) continue;
          rows.push(deploymentRow({ ...d, entityGuid: guid }, names.get(guid) ?? null));
        }
      }
    }
    return { rows, full };
  }

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
      assertWindowWithinLimit(range, ctx.limits, ctx.clock.now());

      // A cursor keeps the window of the first call and the instant the last page ended at; the window is checked
      // against the limits again, and nothing else (account, entity) is ever taken from a cursor (T3).
      const position = async (account: number, entityGuid: string | undefined) => {
        const binding = await bindingOf('list_change_events', account, entityGuid);
        const pos = args.cursor === undefined ? null : readTimeCursor(binding, args.cursor);
        const sinceMs = pos?.s ?? range.sinceMs;
        const untilMs = pos === null ? range.untilMs : pos.t + 1;
        if (pos !== null)
          assertWindowWithinLimit({ windowMs: untilMs - sinceMs, sinceMs }, ctx.limits, ctx.clock.now());
        return { binding, pos, sinceMs, untilMs };
      };

      let account: number;
      let rows: EventRow[];
      let hiddenOutsideScope = false;
      const notes: string[] = [];
      let upstreamFull: boolean;
      let scope: 'account' | 'entity_deployments';
      let at: Awaited<ReturnType<typeof position>>;

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
        at = await position(account, guid);
        const fetchSize = timeFetchSize(limit, at.pos);
        const result = await client(ctx).query(ENTITY_DEPLOYMENTS_QUERY, {
          guid: guid,
          filter: { limit: fetchSize, timeWindow: { startTime: at.sinceMs, endTime: at.untilMs } },
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
        upstreamFull = all.length >= fetchSize;

        // Other change-tracking events of the entity (feature flags, config changes, markers made by
        // create_change_event) are not deployments (NEW-21): read the account feed and keep this entity's.
        try {
          const feed = await client(ctx).query(CHANGE_EVENTS_QUERY, {
            filter: {
              accountIds: [account],
              limit: fetchSize,
              timeWindow: { startTime: at.sinceMs, endTime: at.untilMs },
            },
          });
          const events = (feed.data.actor.changeTracking?.changeTrackingSearch?.changeEvents ?? []).filter(
            isNonNull,
          );
          const seen = new Set(rows.map(dedupeKey));
          for (const e of events) {
            if (e.entity?.guid !== guid) continue;
            const r = eventRow(e, guid);
            const k = dedupeKey(r);
            if (!seen.has(k)) {
              seen.add(k);
              rows.push(r);
            }
          }
          // The feed has more events than were read: the entity's own may be among the rest.
          if (events.length >= fetchSize) upstreamFull = true;
        } catch (e) {
          if (!(e instanceof RbError) || e.code === ErrorCode.AuthForbidden) throw e;
          notes.push(
            `Other change events of the entity could not be read. ${errorNote(e)} Only deployments are shown.`,
          );
        }
      } else {
        account = singleAccount(ctx, args.account);
        scope = 'account';
        at = await position(account, undefined);
        const fetchSize = timeFetchSize(limit, at.pos);
        const result = await client(ctx).query(CHANGE_EVENTS_QUERY, {
          filter: {
            accountIds: [account],
            limit: fetchSize,
            timeWindow: { startTime: at.sinceMs, endTime: at.untilMs },
          },
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
        upstreamFull = all.length >= fetchSize;

        // Deployments recorded through the APM deployment API are missing from the account-wide feed (BUG-09): read
        // them per APM application, within a fixed request budget. A failure here leaves the feed's events in place.
        try {
          const apm = await apmDeployments(ctx, account, fetchSize, at.sinceMs, at.untilMs, notes);
          const seen = new Set(rows.map(dedupeKey));
          for (const r of apm.rows) {
            const k = dedupeKey(r);
            if (!seen.has(k)) {
              seen.add(k);
              rows.push(r);
            }
          }
          if (apm.full) upstreamFull = true;
        } catch (e) {
          if (!(e instanceof RbError) || e.code === ErrorCode.AuthForbidden) throw e;
          notes.push(
            `APM deployments could not be read. ${errorNote(e)} Only the account change feed is shown.`,
          );
        }
      }
      const paged = pageByTime(
        rows.sort(newestFirst),
        (r) => {
          const t = r.time === null ? Number.NaN : Date.parse(r.time);
          return Number.isFinite(t) ? t : null;
        },
        at.pos,
        limit,
        upstreamFull,
      );
      rows = paged.items;
      const next = paged.more ? nextTimePosition(paged.times, at.pos, at.sinceMs) : null;
      const nextCursor = next === null ? null : timeCursor(at.binding, next);
      const events = args.minimal_output
        ? pickFields(rows, MINIMAL_FIELDS)
        : (rows as Record<string, unknown>[]);

      const since = at.pos === null ? range.since : new Date(at.sinceMs).toISOString();
      const until = at.pos === null ? range.until : new Date(at.untilMs).toISOString();
      const lines = [
        `${rows.length} change event${rows.length === 1 ? '' : 's'} ${scope === 'entity_deployments' ? '(of the entity) ' : ''}in account ${account}, ${since} to ${until} (UTC), newest first.`,
      ];
      if (hiddenOutsideScope) lines.push("Note: events outside this connection's accounts were left out.");
      for (const n of notes) lines.push(`Note: ${n}`);
      if (nextCursor)
        lines.push(
          'Older events exist: call again with the same filters and cursor set to the nextCursor below.',
        );
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
      if (nextCursor) lines.push(`nextCursor: ${nextCursor}`);
      return {
        text: lines.join('\n'),
        structured: {
          accountId: account,
          since,
          until,
          scope,
          events,
          nextCursor,
          hiddenOutsideScope,
          notes,
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
      return { ok: false, note: errorNote(e) };
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
    // One deployments lookup plus one NRQL for each of the two windows.
    cost: 1 + 4 * NRQL_COST,
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
        assertWindowWithinLimit(lookback, ctx.limits, ctx.clock.now());
        search = { startTime: lookback.sinceMs, endTime: lookback.untilMs };
      }
      assertWindowWithinLimit(
        { windowMs: 2 * compareMs, sinceMs: explicitAt ?? search.startTime },
        ctx.limits,
        now,
      );

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

      const base = { entity, metrics: [] as MetricOut[], overall: null, baseline: null, partial: false };
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
      const startable = startableNrql(order.length, ctx.budget.remaining);
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
      const beforeStats = beforeO.ok ? beforeO.stats : null;
      const afterStats = afterO.ok ? afterO.stats : null;
      let { metrics, overall } = compareWindows(beforeStats, afterStats, minutes);
      let partial = !beforeO.ok || !afterO.ok;
      let baseline: BaselineOut | null = null;
      if (beforeStats && afterStats) {
        baseline = chooseBaseline(args.baseline, metrics, {
          windows: [beforeWin, afterWin],
          limits: ctx.limits,
          now,
        });
        const fitted = fitBaseline(baseline, [beforeWin, afterWin], ctx.limits, now);
        baseline = fitted.baseline;
        if (fitted.note) notes.push(fitted.note);
        const cb = controlRange(baseline.used, beforeWin, ctx.limits, now);
        const ca = controlRange(baseline.used, afterWin, ctx.limits, now);
        if (baseline.used !== 'previous_window' && (!cb || !ca)) {
          notes.push(
            `The ${controlLabel(baseline.used)} fall outside this connection's window limit: no control was run.`,
          );
          baseline = { ...baseline, used: 'previous_window' };
        } else if (cb && ca) {
          if (startableNrql(2, ctx.budget.remaining) < 2) {
            notes.push('Request budget too low for the baseline control: no control was run.');
            baseline = { ...baseline, used: 'previous_window' };
            partial = true;
          } else {
            const [cbO, caO] = await Promise.all([
              runWindow(ctx, account, args.entity_guid, cb.sinceMs, cb.untilMs),
              runWindow(ctx, account, args.entity_guid, ca.sinceMs, ca.untilMs),
            ]);
            if (cbO.ok && caO.ok) {
              ({ metrics, overall } = compareWindows(beforeStats, afterStats, minutes, {
                before: cbO.stats,
                after: caO.stats,
                label: controlLabel(baseline.used),
              }));
            } else {
              notes.push(`Baseline control (${controlLabel(baseline.used)}) failed: no control was applied.`);
              baseline = { ...baseline, used: 'previous_window' };
              partial = true;
            }
          }
        }
      }
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
      if (baseline) lines.push(`Baseline: ${baseline.used.replaceAll('_', ' ')}. ${baseline.reason}`);
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
          baseline,
          partial,
          notes,
        },
      };
    },
  });

  return [listChangeEvents as ToolDefinition, analyze as ToolDefinition];
}
