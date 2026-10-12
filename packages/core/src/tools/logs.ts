// SPDX-License-Identifier: Apache-2.0
// list_recent_logs, analyze_entity_logs. Log lines are the primary prompt-injection carrier (THREAT_MODEL T6): every
// message is scrubbed of secrets, single-lined, capped and shown only inside the untrusted-data envelope.
import { z } from 'zod';
import type { ToolContext } from '../context.ts';
import { ErrorCode, RbError } from '../errors.ts';
import { type NrqlComplete, runNrql } from '../nrql/engine.ts';
import { type NrqlQuery, nrql } from '../nrql/template.ts';
import { pickFields } from '../output/compact.ts';
import { shapeRows } from '../output/format.ts';
import { redact } from '../redact.ts';
import { parseTimeRange } from '../time/range.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { likePattern } from './apm.ts';
import { FATAL_CODES } from './changes.ts';
import { checkGuid } from './entities.ts';
import { cleanName, errorNote } from './identity.ts';
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

const DEFAULT_WINDOW = 'last 1 hour';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_MESSAGE_CHARS = 500;
const MAX_PATTERN_CHARS = 200;
/** Lines sampled for message patterns (NRQL's own LIMIT ceiling is 2000). */
const SAMPLE_LINES = 1000;
const MAX_PATTERNS = 10;
const BUCKETS = 24;
/** Characters of a raw message that are looked at at all: bounds regex work on hostile input. */
const MAX_RAW_CHARS = 4000;

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
type Level = (typeof LEVELS)[number];

/** Spellings seen in New Relic logs per level (NRQL equality is case-sensitive; unverified, see RESEARCH). */
const LEVEL_VARIANTS: Record<Level, readonly string[]> = {
  fatal: ['FATAL', 'fatal', 'Fatal', 'CRITICAL', 'critical', 'Critical'],
  error: ['ERROR', 'error', 'Error', 'ERR', 'err'],
  warn: ['WARN', 'warn', 'Warn', 'WARNING', 'warning', 'Warning'],
  info: ['INFO', 'info', 'Info'],
  debug: ['DEBUG', 'debug', 'Debug'],
  trace: ['TRACE', 'trace', 'Trace'],
};

const RANGE_FIELD = timeRangeInput(DEFAULT_WINDOW);
const LEVEL_FIELD = z
  .enum(LEVELS)
  .optional()
  .describe('Only lines of this level (case variants such as ERROR/error are matched).');

// ---------------------------------------------------------------------------------------------------------------------
// Scrubbing and pattern normalisation (pure)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A log message made safe to show: only the first characters are examined, secrets are redacted (the central patterns) BEFORE the cut so a secret can't be split by it, then single-lined and capped.
 */
export function cleanLogMessage(raw: string, max: number = MAX_MESSAGE_CHARS): string {
  const text = raw.slice(0, MAX_RAW_CHARS);
  return cleanName(redact(text), max);
}

const NORMALISERS: readonly [RegExp, string][] = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>'],
  [/\b0x[0-9a-f]+\b/gi, '<hex>'],
  [/\b[0-9a-f]{12,}\b/gi, '<hex>'],
  [/\b[A-Za-z0-9_-]{24,}\b/g, '<id>'],
  [/\d+(?:\.\d+)?/g, '<n>'],
];

/** Message pattern: a scrubbed message with ids, numbers, times and addresses replaced by placeholders. Pure. */
export function normaliseMessage(raw: string): string {
  let text = cleanLogMessage(raw, MAX_RAW_CHARS);
  for (const [re, replacement] of NORMALISERS) text = text.replace(re, replacement);
  return text.length > MAX_PATTERN_CHARS ? `${text.slice(0, MAX_PATTERN_CHARS - 1)}…` : text;
}

export interface MessagePattern {
  readonly pattern: string;
  readonly count: number;
  /** One scrubbed example line. */
  readonly example: string;
}

/** Groups messages by normalised pattern, most frequent first. Pure. */
export function topPatterns(messages: readonly string[], max: number = MAX_PATTERNS): MessagePattern[] {
  const groups = new Map<string, { count: number; example: string }>();
  for (const m of messages) {
    if (m.trim() === '') continue;
    const pattern = normaliseMessage(m);
    const g = groups.get(pattern);
    if (g) g.count += 1;
    else groups.set(pattern, { count: 1, example: cleanLogMessage(m, MAX_PATTERN_CHARS) });
  }
  return [...groups]
    .map(([pattern, g]) => ({ pattern, ...g }))
    .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern))
    .slice(0, max);
}

export interface Bucket {
  readonly begin: number;
  readonly end: number;
  readonly count: number;
}

export interface Spike extends Bucket {
  /** count divided by the median bucket (null when the median is 0). */
  readonly ratio: number | null;
}

const SPIKE_MIN_BUCKETS = 6;
const SPIKE_MIN_COUNT = 10;
const SPIKE_FACTOR = 3;

/** Buckets far above the median: at least 10 lines and 3 times the median. At most 3, largest first. Pure. */
export function findSpikes(buckets: readonly Bucket[]): Spike[] {
  if (buckets.length < SPIKE_MIN_BUCKETS) return [];
  const sorted = buckets.map((b) => b.count).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const threshold = Math.max(SPIKE_MIN_COUNT, SPIKE_FACTOR * median);
  return buckets
    .filter((b) => b.count >= threshold)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((b) => ({ ...b, ratio: median === 0 ? null : Number((b.count / median).toFixed(1)) }))
    .sort((a, b) => a.begin - b.begin);
}

// ---------------------------------------------------------------------------------------------------------------------
// NRQL builders. Every user value is a template value; fixed words come from closed sets (T4).
// ---------------------------------------------------------------------------------------------------------------------

const scope = (guid: string | undefined): NrqlQuery =>
  guid === undefined ? nrql`` : nrql`AND ${nrql.identifier('entity.guid')} = ${guid}`;
const levelFilter = (level: Level | undefined): NrqlQuery =>
  level === undefined ? nrql`` : nrql`AND level IN ${[...LEVEL_VARIANTS[level]]}`;
const bounds = (sinceMs: number, untilMs: number) => ({
  since: Math.floor(sinceMs / 1000),
  until: Math.ceil(untilMs / 1000),
});

export function recentQuery(
  guid: string | undefined,
  level: Level | undefined,
  pattern: string | undefined,
  limit: number,
  sinceMs: number,
  untilMs: number,
  /** Page cursor: only lines at or before this instant (epoch ms). */
  atOrBeforeMs?: number,
): NrqlQuery {
  const { since, until } = bounds(sinceMs, untilMs);
  const contains = pattern === undefined ? nrql`` : nrql`AND message LIKE ${pattern}`;
  const upTo = atOrBeforeMs === undefined ? nrql`` : nrql`AND timestamp <= ${atOrBeforeMs}`;
  return nrql`SELECT timestamp, level, message FROM Log WHERE timestamp IS NOT NULL ${scope(guid)} ${levelFilter(level)} ${contains} ${upTo} ORDER BY timestamp DESC LIMIT ${limit} SINCE ${since} UNTIL ${until}`;
}

export function levelCountQuery(guid: string, sinceMs: number, untilMs: number): NrqlQuery {
  const { since, until } = bounds(sinceMs, untilMs);
  return nrql`SELECT count(*) AS lines FROM Log WHERE timestamp IS NOT NULL ${scope(guid)} FACET level LIMIT 20 SINCE ${since} UNTIL ${until}`;
}

export function sampleQuery(
  guid: string,
  level: Level | undefined,
  sinceMs: number,
  untilMs: number,
): NrqlQuery {
  const { since, until } = bounds(sinceMs, untilMs);
  return nrql`SELECT message FROM Log WHERE timestamp IS NOT NULL ${scope(guid)} ${levelFilter(level)} ORDER BY timestamp DESC LIMIT ${SAMPLE_LINES} SINCE ${since} UNTIL ${until}`;
}

export function seriesQuery(
  guid: string,
  level: Level | undefined,
  bucketSeconds: number,
  sinceMs: number,
  untilMs: number,
): NrqlQuery {
  const { since, until } = bounds(sinceMs, untilMs);
  return nrql`SELECT count(*) AS lines FROM Log WHERE timestamp IS NOT NULL ${scope(guid)} ${levelFilter(level)} TIMESERIES ${bucketSeconds} seconds SINCE ${since} UNTIL ${until}`;
}

/** Bucket length: about 24 buckets, whole minutes. */
export const bucketSecondsFor = (windowMs: number): number =>
  Math.max(60, Math.ceil(windowMs / 1000 / BUCKETS / 60) * 60);

// ---------------------------------------------------------------------------------------------------------------------
// list_recent_logs
// ---------------------------------------------------------------------------------------------------------------------

const GUID_OPTIONAL = z
  .string()
  .min(1)
  .max(256)
  .optional()
  .describe('Only logs of this entity (guid; its account is queried). Omit for the account-wide logs.');

const listInput = z.strictObject({
  entity_guid: GUID_OPTIONAL,
  account: accountInput,
  level: LEVEL_FIELD,
  contains: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Only lines whose message contains this text (matched literally, case as typed).'),
  time_range: RANGE_FIELD,
  limit: listLimit('lines, newest first', DEFAULT_LIMIT, MAX_LIMIT),
  cursor: cursorInput,
  minimal_output: z.boolean().optional().describe('Only timestamp, level and message.'),
});

const logRow = z.object({
  timestamp: z.string().nullable(),
  level: z.string().nullable(),
  message: z.string(),
});

const listOutput = z.object({
  accountId: z.number().int(),
  entityGuid: z.string().nullable(),
  since: z.string(),
  until: z.string(),
  logs: z.array(logRow),
  /** Older lines in the window exist: pass this as cursor (same filters) to read them. */
  nextCursor: z.string().nullable(),
});

const LIST_DESCRIPTION = `Read the most recent log lines (newest first) of one account or one entity (guid or name), optionally only one level or lines containing some text. Default: the last hour, ${DEFAULT_LIMIT} lines, max ${MAX_LIMIT}; older lines: page with cursor (keeps the first window).

Use it to read what was logged around an incident. For counts by level, common message patterns and bursts use analyze_entity_logs; for the lines of one failing request use trace_error. There is no "lines around this error" mode: set a narrow time_range around the error's time instead. Messages are cut to ${MAX_MESSAGE_CHARS} characters and scrubbed of credential-like strings, but may still hold personal data. ${UNTRUSTED}`;

// ---------------------------------------------------------------------------------------------------------------------
// analyze_entity_logs
// ---------------------------------------------------------------------------------------------------------------------

const analyzeInput = z.strictObject({
  entity_guid: z
    .string()
    .min(1)
    .max(256)
    .describe('The entity whose logs to analyse (guid from search_entities). Its account is queried.'),
  level: LEVEL_FIELD.describe(
    'Restrict message patterns and bursts to this level. Level counts always cover all.',
  ),
  time_range: RANGE_FIELD,
});

const analyzeOutput = z.object({
  accountId: z.number().int(),
  entityGuid: z.string(),
  since: z.string(),
  until: z.string(),
  total: z.number().nullable(),
  levels: z.array(z.object({ level: z.string(), count: z.number() })),
  patterns: z.array(z.object({ pattern: z.string(), count: z.number(), example: z.string() })),
  /** Lines the patterns are based on (the newest in the window, at most 1000). */
  sampledLines: z.number().nullable(),
  bucketMinutes: z.number().nullable(),
  spikes: z.array(
    z.object({ begin: z.string(), end: z.string(), count: z.number(), ratio: z.number().nullable() }),
  ),
  /** A part was not queried (budget) or failed. */
  partial: z.boolean(),
  notes: z.array(z.string()),
});

const ANALYZE_DESCRIPTION = `Summarise an entity's logs (guid or name): line counts by level, the most common message patterns (numbers, ids, times and addresses replaced by placeholders, so similar lines group together) and bursts (time buckets far above the usual rate).

Runs 3 requests; a stopped part leaves the others (partial). Patterns come from the newest ${SAMPLE_LINES} lines of the window, so for a busy entity narrow time_range or set level. To read actual lines use list_recent_logs. Messages are cut and scrubbed of credential-like strings, but may still hold personal data. ${UNTRUSTED}`;

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

function messageOf(row: Record<string, unknown>): string {
  const m = row['message'];
  return typeof m === 'string' ? m : '';
}

/** `list_recent_logs` and `analyze_entity_logs` (read-only, Log events). */
export function createLogTools(deps: ToolDeps = {}): ToolDefinition[] {
  const client = toolClient(deps);

  const run = (ctx: ToolContext, account: number, query: NrqlQuery) =>
    runNrql(
      ctx,
      { nrql: query, accounts: [account], mode: 'auto', maxPolls: 1 },
      { client: client(ctx), ...(deps.sleep ? { sleep: deps.sleep } : {}) },
    );

  const complete = (outcome: Awaited<ReturnType<typeof run>>): NrqlComplete => {
    if (outcome.status === 'pending') {
      throw new RbError(ErrorCode.NerdGraphTimeout, 'The query is still running at New Relic.', {
        hint: 'Try again shortly, or use a shorter time_range.',
      });
    }
    return outcome;
  };

  const list = defineTool({
    name: 'list_recent_logs',
    title: 'List recent logs',
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
      const range = parseTimeRange(args.time_range ?? DEFAULT_WINDOW, ctx.clock.now());
      assertWindowWithinLimit(range, ctx.limits, ctx.clock.now());
      const limit = args.limit ?? DEFAULT_LIMIT;
      const pattern = args.contains === undefined ? undefined : likePattern(args.contains);

      // A cursor keeps the window of the first call and the instant the last page ended at; the window is checked
      // against the limits again, and nothing else (account, entity, filters) is ever taken from a cursor (T3).
      const binding = await bindingOf(
        'list_recent_logs',
        account,
        args.entity_guid,
        args.level,
        args.contains,
      );
      const pos = args.cursor === undefined ? null : readTimeCursor(binding, args.cursor);
      const sinceMs = pos?.s ?? range.sinceMs;
      const untilMs = pos === null ? range.untilMs : pos.t + 1;
      if (pos !== null)
        assertWindowWithinLimit({ windowMs: untilMs - sinceMs, sinceMs }, ctx.limits, ctx.clock.now());
      const fetchSize = timeFetchSize(limit, pos);

      const done = complete(
        await run(
          ctx,
          account,
          recentQuery(args.entity_guid, args.level, pattern, fetchSize, sinceMs, untilMs, pos?.t),
        ),
      );
      const paged = pageByTime(
        done.results,
        (r) => num(r['timestamp']),
        pos,
        limit,
        done.results.length >= fetchSize,
      );
      const next = paged.more ? nextTimePosition(paged.times, pos, sinceMs) : null;
      const nextCursor = next === null ? null : timeCursor(binding, next);
      const since = pos === null ? range.since : new Date(sinceMs).toISOString();
      const until = pos === null ? range.until : new Date(untilMs).toISOString();
      const shown = paged.items.map((r) => {
        const ts = num(r['timestamp']);
        return {
          timestamp: ts === null ? null : new Date(ts).toISOString(),
          level: (() => {
            const l = r['level'];
            return typeof l === 'string' ? label(l) : null;
          })(),
          message: cleanLogMessage(messageOf(r)),
        };
      });
      const logs = args.minimal_output
        ? (pickFields(shown, ['timestamp', 'level', 'message']) as typeof shown)
        : shown;

      const lines = [
        `${shown.length} log line${shown.length === 1 ? '' : 's'}${args.entity_guid ? ' of the entity' : ''} in account ${account}, ${since} to ${until} (UTC), newest first.`,
      ];
      if (nextCursor)
        lines.push(
          'Older lines exist: call again with the same filters and cursor set to the nextCursor below.',
        );
      if (shown.length === 0)
        lines.push('No log lines found. Check the window, the filters and that the entity sends logs.');
      else
        lines.push(
          shapeRows(
            shown.map((r) => ({ time: r.timestamp ?? '', level: r.level ?? '', message: r.message })),
            { format: 'csv', source: 'New Relic Log data', maxRows: MAX_LIMIT },
          ).text,
        );
      if (nextCursor) lines.push(`nextCursor: ${nextCursor}`);
      return {
        text: lines.join('\n'),
        structured: {
          accountId: account,
          entityGuid: args.entity_guid ?? null,
          since,
          until,
          logs,
          nextCursor,
        },
      };
    },
  });

  type Part<T> = { ok: true; value: T } | { ok: false; note: string };

  async function part<T>(
    ctx: ToolContext,
    account: number,
    query: NrqlQuery,
    read: (rows: Record<string, unknown>[]) => T,
  ): Promise<Part<T>> {
    try {
      const outcome = await run(ctx, account, query);
      if (outcome.status === 'pending')
        return { ok: false, note: 'Still running at New Relic; try again shortly.' };
      return { ok: true, value: read(outcome.results as Record<string, unknown>[]) };
    } catch (e) {
      // Credential, authorization and connection-limit errors (e.g. Log not allowed) hit every part alike.
      if (!(e instanceof RbError) || FATAL_CODES.has(e.code) || e.code === ErrorCode.LimitQuery) throw e;
      if (e.code === ErrorCode.BudgetExhausted) return { ok: false, note: 'Request budget exhausted.' };
      return { ok: false, note: errorNote(e) };
    }
  }

  const analyze = defineTool({
    name: 'analyze_entity_logs',
    title: 'Analyze entity logs',
    description: ANALYZE_DESCRIPTION,
    inputSchema: analyzeInput,
    outputSchema: analyzeOutput,
    kind: 'read',
    openWorld: true,
    // Level counts, a message sample and a time series (one NRQL each).
    cost: 3 * NRQL_COST,
    group: 'performance',
    phase: 6,
    handler: async (args, ctx) => {
      const decoded = checkGuid(ctx, args.entity_guid);
      const account = singleAccount(ctx, decoded.accountId);
      const range = parseTimeRange(args.time_range ?? DEFAULT_WINDOW, ctx.clock.now());
      assertWindowWithinLimit(range, ctx.limits, ctx.clock.now());
      const bucketSeconds = bucketSecondsFor(range.windowMs);
      const guid = args.entity_guid;

      // Budget-aware, most useful first: level counts, then patterns, then bursts.
      const startable = startableNrql(3, ctx.budget.remaining);
      const jobs: Array<() => Promise<unknown>> = [
        () =>
          part(ctx, account, levelCountQuery(guid, range.sinceMs, range.untilMs), (rows) => {
            const byLevel = new Map<string, number>();
            for (const r of rows) {
              const facet = Array.isArray(r['facet']) ? r['facet'][0] : (r['facet'] ?? r['level']);
              const count = num(r['lines']);
              if (count === null) continue;
              const key = typeof facet === 'string' ? (label(facet)?.toLowerCase() ?? 'other') : 'unknown';
              byLevel.set(key, (byLevel.get(key) ?? 0) + count);
            }
            return [...byLevel].map(([level, count]) => ({ level, count })).sort((a, b) => b.count - a.count);
          }),
        () =>
          part(ctx, account, sampleQuery(guid, args.level, range.sinceMs, range.untilMs), (rows) => ({
            lines: rows.length,
            patterns: topPatterns(rows.map(messageOf)),
          })),
        () =>
          part(
            ctx,
            account,
            seriesQuery(guid, args.level, bucketSeconds, range.sinceMs, range.untilMs),
            (rows) =>
              rows.flatMap((r): Bucket[] => {
                const begin = num(r['beginTimeSeconds']);
                const end = num(r['endTimeSeconds']);
                const count = num(r['lines']);
                return begin === null || end === null || count === null ? [] : [{ begin, end, count }];
              }),
          ),
      ];
      const ran = await Promise.all(jobs.slice(0, startable).map((j) => j()));
      const skipped = { ok: false, note: 'Request budget exhausted.' } as const;
      const levelsPart = (ran[0] ?? skipped) as Part<{ level: string; count: number }[]>;
      const patternsPart = (ran[1] ?? skipped) as Part<{ lines: number; patterns: MessagePattern[] }>;
      const seriesPart = (ran[2] ?? skipped) as Part<Bucket[]>;

      const notes: string[] = [];
      if (!levelsPart.ok) notes.push(`Level counts: ${levelsPart.note}`);
      if (!patternsPart.ok) notes.push(`Message patterns: ${patternsPart.note}`);
      if (!seriesPart.ok) notes.push(`Bursts: ${seriesPart.note}`);
      const partial = !levelsPart.ok || !patternsPart.ok || !seriesPart.ok;

      const levels = levelsPart.ok ? levelsPart.value : [];
      const total = levelsPart.ok ? levels.reduce((n, l) => n + l.count, 0) : null;
      const patterns = patternsPart.ok ? patternsPart.value.patterns : [];
      const sampledLines = patternsPart.ok ? patternsPart.value.lines : null;
      const spikes = seriesPart.ok ? findSpikes(seriesPart.value) : [];
      if (levelsPart.ok && total === 0)
        notes.push('No log lines in the window. Check the guid, the window and that the entity sends logs.');
      if (sampledLines !== null && sampledLines >= SAMPLE_LINES)
        notes.push(`Patterns come from the newest ${SAMPLE_LINES} lines of the window only.`);

      const out = [
        `Logs of the entity in account ${account}, ${range.since} to ${range.until} (UTC)${args.level ? `, patterns and bursts for level ${args.level}` : ''}.${total === null ? '' : ` ${total} line${total === 1 ? '' : 's'} in total.`}${partial ? ' Partial result: see notes.' : ''}`,
      ];
      for (const n of notes) out.push(`Note: ${n}`);
      if (levels.length > 0)
        out.push(
          shapeRows(
            levels.map((l) => ({ level: l.level, lines: l.count })),
            { format: 'table', source: 'New Relic Log data', maxRows: 20 },
          ).text,
        );
      if (patterns.length > 0)
        out.push(
          shapeRows(
            patterns.map((p) => ({ count: p.count, pattern: p.pattern, example: p.example })),
            { format: 'table', source: 'New Relic Log data', maxRows: MAX_PATTERNS },
          ).text,
        );
      if (spikes.length > 0)
        out.push(
          `Bursts (${bucketSeconds / 60}-minute buckets at least ${SPIKE_FACTOR} times the median):`,
          shapeRows(
            spikes.map((s) => ({
              from: iso(s.begin),
              to: iso(s.end),
              lines: s.count,
              times_median: s.ratio ?? '',
            })),
            { format: 'table', source: 'New Relic Log data', maxRows: 3 },
          ).text,
        );
      else if (seriesPart.ok) out.push('No bursts found.');

      return {
        text: out.join('\n'),
        structured: {
          accountId: account,
          entityGuid: args.entity_guid,
          since: range.since,
          until: range.until,
          total,
          levels,
          patterns,
          sampledLines,
          bucketMinutes: seriesPart.ok ? bucketSeconds / 60 : null,
          spikes: spikes.map((s) => ({
            begin: iso(s.begin),
            end: iso(s.end),
            count: s.count,
            ratio: s.ratio,
          })),
          partial,
          notes,
        },
      };
    },
  });

  return [list as ToolDefinition, analyze as ToolDefinition];
}
