// SPDX-License-Identifier: Apache-2.0
// P4-07 security review (storage side of audit stats): the SQL fragment is chosen from a fixed table.
// Report: docs/reviews/phase-4-admin-security-review.md.
import { describe, expect, it } from 'vitest';
import { auditStatsSql } from '../src/audit-stats.ts';

describe('auditStatsSql group selection', () => {
  const base = { since: 0, until: 1000 };
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])(
    'fix: refuses inherited object keys as groupBy (%s)',
    (key) => {
      // Finding L7 (fixed): only the five known groups; an inherited Object.prototype member must never reach the SQL text.
      expect(() => auditStatsSql({ ...base, groupBy: key as never })).toThrow();
    },
  );
  it('limit is clamped to 100 and the window to 90 days at the storage layer too', () => {
    expect(auditStatsSql({ ...base, groupBy: 'action', limit: 1e9 }).params.at(-1)).toBe(100);
    expect(() => auditStatsSql({ since: 0, until: 91 * 86_400_000, groupBy: 'action' })).toThrow();
    expect(() => auditStatsSql({ since: 0, until: Number.POSITIVE_INFINITY, groupBy: 'action' })).toThrow();
  });
});
