// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { purgeExpiredKv } from '../src/kv-purge.ts';

/** A kv stand-in holding `rows` expired rows; `purgeExpired(n)` removes at most n. */
function fake(rows: number) {
  const calls: (number | undefined)[] = [];
  return {
    calls,
    kv: {
      purgeExpired: async (limit?: number) => {
        calls.push(limit);
        const n = Math.min(rows, limit ?? 1000);
        rows -= n;
        return n;
      },
    },
  };
}

describe('purgeExpiredKv', () => {
  it('loops until a short batch, then reports complete', async () => {
    const f = fake(1200);
    expect(await purgeExpiredKv(f.kv, { batchRows: 500 })).toEqual({
      removed: 1200,
      batches: 3,
      complete: true,
    });
    expect(f.calls).toEqual([500, 500, 500]);
  });

  it('stops at the batch budget and leaves the rest for the next run', async () => {
    const f = fake(5000);
    expect(await purgeExpiredKv(f.kv, { batchRows: 100, maxBatches: 2 })).toEqual({
      removed: 200,
      batches: 2,
      complete: false,
    });
  });

  it('stops at the time budget', async () => {
    const f = fake(5000);
    let t = 0;
    const r = await purgeExpiredKv(f.kv, { batchRows: 10, budgetMs: 100 }, () => (t += 60));
    expect(r.complete).toBe(false);
    expect(r.batches).toBe(1);
  });

  it('propagates storage errors to the caller', async () => {
    await expect(
      purgeExpiredKv({
        purgeExpired: () => Promise.reject(new Error('boom')),
      }),
    ).rejects.toThrow('boom');
  });
});
