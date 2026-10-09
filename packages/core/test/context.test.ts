// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { budgetUsage, createBudget, ErrorCode, isRbError, newRequestId } from '../src/index.ts';

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

describe('NerdGraph usage on the budget (P7-18)', () => {
  it('counts attempts and response bytes apart from spending, and ignores junk sizes', () => {
    const b = createBudget(10);
    b.spend(2, 'cache');
    expect(budgetUsage({ budget: b } as never)).toEqual({ nerdgraphCalls: 0, nerdgraphBytes: 0 });
    b.noteNerdGraphCall?.();
    b.noteNerdGraphBytes?.(120);
    b.noteNerdGraphBytes?.(Number.NaN);
    b.noteNerdGraphBytes?.(-4);
    expect(budgetUsage({ budget: b } as never)).toEqual({ nerdgraphCalls: 1, nerdgraphBytes: 120 });
    expect(b.used).toBe(2);
  });

  it('a budget that does not count reports nothing', () => {
    const plain = { limit: 1, used: 0, remaining: 1, canSpend: () => true, spend: () => {} };
    expect(budgetUsage({ budget: plain } as never)).toEqual({});
  });
});
