// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { isAllowed } from '../check-licenses.ts';

describe('isAllowed', () => {
  it('accepts permissive licenses and OR expressions with one permissive option', () => {
    expect(isAllowed('MIT')).toBe(true);
    expect(isAllowed('(MIT OR GPL-3.0)')).toBe(true);
    expect(isAllowed('MIT OR Apache-2.0')).toBe(true);
  });

  it('rejects copyleft, unknown and AND expressions with a copyleft part', () => {
    expect(isAllowed('GPL-3.0')).toBe(false);
    expect(isAllowed('AGPL-3.0-only')).toBe(false);
    expect(isAllowed('Unknown')).toBe(false);
    expect(isAllowed('')).toBe(false);
    expect(isAllowed('MIT AND GPL-2.0')).toBe(false);
  });

  it('handles WITH exceptions by the base license', () => {
    expect(isAllowed('Apache-2.0 WITH LLVM-exception')).toBe(true);
  });
});
