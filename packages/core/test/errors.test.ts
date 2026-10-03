// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ERROR_META_KEY, ErrorCode, RbError, toToolErrorResult } from '../src/index.ts';

describe('toToolErrorResult', () => {
  it('maps RbError to an actionable MCP tool error', () => {
    const r = toToolErrorResult(
      new RbError(ErrorCode.LimitQuery, 'Time window too wide (30 days, max 7).', {
        hint: 'Use SINCE 7 days ago or less.',
        details: { maxWindowDays: 7 },
      }),
      'req-1',
    );
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([
      {
        type: 'text',
        text: 'RB_LIMIT_QUERY: Time window too wide (30 days, max 7).\nHint: Use SINCE 7 days ago or less.\nDetails: {"maxWindowDays":7}',
      },
    ]);
    expect(r._meta?.[ERROR_META_KEY]).toEqual({ code: 'RB_LIMIT_QUERY', requestId: 'req-1' });
  });

  it('hides unknown errors behind RB_INTERNAL with a reference', () => {
    const r = toToolErrorResult(new TypeError('secret internals at /srv/app.ts:12'), 'req-9');
    const text = (r.content[0] as { text: string }).text;
    expect(text).toBe('RB_INTERNAL: Internal error. Reference: req-9');
    expect(text).not.toContain('/srv/app.ts');
  });

  it('redacts secrets that slipped into an RbError message', () => {
    const r = toToolErrorResult(
      new RbError(ErrorCode.NerdGraphError, 'upstream said NRAK-ABCDEFGHIJKLMNOPQRSTUVWXYZ0 is bad'),
      'r',
    );
    expect(JSON.stringify(r)).not.toContain('NRAK-ABCDEFGHIJKLMNOPQRSTUVWXYZ0');
  });

  it('codes are stable RB_ identifiers', () => {
    for (const code of Object.values(ErrorCode)) expect(code).toMatch(/^RB_[A-Z_]+$/);
  });
});
