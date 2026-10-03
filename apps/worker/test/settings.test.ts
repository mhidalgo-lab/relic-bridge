// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { PLAN_CALL_BUDGET, parseWorkerSettings, WorkerConfigError } from '../src/settings.ts';

const fails = (vars: Record<string, unknown>, variable: string): void => {
  let caught: unknown;
  try {
    parseWorkerSettings(vars);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WorkerConfigError);
  expect((caught as WorkerConfigError).variable).toBe(variable);
};

describe('parseWorkerSettings', () => {
  it('defaults: free plan, any host, loopback origins, audit and rate limiting on', () => {
    const s = parseWorkerSettings({});
    expect(s).toMatchObject({
      plan: 'free',
      callBudget: 50,
      allowedHosts: '*',
      corsOrigins: [],
      audit: { enabled: true, nrql: 'mask', clientIp: true },
      rateLimit: true,
      logLevel: 'info',
      warnings: [],
    });
    expect(s.allowedOrigins).toBeUndefined();
    expect(s.accessCacheTtlMs).toBeUndefined();
  });

  it('reads every supported variable, including JSON-typed vars', () => {
    const s = parseWorkerSettings({
      RB_PLAN: 'Paid',
      RB_ALLOWED_HOSTS: 'MCP.example.com, rb.example.workers.dev',
      RB_ALLOWED_ORIGINS: 'app.example.com',
      RB_CORS_ORIGINS: 'https://app.example.com',
      RB_ACCESS_CACHE_TTL: 0 as unknown as string,
      RB_AUDIT_NRQL: 'full',
      RB_AUDIT_CLIENT_IP: 'off',
      RB_RATE_LIMIT: false as unknown as string,
      RB_LOG_LEVEL: 'debug',
    });
    expect(s).toMatchObject({
      plan: 'paid',
      callBudget: PLAN_CALL_BUDGET.paid,
      allowedHosts: ['mcp.example.com', 'rb.example.workers.dev'],
      allowedOrigins: ['app.example.com'],
      corsOrigins: ['https://app.example.com'],
      accessCacheTtlMs: 0,
      audit: { enabled: true, nrql: 'full', clientIp: false },
      rateLimit: false,
      logLevel: 'debug',
    });
    expect(s.warnings).toHaveLength(2);
  });

  it('treats * and blank values as defaults', () => {
    expect(parseWorkerSettings({ RB_ALLOWED_HOSTS: '*', RB_PLAN: '  ' })).toMatchObject({
      allowedHosts: '*',
      plan: 'free',
    });
  });

  it('fails closed on invalid values', () => {
    fails({ RB_PLAN: 'enterprise' }, 'RB_PLAN');
    fails({ RB_ALLOWED_HOSTS: 'bad host/' }, 'RB_ALLOWED_HOSTS');
    fails({ RB_CORS_ORIGINS: 'app.example.com' }, 'RB_CORS_ORIGINS');
    fails({ RB_ACCESS_CACHE_TTL: '61' }, 'RB_ACCESS_CACHE_TTL');
    fails({ RB_ACCESS_CACHE_TTL: '-1' }, 'RB_ACCESS_CACHE_TTL');
    fails({ RB_AUDIT: 'maybe' }, 'RB_AUDIT');
    fails({ RB_AUDIT_NRQL: 'raw' }, 'RB_AUDIT_NRQL');
    fails({ RB_RATE_LIMIT: 'sometimes' }, 'RB_RATE_LIMIT');
    fails({ RB_PASSTHROUGH: 'on' }, 'RB_PASSTHROUGH');
    fails({ RB_LOG_LEVEL: 'trace' }, 'RB_LOG_LEVEL');
    fails({ RB_PLAN: { nested: true } }, 'RB_PLAN');
  });

  it('accepts RB_PASSTHROUGH=off', () => {
    expect(() => parseWorkerSettings({ RB_PASSTHROUGH: 'off' })).not.toThrow();
  });
});
