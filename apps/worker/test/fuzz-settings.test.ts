// SPDX-License-Identifier: Apache-2.0
// Property / fuzz test of the Worker's `vars` parsing (P8-01, T20/T31): any combination of values gives settings or a
// WorkerConfigError naming a known variable, and every protection stays on unless its variable says off exactly.
// Runs inside workerd like the other Worker tests; bounded (`RB_FUZZ_RUNS` is not visible inside workerd).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FUZZ_TIMEOUT, fuzzParams } from '../../../packages/core/test/helpers/fuzz.ts';
import { parseWorkerSettings, WorkerConfigError } from '../src/settings.ts';

const NAMES = [
  'RB_PLAN',
  'RB_CALL_BUDGET',
  'RB_MAX_RESPONSE_BYTES',
  'RB_CONCURRENCY',
  'RB_ALLOWED_HOSTS',
  'RB_ALLOWED_ORIGINS',
  'RB_CORS_ORIGINS',
  'RB_ACCESS_CACHE_TTL',
  'RB_QUERY_CACHE',
  'RB_QUERY_CACHE_TTL',
  'RB_AUDIT',
  'RB_AUDIT_NRQL',
  'RB_AUDIT_CLIENT_IP',
  'RB_AUDIT_RETENTION_DAYS',
  'RB_RATE_LIMIT',
  'RB_SHARED_LIMITER',
  'RB_PASSTHROUGH',
  'RB_WRITE_TOOLS',
  'RB_WRITE_APPROVAL',
  'RB_PUBLIC_TOOL_CATALOG',
  'RB_MCP_APPS',
  'RB_TASKS',
  'RB_LOG_LEVEL',
] as const;
const ON = ['on', 'true', '1'];
const OFF = ['off', 'false', '0'];
const norm = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim().toLowerCase());

const value = fc.oneof(
  fc.constantFrom(
    'on',
    'off',
    ' ON ',
    'true',
    'false',
    '0',
    '1',
    'yes',
    '',
    'free',
    'paid',
    'rules',
    'memory',
  ),
  fc.constantFrom(
    'client',
    'required',
    'mask',
    'full',
    'debug',
    '*',
    'rb.example.com',
    'https://app.example.com',
    '30',
    '61',
  ),
  fc.integer({ min: -2, max: 70_000_000 }),
  fc.boolean(),
  fc.string({ unit: 'binary', maxLength: 16 }),
  fc.anything(),
);

describe('parseWorkerSettings (fuzz)', { timeout: FUZZ_TIMEOUT }, () => {
  it('gives settings or a WorkerConfigError; protections stay on unless switched off exactly', () => {
    let accepted = 0;
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom(...NAMES), value, { maxKeys: 8 }), (vars) => {
        let s: ReturnType<typeof parseWorkerSettings>;
        try {
          s = parseWorkerSettings(vars as never);
        } catch (error) {
          expect(error).toBeInstanceOf(WorkerConfigError);
          expect(NAMES).toContain((error as WorkerConfigError).variable);
          return;
        }
        accepted++;
        if (!s.rateLimit) expect(OFF).toContain(norm(vars['RB_RATE_LIMIT']));
        if (!s.audit.enabled) expect(OFF).toContain(norm(vars['RB_AUDIT']));
        if (s.passthrough) {
          expect(ON).toContain(norm(vars['RB_PASSTHROUGH']));
          expect(s.rateLimit).toBe(true);
        }
        if (s.writeTools) {
          expect(ON).toContain(norm(vars['RB_WRITE_TOOLS']));
          expect(s.audit.enabled).toBe(true);
        }
        if (!s.requireWriteApproval) expect(norm(vars['RB_WRITE_APPROVAL'])).toBe('client');
        if (s.publicToolCatalog) expect(ON).toContain(norm(vars['RB_PUBLIC_TOOL_CATALOG']));
        expect(s.callBudget).toBeGreaterThanOrEqual(1);
        expect(s.callBudget).toBeLessThanOrEqual(10_000);
        expect(s.concurrency).toBeGreaterThanOrEqual(1);
        expect(s.concurrency).toBeLessThanOrEqual(6);
        if (s.accessCacheTtlMs !== undefined) expect(s.accessCacheTtlMs).toBeLessThanOrEqual(60_000);
      }),
      fuzzParams(1000),
    );
    expect(accepted).toBeGreaterThan(0);
  });
});
