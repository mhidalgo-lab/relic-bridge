// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createBudget, ErrorCode, isRbError, newRequestId } from '../src/index.ts';

describe('createBudget', () => {
  it('counts spending and throws RB_BUDGET_EXHAUSTED past the limit', () => {
    const b = createBudget(3);
    b.spend(2);
    expect(b.remaining).toBe(1);
    expect(b.canSpend(2)).toBe(false);
    let caught: unknown;
    try {
      b.spend(2, 'NerdGraph poll');
    } catch (e) {
      caught = e;
    }
    expect(isRbError(caught) && caught.code).toBe(ErrorCode.BudgetExhausted);
    expect(b.used).toBe(2);
  });
});

describe('newRequestId', () => {
  it('returns unique UUIDs', () => {
    expect(newRequestId()).not.toBe(newRequestId());
    expect(newRequestId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
