// SPDX-License-Identifier: Apache-2.0
// Compaction helpers shared by list tools: flat tags, field selection (`minimal_output`) and offset cursors.
import { ErrorCode, RbError } from '../errors.ts';

/** NerdGraph `EntityTag` shape. */
export interface TagGroup {
  readonly key: string;
  readonly values: readonly string[];
}

export type TagInput = readonly TagGroup[] | Readonly<Record<string, string | readonly string[]>>;

/**
 * Tags as `key:value` strings, one per value (`[{key:'env', values:['prod']}]` → `['env:prod']`). Several times
 * cheaper in tokens than the nested shape. Empty keys are skipped; duplicates removed; order kept.
 */
export function flattenTags(tags: TagInput | null | undefined): string[] {
  if (!tags) return [];
  const groups: [string, readonly string[]][] = Array.isArray(tags)
    ? (tags as readonly TagGroup[]).map((t) => [t.key, t.values ?? []])
    : Object.entries(tags as Record<string, string | readonly string[]>).map(([k, v]) => [
        k,
        typeof v === 'string' ? [v] : v,
      ]);
  const out = new Set<string>();
  for (const [key, values] of groups) {
    if (typeof key !== 'string' || key === '') continue;
    if (values.length === 0) out.add(key);
    for (const value of values) out.add(`${key}:${value}`);
  }
  return [...out];
}

/** Keep only `fields` (in that order) of each item: the `minimal_output` option of list tools. */
export function pickFields<T extends Record<string, unknown>>(
  items: readonly T[],
  fields: readonly string[],
): Record<string, unknown>[] {
  return items.map((item) =>
    Object.fromEntries(fields.filter((f) => Object.hasOwn(item, f)).map((f) => [f, item[f]])),
  );
}

const CURSOR_PREFIX = 'rb1:';
const CURSOR_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Largest offset a cursor may carry (well above any page we would serve). */
const MAX_CURSOR_OFFSET = 1_000_000;

const toBase64Url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Opaque cursor for offset pagination over a list we hold in memory. Not a secret and not bound to a query: it only
 * says where the next page starts. Cursors from NerdGraph (`nextCursor`) are passed through as they are.
 */
export function encodeCursor(offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_CURSOR_OFFSET) {
    throw new RbError(ErrorCode.Internal, 'Cursor offset out of range.');
  }
  return toBase64Url(`${CURSOR_PREFIX}${offset}`);
}

/** Read a cursor made by `encodeCursor`. Anything else → RB_INPUT_INVALID. */
export function decodeCursor(cursor: string): number {
  const invalid = () =>
    new RbError(ErrorCode.InputInvalid, 'The cursor is not valid.', {
      hint: 'Pass next_cursor exactly as returned by the previous call, or omit it to start over.',
    });
  if (typeof cursor !== 'string' || !CURSOR_RE.test(cursor)) throw invalid();
  let decoded: string;
  try {
    decoded = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    throw invalid();
  }
  const digits = decoded.startsWith(CURSOR_PREFIX) ? decoded.slice(CURSOR_PREFIX.length) : '';
  if (!/^(0|[1-9]\d{0,6})$/.test(digits)) throw invalid();
  const offset = Number(digits);
  if (offset > MAX_CURSOR_OFFSET) throw invalid();
  return offset;
}

export interface Page<T> {
  readonly items: T[];
  /** Present when more items follow. */
  readonly nextCursor?: string;
  readonly total: number;
}

/** One page of `items` starting at `cursor` (default: the beginning). */
export function paginate<T>(items: readonly T[], options: { cursor?: string; pageSize: number }): Page<T> {
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1) {
    throw new RbError(ErrorCode.InputInvalid, 'Page size must be a positive integer.');
  }
  const start = options.cursor === undefined ? 0 : decodeCursor(options.cursor);
  const end = start + options.pageSize;
  return {
    items: items.slice(start, end),
    ...(end < items.length ? { nextCursor: encodeCursor(end) } : {}),
    total: items.length,
  };
}
