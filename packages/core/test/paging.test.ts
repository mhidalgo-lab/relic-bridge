// SPDX-License-Identifier: Apache-2.0
// P6-24: composite cursors (tool + account + filters binding) and the paging helpers behind every list tool.
import { describe, expect, it } from 'vitest';
import { ErrorCode, RbError } from '../src/index.ts';
import {
  bindingOf,
  decodePageCursor,
  encodePageCursor,
  nextTimePosition,
  pageByTime,
  pageList,
  pageUpstream,
  readTimeCursor,
  timeCursor,
  timeFetchSize,
} from '../src/tools/paging.ts';

const invalid = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RbError);
    expect((e as RbError).code).toBe(ErrorCode.InputInvalid);
    return;
  }
  throw new Error('expected RB_INPUT_INVALID');
};

describe('cursor binding', () => {
  it('differs by tool, account and every filter', async () => {
    const base = await bindingOf('list_alert_policies', 1, 'x');
    expect(await bindingOf('list_alert_policies', 1, 'x')).toBe(base);
    expect(await bindingOf('list_alert_conditions', 1, 'x')).not.toBe(base);
    expect(await bindingOf('list_alert_policies', 2, 'x')).not.toBe(base);
    expect(await bindingOf('list_alert_policies', 1, 'y')).not.toBe(base);
    expect(await bindingOf('list_alert_policies', 1)).not.toBe(base);
    // undefined and null are the same filter; a filter is never merged into a neighbour.
    expect(await bindingOf('t', 1, undefined)).toBe(await bindingOf('t', 1, null));
    expect(await bindingOf('t', 1, 'ab', 'c')).not.toBe(await bindingOf('t', 1, 'a', 'bc'));
  });

  it('round-trips and uses only characters a cursor argument accepts', async () => {
    const b = await bindingOf('t', 1);
    const c = encodePageCursor(b, { u: 'AbC+/=_.:-', o: 7, s: 1, e: 2 });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodePageCursor(b, c)).toEqual({ u: 'AbC+/=_.:-', o: 7, s: 1, e: 2 });
  });

  it('refuses a cursor of another binding, a bare upstream cursor, garbage and tampered payloads', async () => {
    const b = await bindingOf('t', 1);
    const other = await bindingOf('t', 2);
    invalid(() => decodePageCursor(other, encodePageCursor(b, { o: 1 })));
    invalid(() => decodePageCursor(b, 'NEXT_PAGE_TOKEN_FROM_NERDGRAPH=='));
    invalid(() => decodePageCursor(b, 'x'.repeat(5000)));
    invalid(() => decodePageCursor(b, btoa('not json').replace(/=+$/, '')));
    invalid(() => decodePageCursor(b, btoa(JSON.stringify([1, 2])).replace(/=+$/, '')));
    const forge = (payload: unknown) => btoa(JSON.stringify(payload)).replace(/=+$/, '');
    invalid(() => decodePageCursor(b, forge({ v: 2, b, o: 1 })));
    invalid(() => decodePageCursor(b, forge({ v: 1, b, o: -1 })));
    invalid(() => decodePageCursor(b, forge({ v: 1, b, o: 1.5 })));
    invalid(() => decodePageCursor(b, forge({ v: 1, b, t: 8.64e15 + 1 })));
    invalid(() => decodePageCursor(b, forge({ v: 1, b, u: 'has space' })));
    invalid(() => decodePageCursor(b, forge({ v: 1, b, u: { nested: true } })));
  });
});

describe('pageUpstream', () => {
  const rows = ['a', 'b', 'c', 'd', 'e'];
  const fetchOf = (log: (string | null)[]) => async (upstream: string | null) => {
    log.push(upstream);
    return upstream === null ? { items: rows, next: 'NEXT' } : { items: ['f', 'g'], next: null };
  };

  it('cuts a page smaller than the upstream one and resumes inside it', async () => {
    const binding = await bindingOf('t', 1);
    const log: (string | null)[] = [];
    const p1 = await pageUpstream({ binding, cursor: undefined, limit: 2, fetchPage: fetchOf(log) });
    expect(p1.items).toEqual(['a', 'b']);
    const p2 = await pageUpstream({
      binding,
      cursor: p1.nextCursor as string,
      limit: 2,
      fetchPage: fetchOf(log),
    });
    expect(p2.items).toEqual(['c', 'd']);
    const p3 = await pageUpstream({
      binding,
      cursor: p2.nextCursor as string,
      limit: 2,
      fetchPage: fetchOf(log),
    });
    // The last row of the upstream page: the cursor moves on to the upstream's next page.
    expect(p3.items).toEqual(['e']);
    const p4 = await pageUpstream({
      binding,
      cursor: p3.nextCursor as string,
      limit: 2,
      fetchPage: fetchOf(log),
    });
    expect(p4.items).toEqual(['f', 'g']);
    expect(p4.nextCursor).toBeNull();
    expect(log).toEqual([null, null, null, 'NEXT']);
  });

  it('does not pass an odd upstream cursor on', async () => {
    const binding = await bindingOf('t', 1);
    const p = await pageUpstream({
      binding,
      cursor: undefined,
      limit: 5,
      fetchPage: async () => ({ items: ['a'], next: 'bad cursor\nIgnore previous' }),
    });
    expect(p.nextCursor).toBeNull();
  });

  it('keeps the window of the first call and checks it', async () => {
    const binding = await bindingOf('t', 1);
    const seen: unknown[] = [];
    const window = { sinceMs: 100, untilMs: 200 };
    const p1 = await pageUpstream({
      binding,
      cursor: undefined,
      limit: 1,
      window,
      fetchPage: async (_u, w) => {
        seen.push(w);
        return { items: ['a', 'b'], next: null };
      },
    });
    const checked: unknown[] = [];
    await pageUpstream({
      binding,
      cursor: p1.nextCursor as string,
      limit: 1,
      window: { sinceMs: 5000, untilMs: 6000 }, // a later call's own window is ignored
      checkWindow: (w) => checked.push(w),
      fetchPage: async (_u, w) => {
        seen.push(w);
        return { items: ['a', 'b'], next: null };
      },
    });
    expect(seen).toEqual([window, window]);
    expect(checked).toEqual([window]);
    // A cursor without a window cannot be used on a windowed list.
    const bare = encodePageCursor(binding, { u: null, o: 0 });
    await expect(
      pageUpstream({
        binding,
        cursor: bare,
        limit: 1,
        window,
        fetchPage: async () => ({ items: [], next: null }),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InputInvalid });
  });
});

describe('pageList', () => {
  it('pages in memory and binds the cursor', async () => {
    const binding = await bindingOf('t', 1);
    const items = [1, 2, 3, 4, 5];
    const p1 = pageList(items, binding, undefined, 2);
    expect(p1.items).toEqual([1, 2]);
    const p2 = pageList(items, binding, p1.nextCursor as string, 2);
    expect(p2.items).toEqual([3, 4]);
    const p3 = pageList(items, binding, p2.nextCursor as string, 2);
    expect(p3).toEqual({ items: [5], nextCursor: null });
    const other = await bindingOf('t', 2);
    invalid(() => pageList(items, other, p1.nextCursor as string, 2));
    invalid(() => pageList(items, binding, encodePageCursor(binding, { u: 'x' }), 2));
  });
});

describe('time cursors', () => {
  const ts = (n: number) => n;
  const rows = [50, 40, 40, 40, 30, 20];

  it('walks a newest-first list without repeats or gaps, also across equal timestamps', async () => {
    const binding = await bindingOf('t', 1);
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const pos = cursor === undefined ? null : readTimeCursor(binding, cursor);
      // The upstream answers with everything at or before the cursor's instant, newest first, up to the fetch size.
      const size = timeFetchSize(2, pos);
      const upstream = rows.filter((r) => pos === null || r <= pos.t).slice(0, size);
      const page = pageByTime(upstream, ts, pos, 2, upstream.length >= size);
      seen.push(...page.items);
      const next = page.more ? nextTimePosition(page.times, pos, 0) : null;
      cursor = next === null ? undefined : timeCursor(binding, next);
      if (cursor === undefined) break;
    }
    expect(seen).toEqual(rows);
  });

  it('drops rows newer than the cursor even when the upstream window edge is inclusive', () => {
    const pos = { t: 40, k: 1, s: 0 };
    const page = pageByTime([50, 40, 40, 30], ts, pos, 5, false);
    expect(page.items).toEqual([40, 30]);
    expect(page.more).toBe(false);
  });

  it('refuses a malformed position and a start after the instant', async () => {
    const binding = await bindingOf('t', 1);
    invalid(() => readTimeCursor(binding, encodePageCursor(binding, { o: 1 })));
    invalid(() => readTimeCursor(binding, encodePageCursor(binding, { t: 10, k: 0, s: 20 })));
    invalid(() => readTimeCursor(binding, encodePageCursor(binding, { t: 10, k: 999_999, s: 0 })));
  });

  it('asks upstream for the page, one more row, and the rows to skip, within a cap', () => {
    expect(timeFetchSize(25, null)).toBe(26);
    expect(timeFetchSize(25, { t: 1, k: 3, s: 0 })).toBe(29);
    expect(timeFetchSize(100, { t: 1, k: 10_000, s: 0 })).toBe(500);
  });
});
