// SPDX-License-Identifier: Apache-2.0
import type { QueryLimits } from '../context.ts';
import { ErrorCode, RbError } from '../errors.ts';
import { type Token, tokenize } from './tokenize.ts';

/** What enforcement changed or found. `nrql` is what must be sent. */
export interface CheckedNrql {
  readonly nrql: string;
  /** Human-readable adjustments, e.g. "LIMIT 5000 lowered to 1000 (project limit)". */
  readonly notes: readonly string[];
  /** Event types named in FROM clauses (all depths). */
  readonly eventTypes: readonly string[];
  /** Upper bound of the time range the query can scan, in ms. */
  readonly windowMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** NRQL's default window when there is no SINCE. */
const DEFAULT_WINDOW_MS = HOUR;
/** NRQL's default row count for raw (non-aggregate) queries (measured: 10). Injected explicitly, capped by the limit. */
const DEFAULT_RAW_LIMIT = 10;

const UNITS: Readonly<Record<string, number>> = {
  SECOND: 1000,
  MINUTE,
  HOUR,
  DAY,
  WEEK: 7 * DAY,
  MONTH: 30 * DAY, // measured: SINCE 1 month ago = 720 h
  YEAR: 366 * DAY,
};

/** Conservative upper bounds (how far back a SINCE keyword can reach). */
const CALENDAR_SINCE: Readonly<Record<string, number>> = {
  TODAY: DAY,
  YESTERDAY: 2 * DAY,
  'THIS WEEK': 7 * DAY,
  'LAST WEEK': 14 * DAY,
  'THIS MONTH': 31 * DAY,
  'LAST MONTH': 62 * DAY,
  'THIS QUARTER': 92 * DAY,
  'LAST QUARTER': 184 * DAY,
  'THIS YEAR': 366 * DAY,
  'LAST YEAR': 731 * DAY,
};

/** Words that start a clause at the top level (they end the SELECT list or a FROM list). */
const CLAUSES = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'FACET',
  'SINCE',
  'UNTIL',
  'LIMIT',
  'OFFSET',
  'TIMESERIES',
  'COMPARE',
  'WITH',
  'ORDER',
  'SLIDE',
  'EXTRAPOLATE',
  'JOIN',
  'PREDICT',
  'RAW',
]);

function limitError(message: string, hint: string, details?: Record<string, unknown>): RbError {
  return new RbError(ErrorCode.LimitQuery, message, { hint, ...(details ? { details } : {}) });
}

const isWord = (t: Token | undefined, ...words: string[]) => t?.kind === 'word' && words.includes(t.value);

function unitMs(t: Token | undefined): number | undefined {
  if (t?.kind !== 'word') return undefined;
  const singular = t.value.endsWith('S') ? t.value.slice(0, -1) : t.value;
  return UNITS[singular];
}

interface TimePoint {
  /** How long ago, in ms (upper bound for SINCE, lower bound for UNTIL). */
  readonly agoMs: number;
}

const PLAIN_NUMBER_RE = /^\d+(\.\d+)?$/;
/**
 * NRQL reads bare epochs as seconds or milliseconds (both measured). Only unambiguous ranges are accepted:
 * seconds in [1e9, 1e10) and milliseconds in [1e12, 1e13), i.e. 2001–2286 either way.
 */
function epochMs(n: number): number | undefined {
  if (n >= 1e9 && n < 1e10) return n * 1000;
  if (n >= 1e12 && n < 1e13) return n;
  return undefined;
}
/** `WITH TIMEZONE` moves quoted dates by up to this much (UTC−12 … UTC+14). */
const TIMEZONE_SLACK_MS = 14 * HOUR;
/** Words that may follow an event type in a FROM list. */
const AFTER_FROM_ITEM = new Set([...CLAUSES, 'AS', 'ON', 'INNER', 'LEFT']);

const UNSUPPORTED_TIME =
  'Use a relative time (SINCE 3 hours ago), a calendar keyword (SINCE yesterday), epoch milliseconds or a quoted date.';

/** Parse the time expression after SINCE / UNTIL / COMPARE WITH. Fails closed: unknown forms are rejected. */
function parseTime(
  tokens: readonly Token[],
  i: number,
  now: number,
  role: 'since' | 'until' | 'compare',
  withTimezone: boolean,
): TimePoint {
  const a = tokens[i];
  const b = tokens[i + 1];
  const c = tokens[i + 2];
  if (a?.kind === 'number') {
    if (!PLAIN_NUMBER_RE.test(a.text)) throw limitError(`${a.text} is not a plain number.`, UNSUPPORTED_TIME);
    const n = Number(a.text);
    const unit = unitMs(b);
    if (unit !== undefined) {
      if (!isWord(c, 'AGO'))
        throw limitError('Relative times need AGO (e.g. SINCE 3 hours ago).', UNSUPPORTED_TIME);
      return { agoMs: n * unit };
    }
    if (role === 'compare') throw limitError('COMPARE WITH needs a relative time.', UNSUPPORTED_TIME);
    const ms = epochMs(n);
    if (ms === undefined) {
      throw limitError(`${a.text} is not an epoch timestamp in seconds or milliseconds.`, UNSUPPORTED_TIME);
    }
    return { agoMs: Math.max(0, now - ms) };
  }
  if (a?.kind === 'string' && role !== 'compare') {
    const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(a.value) ? a.value : `${a.value.replace(' ', 'T')}Z`;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) throw limitError(`Could not read the date ${a.text}.`, UNSUPPORTED_TIME);
    // Zone-less dates are UTC (measured), unless WITH TIMEZONE shifts them: then widen the window conservatively.
    const slack = withTimezone ? (role === 'since' ? TIMEZONE_SLACK_MS : -TIMEZONE_SLACK_MS) : 0;
    return { agoMs: Math.max(0, now - ms + slack) };
  }
  if (isWord(a, 'NOW') && role === 'until') return { agoMs: 0 };
  if (a?.kind === 'word' && role !== 'compare') {
    const two = b?.kind === 'word' ? `${a.value} ${b.value}` : '';
    const key = CALENDAR_SINCE[two] !== undefined ? two : a.value;
    const bound = CALENDAR_SINCE[key];
    // For UNTIL, a calendar keyword can mean "now" at the latest: 0 is the conservative lower bound.
    if (bound !== undefined) return { agoMs: role === 'since' ? bound : 0 };
  }
  throw limitError(`Could not read the time range after ${role.toUpperCase()}.`, UNSUPPORTED_TIME);
}

function findFromLists(tokens: readonly Token[]): { eventTypes: string[]; unresolved: boolean } {
  const eventTypes: string[] = [];
  let unresolved = false;
  tokens.forEach((t, i) => {
    if (!isWord(t, 'FROM')) return;
    let j = i + 1;
    if (tokens[j]?.text === '(') return; // subquery: its own FROM is visited separately
    for (;;) {
      const item = tokens[j];
      const isName = item && (item.kind === 'ident' || (item.kind === 'word' && !CLAUSES.has(item.value)));
      if (!isName || tokens[j + 1]?.text === '(') {
        unresolved = true; // e.g. lookup(...) or something we don't understand
        return;
      }
      eventTypes.push(item.kind === 'ident' ? item.value : item.text);
      const after = tokens[j + 1];
      if (after?.text === ',') {
        j += 2;
        continue;
      }
      // Anything else glued to the name (`Log-Archive`, `Log:x`) means we don't know the real event type.
      if (after && after.text !== ')' && !(after.kind === 'word' && AFTER_FROM_ITEM.has(after.value))) {
        unresolved = true;
      }
      return;
    }
  });
  return { eventTypes, unresolved };
}

function checkEventTypes(tokens: readonly Token[], limits: QueryLimits): string[] {
  const { eventTypes, unresolved } = findFromLists(tokens);
  // Event types are case-sensitive (measured). Allow lists match exactly; deny lists ignore case and surrounding
  // spaces, so near-miss spellings are blocked too (conservative both ways).
  const allow = limits.eventTypes.allow;
  const deny = limits.eventTypes.deny?.map((e) => e.trim().toLowerCase());
  if (!allow && !deny) return eventTypes;
  if (unresolved) {
    throw limitError(
      'Could not determine every event type in FROM, and this project restricts event types.',
      'Name event types directly, separated by commas.',
    );
  }
  if (allow && eventTypes.length === 0) {
    throw limitError(
      'This connection only allows specific event types, and the query names none.',
      'Name an allowed event type in the query.',
      { allowed: limits.eventTypes.allow },
    );
  }
  for (const type of eventTypes) {
    if (deny?.includes(type.trim().toLowerCase()) || (allow && !allow.includes(type))) {
      throw limitError(
        `Event type ${type} is not allowed on this connection.`,
        'Query a different event type.',
        {
          eventType: type,
          ...(allow ? { allowed: limits.eventTypes.allow } : {}),
        },
      );
    }
  }
  return eventTypes;
}

/** Window of the top-level query: SINCE..UNTIL plus COMPARE WITH; subquery SINCEs are checked up to now. */
function checkWindow(tokens: readonly Token[], limits: QueryLimits, now: number): number {
  let since: number | undefined;
  let until = 0;
  let compare = 0;
  let widest = 0;
  const seen = new Set<string>();
  const once = (clause: string) => {
    if (seen.has(clause)) {
      throw limitError(`The query has more than one ${clause} clause.`, `Use a single ${clause}.`);
    }
    seen.add(clause);
  };
  const tz = tokens.some((t, i) => t.depth === 0 && isWord(t, 'WITH') && isWord(tokens[i + 1], 'TIMEZONE'));
  tokens.forEach((t, i) => {
    if (t.kind !== 'word') return;
    if (t.depth === 0 && (t.value === 'SINCE' || t.value === 'UNTIL')) once(t.value);
    if (t.depth === 0 && t.value === 'COMPARE') once('COMPARE WITH');
    if (t.value === 'SINCE') {
      const agoMs = parseTime(tokens, i + 1, now, 'since', tz).agoMs;
      if (t.depth === 0) since = Math.max(since ?? 0, agoMs);
      else widest = Math.max(widest, agoMs);
    } else if (t.value === 'UNTIL' && t.depth === 0) {
      until = parseTime(tokens, i + 1, now, 'until', tz).agoMs;
    } else if (t.value === 'COMPARE' && isWord(tokens[i + 1], 'WITH') && t.depth === 0) {
      compare = parseTime(tokens, i + 2, now, 'compare', tz).agoMs;
    }
  });
  const top = Math.max(0, (since ?? DEFAULT_WINDOW_MS) - until) + compare;
  const windowMs = Math.max(top, widest);
  const maxMs = limits.maxWindowDays * DAY;
  if (windowMs > maxMs) {
    const days = Math.round((windowMs / DAY) * 10) / 10;
    throw limitError(
      `The query covers about ${days} days; this connection allows up to ${limits.maxWindowDays}.`,
      `Use a shorter SINCE (e.g. SINCE ${limits.maxWindowDays} days ago), or split the range into several queries.`,
      { windowDays: days, maxWindowDays: limits.maxWindowDays },
    );
  }
  return windowMs;
}

/** Top-level SELECT list contains a function call → aggregate (or at least not a raw event dump). */
function isAggregate(tokens: readonly Token[]): boolean | undefined {
  const s = tokens.findIndex((t) => t.depth === 0 && isWord(t, 'SELECT'));
  if (s === -1) return undefined;
  for (let i = s + 1; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.depth === 0 && t.kind === 'word' && CLAUSES.has(t.value)) break;
    if (t.kind === 'word' && tokens[i + 1]?.text === '(') return true;
  }
  return false;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function checkLimit(tokens: readonly Token[], limits: QueryLimits, source: string, notes: string[]): Edit[] {
  const edits: Edit[] = [];
  let topLevel = 0;
  tokens.forEach((t, i) => {
    if (!isWord(t, 'LIMIT')) return;
    if (t.depth === 0 && ++topLevel > 1) {
      throw limitError('The query has more than one LIMIT clause.', 'Use a single LIMIT.');
    }
    const v = tokens[i + 1];
    const after = tokens[i + 2];
    if (after && after.text !== ')' && !(after.kind === 'word' && CLAUSES.has(after.value))) {
      throw limitError('LIMIT must be followed by a number or MAX.', 'e.g. LIMIT 10.');
    }
    if (v?.kind === 'number' && /^\d+$/.test(v.text)) {
      const n = Number(v.text);
      if (n > limits.maxLimit) {
        edits.push({ start: v.start, end: v.end, text: String(limits.maxLimit) });
        notes.push(`LIMIT ${v.text} lowered to ${limits.maxLimit} (connection limit).`);
      }
    } else if (v?.kind === 'word' && v.value === 'MAX') {
      edits.push({ start: v.start, end: v.end, text: String(limits.maxLimit) });
      notes.push(`LIMIT MAX replaced with ${limits.maxLimit} (connection limit).`);
    } else {
      throw limitError('LIMIT must be followed by a whole number or MAX.', 'e.g. LIMIT 10.');
    }
  });
  if (topLevel > 0) return edits;
  const facet = tokens.some((t) => t.depth === 0 && isWord(t, 'FACET'));
  if (!facet && isAggregate(tokens) === false) {
    const n = Math.min(DEFAULT_RAW_LIMIT, limits.maxLimit);
    // NRQL wants LIMIT before OFFSET; otherwise append it.
    const offset = tokens.find((t) => t.depth === 0 && isWord(t, 'OFFSET'));
    const at = offset?.start ?? source.length;
    edits.push({ start: at, end: at, text: offset ? `LIMIT ${n} ` : ` LIMIT ${n}` });
    notes.push(`LIMIT ${n} added (raw event query without LIMIT).`);
  }
  return edits;
}

/**
 * Enforce a connection's query limits on NRQL (THREAT_MODEL T5). Throws RB_LIMIT_QUERY with an actionable hint, or
 * returns the (possibly rewritten) NRQL. Best effort by design: see docs/guide/query-limits.md for known gaps.
 */
export function enforceQueryLimits(source: string, limits: QueryLimits, now: number): CheckedNrql {
  const all = tokenize(source);
  // NRQL supports `--`, `//` and `/* */` comments exactly as the tokenizer reads them (measured, incl. `x--1`). They are
  // checked out and removed from what is sent, so New Relic receives precisely the text that was checked.
  const comments = all.filter((t) => t.kind === 'comment');
  const tokens = all.filter((t) => t.kind !== 'comment');
  if (tokens.length === 0) throw new RbError(ErrorCode.InputInvalid, 'The NRQL query is empty.');
  if (tokens.some((t) => t.kind === 'string' && t.text.startsWith('"'))) {
    throw new RbError(ErrorCode.InputInvalid, 'NRQL strings use single quotes.', {
      hint: "Replace \"…\" with '…' (escape a quote inside as \\').",
    });
  }
  const notes: string[] = [];
  const eventTypes = checkEventTypes(tokens, limits);
  const windowMs = checkWindow(tokens, limits, now);
  const edits = checkLimit(tokens, limits, source, notes);
  for (const c of comments) edits.push({ start: c.start, end: c.end, text: ' ' });
  if (comments.length > 0) notes.push('Comments removed before sending.');
  let nrql = source;
  for (const e of edits.sort((x, y) => y.start - x.start))
    nrql = nrql.slice(0, e.start) + e.text + nrql.slice(e.end);
  if (comments.length > 0) nrql = nrql.trim();
  return { nrql, notes, eventTypes, windowMs };
}

/** `run_nrql` (arbitrary NRQL) can be switched off per connection. */
export function assertRawNrqlAllowed(limits: QueryLimits): void {
  if (!limits.rawNrql) {
    throw new RbError(ErrorCode.ToolDisabled, 'Arbitrary NRQL is disabled on this connection.', {
      hint: 'Use the purpose-built tools (entities, golden metrics, logs) instead.',
    });
  }
}
