// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ErrorCode, RbError } from '../src/errors.ts';
import { parseTimeRange } from '../src/time/range.ts';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

describe('a time range in the future (P8-98)', () => {
  it('refuses a range that starts after now with RB_INPUT_INVALID', () => {
    for (const expr of ['2026-10-20 to 2026-10-21', '2026-10-16T13:00:00Z to 2026-10-16T14:00:00Z']) {
      let error: unknown;
      try {
        parseTimeRange(expr, NOW);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(RbError);
      expect((error as RbError).code).toBe(ErrorCode.InputInvalid);
      expect((error as RbError).message).toBe('The range is in the future: New Relic has no data there.');
    }
  });

  it('accepts now-relative ranges, ranges that end in the future, and a start a few seconds ahead', () => {
    expect(parseTimeRange('last 2 hours', NOW).untilMs).toBe(NOW);
    expect(parseTimeRange('today', NOW).sinceMs).toBeLessThanOrEqual(NOW);
    expect(parseTimeRange('2026-10-16T11:00:00Z to 2026-10-17T00:00:00Z', NOW).untilMs).toBeGreaterThan(NOW);
    expect(parseTimeRange('2026-10-16T12:00:30Z to 2026-10-16T13:00:00Z', NOW).sinceMs).toBe(NOW + 30_000);
  });
});
