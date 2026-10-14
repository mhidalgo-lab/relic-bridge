// SPDX-License-Identifier: Apache-2.0
// Cursors for lists whose upstream cannot take a page size, or cannot page at all (P6-24). Web-standard APIs only.
import { z } from 'zod';
import { ErrorCode, RbError } from '../errors.ts';

/**
 * A cursor we issue is `base64url(JSON)` of a small payload plus a binding: the first 24 hex digits of a SHA-256 over
 * the tool name, the account and every filter that shapes the list. It is checked again on use, so a cursor from
 * another tool, account or filter set is refused instead of being replayed (T3). The binding is not a secret: a caller
 * can compute one for any call it is allowed to make, and the account and filters are always taken from the call's
 * own arguments, never from the cursor, so a forged cursor can only choose where in the caller's own list to start.
 */
export type CursorPayload = Readonly<Record<string, string | number | null>>;

/** Longest cursor accepted from a caller. */
export const MAX_CURSOR_CHARS = 4096;
/** An upstream (NerdGraph) cursor is opaque base64-like text; anything else is not passed on or shown. */
const UPSTREAM_CURSOR_RE = /^[A-Za-z0-9+/=_.:-]{1,2048}$/;
/** Largest offset or count a cursor may carry: a page is at most a few hundred rows. */
const MAX_COUNTER = 100_000;
const MAX_INSTANT = 8.64e15;

export const upstreamCursorOf = (raw: unknown): string | null =>
  typeof raw === 'string' && UPSTREAM_CURSOR_RE.test(raw) ? raw : null;

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** What a cursor is bound to: the tool, the account and every filter of the list (not `limit`, `cursor`, formats). */
export async function bindingOf(
  tool: string,
  account: number,
  ...filters: readonly unknown[]
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([tool, account, ...filters.map((f) => f ?? null)]));
  return toHex(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 24);
}

function b64urlEncode(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text: string): string {
  const pad = '='.repeat((4 - (text.length % 4)) % 4);
  return atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

export function encodePageCursor(binding: string, payload: CursorPayload): string {
  return b64urlEncode(JSON.stringify({ v: 1, b: binding, ...payload }));
}

const badCursor = () =>
  new RbError(ErrorCode.InputInvalid, 'cursor is not valid for this call.', {
    hint: 'Pass the nextCursor of a previous call with exactly the same tool, account and filters, or omit cursor.',
  });

/** Decode and check a cursor: it must be one we issued for this binding. Returns its payload (without `v` and `b`). */
export function decodePageCursor(binding: string, raw: string): CursorPayload {
  let parsed: unknown;
  try {
    if (raw.length > MAX_CURSOR_CHARS || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('shape');
    parsed = JSON.parse(b64urlDecode(raw));
  } catch {
    throw badCursor();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw badCursor();
  const { v, b, ...rest } = parsed as Record<string, unknown>;
  if (v !== 1 || b !== binding) throw badCursor();
  for (const value of Object.values(rest)) {
    if (value !== null && typeof value !== 'string' && typeof value !== 'number') throw badCursor();
    // Instants are epoch ms: nothing beyond the largest Date, so `new Date(x).toISOString()` cannot throw.
    if (typeof value === 'number' && !(Number.isSafeInteger(value) && value >= 0 && value <= MAX_INSTANT))
      throw badCursor();
    if (typeof value === 'string' && !UPSTREAM_CURSOR_RE.test(value)) throw badCursor();
  }
  return rest as CursorPayload;
}

/** The `limit` input of a list tool: same name, bounds and wording everywhere. */
export function listLimit(what: string, defaultLimit: number, max: number): z.ZodOptional<z.ZodNumber> {
  return z.number().int().min(1).max(max).optional().describe(`Most ${what}, default ${defaultLimit}.`);
}

export interface UpstreamPage<T> {
  readonly items: readonly T[];
  /** The upstream cursor of the next page, as the API returned it (checked here). */
  readonly next: unknown;
}

/** A window of epoch milliseconds. */
export interface Window {
  readonly sinceMs: number;
  readonly untilMs: number;
}

/**
 * Page a list whose upstream takes a cursor but no page size. The cursor we return is the upstream cursor of the page
 * we read plus how many of its rows were already shown, so `limit` can be smaller than the upstream page. The offset
 * counts raw upstream rows, before any scope filtering, so it stays stable. For a list over a time window the cursor
 * also keeps the window of the first call (a relative window such as "last 6 hours" would otherwise slide between
 * calls and shift the offset); `check` must refuse a window the connection's limits do not allow.
 */
export async function pageUpstream<T>(opts: {
  readonly binding: string;
  readonly cursor: string | undefined;
  readonly limit: number;
  /** The window of this call; a cursor replaces it with the window of the call that issued the cursor. */
  readonly window?: Window;
  readonly checkWindow?: (window: Window) => void;
  readonly fetchPage: (upstream: string | null, window: Window | undefined) => Promise<UpstreamPage<T>>;
}): Promise<{
  items: T[];
  nextCursor: string | null;
  window: Window | undefined;
  /** Set when `limit` asked for more rows than one upstream page holds: the rows that page really has (first page only). */
  pageSize: number | null;
}> {
  let upstream: string | null = null;
  let offset = 0;
  let window = opts.window;
  if (opts.cursor !== undefined) {
    const p = decodePageCursor(opts.binding, opts.cursor);
    upstream = typeof p['u'] === 'string' ? p['u'] : null;
    offset = typeof p['o'] === 'number' && p['o'] <= MAX_COUNTER ? p['o'] : 0;
    if (opts.window !== undefined) {
      const { s, e } = p;
      if (typeof s !== 'number' || typeof e !== 'number' || s > e) throw badCursor();
      window = { sinceMs: s, untilMs: e };
      opts.checkWindow?.(window);
    }
  }
  const page = await opts.fetchPage(upstream, window);
  const items = page.items.slice(offset, offset + opts.limit);
  const next = upstreamCursorOf(page.next);
  const keep = window === undefined ? {} : { s: window.sinceMs, e: window.untilMs };
  const nextCursor =
    offset + opts.limit < page.items.length
      ? encodePageCursor(opts.binding, { u: upstream, o: offset + opts.limit, ...keep })
      : next !== null
        ? encodePageCursor(opts.binding, { u: next, o: 0, ...keep })
        : null;
  const pageSize = offset === 0 && next !== null && opts.limit > page.items.length ? page.items.length : null;
  return { items, nextCursor, window, pageSize };
}

/** The position of a newest-first list read by time: the last timestamp shown and how many rows already shown share it. */
export interface TimePosition {
  /** Epoch ms of the oldest row shown. */
  readonly t: number;
  /** Rows already shown with exactly that timestamp. */
  readonly k: number;
  /** Epoch ms where the window started, so it does not slide between calls. */
  readonly s: number;
  /** Epoch ms where the window ended (frozen like `s`); absent in cursors of lists that end at the cursor's instant. */
  readonly e?: number;
  /** Ids of the rows already shown at exactly `t` (a stable tiebreaker); absent when rows have no usable id. */
  readonly ids?: readonly string[];
}

/** Most ids a cursor carries; beyond that the count `k` is the tiebreaker. */
export const MAX_CURSOR_IDS = 40;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function readTimeCursor(binding: string, raw: string): TimePosition {
  const p = decodePageCursor(binding, raw);
  const { t, k, s, e, i } = p;
  if (typeof t !== 'number' || typeof k !== 'number' || typeof s !== 'number' || k > MAX_COUNTER || s > t)
    throw badCursor();
  if (e !== undefined && e !== null && (typeof e !== 'number' || e < t)) throw badCursor();
  let ids: string[] | undefined;
  if (typeof i === 'string') {
    ids = i.split('.');
    if (ids.length > MAX_CURSOR_IDS || !ids.every((x) => ID_RE.test(x))) throw badCursor();
  }
  return { t, k, s, ...(typeof e === 'number' ? { e } : {}), ...(ids ? { ids } : {}) };
}

export function timeCursor(binding: string, pos: TimePosition): string {
  return encodePageCursor(binding, {
    t: pos.t,
    k: pos.k,
    s: pos.s,
    ...(pos.e === undefined ? {} : { e: pos.e }),
    ...(pos.ids === undefined ? {} : { i: pos.ids.join('.') }),
  });
}

/**
 * Where the next page of a newest-first list starts, from the rows shown so far. `times` are the timestamps (epoch ms)
 * of every row of this page, newest first; `previous` is the position the page started from.
 */
export function nextTimePosition(
  times: readonly number[],
  previous: TimePosition | null,
  sinceMs: number,
  untilMs?: number,
  /** Row ids of this page, parallel to `times` (null: the row has none). */
  ids?: readonly (string | null)[],
): TimePosition | null {
  const last = times[times.length - 1];
  if (last === undefined) return null;
  const sameAsLast = times.filter((x) => x === last).length;
  // Every row of the page shares the timestamp the page started at: add to the rows already skipped.
  const carriedPrevious = previous !== null && previous.t === last;
  const carried = carriedPrevious ? previous.k : 0;
  const base = {
    t: last,
    k: carried + sameAsLast,
    s: sinceMs,
    ...(untilMs === undefined ? {} : { e: untilMs }),
  };
  if (ids === undefined) return base;
  // The ids shown at `last`: those of this page plus those carried over. Without an id for every row (or too many),
  // fall back to the count.
  const here = ids.filter((_, n) => times[n] === last);
  if (carriedPrevious && previous.ids === undefined) return base;
  const all = [...(carriedPrevious ? (previous.ids ?? []) : []), ...here];
  const usable =
    here.length === sameAsLast &&
    all.length <= MAX_CURSOR_IDS &&
    all.every((x): x is string => typeof x === 'string' && ID_RE.test(x));
  return usable ? { ...base, ids: all as string[] } : base;
}

/** Most rows one upstream request for a time-cursor list asks for (page + rows already shown at the cursor's instant). */
export const MAX_TIME_FETCH = 500;

/** How many rows to ask upstream for: the page, one more to know there is more, and the rows to skip at the cursor. */
export const timeFetchSize = (limit: number, pos: TimePosition | null): number =>
  Math.min(MAX_TIME_FETCH, limit + 1 + (pos?.k ?? 0));

/**
 * Cut one page out of rows read newest first. With a position, rows newer than it and the `k` rows already shown at
 * its instant are dropped (checked here, so an upstream window edge that is inclusive cannot repeat a row). `more` is
 * true when rows were left over or the upstream answer was full, so older rows may exist.
 */
export function pageByTime<T>(
  rows: readonly T[],
  tsOf: (row: T) => number | null,
  pos: TimePosition | null,
  limit: number,
  upstreamFull: boolean,
  /** Row id: with it and a position that carries ids, rows already shown are told apart by id, not by count. */
  idOf?: (row: T) => string | null,
): { items: T[]; times: number[]; ids: (string | null)[]; more: boolean } {
  let skip = pos?.k ?? 0;
  const shownIds = pos?.ids !== undefined && idOf !== undefined ? new Set(pos.ids) : null;
  const kept: { row: T; ts: number }[] = [];
  for (const row of rows) {
    const ts = tsOf(row);
    if (ts === null) {
      // No timestamp, no place in the order: shown on the first page only (New Relic rows always have one).
      if (pos === null) kept.push({ row, ts: Number.NaN });
      continue;
    }
    if (pos !== null) {
      if (ts > pos.t) continue;
      if (ts === pos.t && shownIds !== null) {
        const id = idOf?.(row) ?? null;
        if (id !== null && shownIds.has(id)) continue;
      } else if (ts === pos.t && skip > 0) {
        skip--;
        continue;
      }
    }
    kept.push({ row, ts });
  }
  const page = kept.slice(0, limit);
  return {
    items: page.map((p) => p.row),
    times: page.map((p) => p.ts).filter((t) => !Number.isNaN(t)),
    ids: page.filter((p) => !Number.isNaN(p.ts)).map((p) => idOf?.(p.row) ?? null),
    more: kept.length > limit || (upstreamFull && page.length > 0),
  };
}

/**
 * Page an in-memory list (cached or already fetched whole) with an offset cursor. The list must come out in the same
 * order on every call; a cursor is bound like the others, so it cannot be replayed on another account or filter set.
 */
export function pageList<T>(
  items: readonly T[],
  binding: string,
  cursor: string | undefined,
  limit: number,
): { items: T[]; nextCursor: string | null } {
  let offset = 0;
  if (cursor !== undefined) {
    const o = decodePageCursor(binding, cursor)['o'];
    if (typeof o !== 'number' || o > MAX_COUNTER) throw badCursor();
    offset = o;
  }
  const end = offset + limit;
  return {
    items: items.slice(offset, end),
    nextCursor: end < items.length ? encodePageCursor(binding, { o: end }) : null,
  };
}
