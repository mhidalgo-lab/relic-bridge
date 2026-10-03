// SPDX-License-Identifier: Apache-2.0
import { ErrorCode, RbError } from '../errors.ts';

/** A resolved time range. All instants are epoch milliseconds (UTC). */
export interface TimeRange {
  readonly sinceMs: number;
  readonly untilMs: number;
  readonly windowMs: number;
  /** ISO 8601 (UTC) forms of the bounds, for display. */
  readonly since: string;
  readonly until: string;
  /** Ready-to-append NRQL time clause. Built only from computed integers, never from the input text. */
  readonly clause: string;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Month length matches NRQL's own `SINCE 1 month ago` (measured: 720 h, see query limits). */
const UNIT_MS: Readonly<Record<string, number>> = {
  second: SECOND,
  minute: MINUTE,
  hour: HOUR,
  day: DAY,
  week: 7 * DAY,
  month: 30 * DAY,
};

const MAX_EXPRESSION_CHARS = 200;
const MAX_WINDOW_MS = 10 * 366 * DAY;
const MAX_COUNT = 100_000;

const RELATIVE_RE =
  /^(?:(?:last|past)\s+)?(?:(\d{1,6})\s+)?(second|minute|hour|day|week|month)s?(?:\s+ago)?$/;
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?\s*(z|[+-]\d{2}:?\d{2})?$/;
const RANGE_SPLIT_RES = [
  /^between\s+(.+?)\s+and\s+(.+)$/,
  /^(.+?)\s+(?:to|until|through)\s+(.+)$/,
  /^(\S+)\/(\S+)$/,
];

function bad(message: string, expression: string): RbError {
  return new RbError(ErrorCode.InputInvalid, message, {
    hint:
      'Use e.g. "last 2 hours", "past 30 minutes", "today", "yesterday", "this week", "previous week", "this month", ' +
      '"previous month", an ISO date/time ("2026-10-01T08:00:00Z"), or a range "2026-10-01 to 2026-10-02".',
    details: { expression: expression.slice(0, 80) },
  });
}

interface Instant {
  readonly ms: number;
  /** True when the text had no time of day. */
  readonly dateOnly: boolean;
}

function parseInstant(text: string, original: string): Instant {
  const m = ISO_RE.exec(text.trim());
  if (!m) throw bad(`Can't read "${text.slice(0, 40)}" as a date/time.`, original);
  const [, y, mo, d, h, mi, s, frac, tz] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = h === undefined ? 0 : Number(h);
  const minute = mi === undefined ? 0 : Number(mi);
  const second = s === undefined ? 0 : Number(s);
  const millis = frac === undefined ? 0 : Number(frac.padEnd(3, '0'));
  const local = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const check = new Date(local);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw bad(`"${text.slice(0, 40)}" is not a valid date/time.`, original);
  }
  let offsetMs = 0;
  if (tz !== undefined && tz !== 'z') {
    const sign = tz.startsWith('-') ? -1 : 1;
    const digits = tz.slice(1).replace(':', '');
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2, 4));
    if (oh > 23 || om > 59) throw bad(`"${text.slice(0, 40)}" has an invalid UTC offset.`, original);
    offsetMs = sign * (oh * HOUR + om * MINUTE);
  }
  return { ms: local - offsetMs, dateOnly: h === undefined };
}

function utcMidnight(ms: number): number {
  return ms - (((ms % DAY) + DAY) % DAY);
}

/** Monday 00:00 UTC of the week containing `ms`. */
function weekStart(ms: number): number {
  const midnight = utcMidnight(ms);
  const dow = new Date(midnight).getUTCDay(); // 0 = Sunday
  return midnight - ((dow + 6) % 7) * DAY;
}

function monthStart(ms: number, offsetMonths = 0): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offsetMonths, 1);
}

function build(sinceMs: number, untilMs: number, clause: string, original: string): TimeRange {
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs))
    throw bad('Time range out of bounds.', original);
  if (sinceMs >= untilMs) throw bad('The start of the range must be before its end.', original);
  if (untilMs - sinceMs > MAX_WINDOW_MS) throw bad('That range is longer than 10 years.', original);
  return Object.freeze({
    sinceMs,
    untilMs,
    windowMs: untilMs - sinceMs,
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
    clause,
  });
}

function absolute(sinceMs: number, untilMs: number, original: string): TimeRange {
  // NRQL takes epoch seconds: round outwards so the whole requested range is covered.
  const clause = `SINCE ${Math.floor(sinceMs / SECOND)} UNTIL ${Math.ceil(untilMs / SECOND)}`;
  return build(sinceMs, untilMs, clause, original);
}

/**
 * Turn a time expression into epoch milliseconds and an NRQL time clause. Pure: no I/O, `nowMs` is passed in.
 * Everything is UTC. Accepted forms (case-insensitive): "last 2 hours", "past 30 minutes", "last hour", "15 minutes
 * ago", "today", "yesterday", "this week" / "previous week" (weeks start Monday), "this month" / "previous month" (also
 * "last calendar week/month"; plain "last week" / "last month" are rolling 7 / 30 days), an ISO date or date-time
 * (a date-only value is midnight UTC; a date-only range end includes that whole day), "<start> to <end>",
 * "between <start> and <end>", "<start>/<end>", and "since <start>" (until now).
 */
export function parseTimeRange(expression: string, nowMs: number): TimeRange {
  if (expression.length > MAX_EXPRESSION_CHARS) throw bad('The time expression is too long.', expression);
  const text = expression.trim().toLowerCase().replace(/\s+/g, ' ');
  if (text === '') throw bad('The time expression is empty.', expression);

  const rel = RELATIVE_RE.exec(text);
  if (rel?.[2]) {
    const n = rel[1] === undefined ? 1 : Number(rel[1]);
    if (n < 1 || n > MAX_COUNT) throw bad('The count must be between 1 and 100000.', expression);
    const unit = rel[2];
    const sinceMs = nowMs - n * (UNIT_MS[unit] as number);
    return build(sinceMs, nowMs, `SINCE ${n} ${unit}${n === 1 ? '' : 's'} ago`, expression);
  }

  const today = utcMidnight(nowMs);
  switch (text) {
    case 'today':
      return absolute(today, nowMs, expression);
    case 'yesterday':
      return absolute(today - DAY, today, expression);
    case 'this week':
      return absolute(weekStart(nowMs), nowMs, expression);
    case 'previous week':
    case 'last calendar week':
      return absolute(weekStart(nowMs) - 7 * DAY, weekStart(nowMs), expression);
    case 'this month':
      return absolute(monthStart(nowMs), nowMs, expression);
    case 'previous month':
    case 'last calendar month':
      return absolute(monthStart(nowMs, -1), monthStart(nowMs), expression);
    default:
      break;
  }

  for (const re of RANGE_SPLIT_RES) {
    const m = re.exec(text);
    if (m?.[1] && m[2]) {
      const start = parseInstant(m[1], expression);
      const end = parseInstant(m[2], expression);
      return absolute(start.ms, end.dateOnly ? end.ms + DAY : end.ms, expression);
    }
  }

  const sinceOnly = /^since (.+)$/.exec(text);
  const single = parseInstant(sinceOnly?.[1] ?? text, expression);
  return absolute(single.ms, nowMs, expression);
}
