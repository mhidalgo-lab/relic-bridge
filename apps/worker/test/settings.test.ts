// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { PLAN_CALL_BUDGET, PLAN_PRESETS, parseWorkerSettings, WorkerConfigError } from '../src/settings.ts';

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
      callBudget: 45,
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

  it('parses the audit retention like the CLI (default 90, 0 keeps everything, junk fails)', () => {
    expect(parseWorkerSettings({}).audit.retentionDays).toBe(90);
    expect(parseWorkerSettings({ RB_AUDIT_RETENTION_DAYS: '0' }).audit.retentionDays).toBe(0);
    expect(
      parseWorkerSettings({ RB_AUDIT_RETENTION_DAYS: 30 as unknown as string }).audit.retentionDays,
    ).toBe(30);
    for (const bad of ['-1', 'x', '1.5', '123456']) {
      expect(() => parseWorkerSettings({ RB_AUDIT_RETENTION_DAYS: bad })).toThrow(/RB_AUDIT_RETENTION_DAYS/);
    }
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
    fails({ RB_PASSTHROUGH: 'on', RB_RATE_LIMIT: 'off' }, 'RB_PASSTHROUGH');
    fails({ RB_LOG_LEVEL: 'trace' }, 'RB_LOG_LEVEL');
    fails({ RB_PLAN: { nested: true } }, 'RB_PLAN');
  });

  it('parses RB_TASKS (P7-34): on by default, off is the kill switch', () => {
    expect(parseWorkerSettings({}).tasks).toBe(true);
    expect(parseWorkerSettings({ RB_TASKS: 'off' }).tasks).toBe(false);
    fails({ RB_TASKS: 'maybe' }, 'RB_TASKS');
  });

  it('parses RB_MCP_APPS (P7-16): on by default, off turns the chart view off', () => {
    expect(parseWorkerSettings({}).mcpApps).toBe(true);
    expect(parseWorkerSettings({ RB_MCP_APPS: 'off' }).mcpApps).toBe(false);
    fails({ RB_MCP_APPS: 'maybe' }, 'RB_MCP_APPS');
  });

  it('parses RB_WRITE_TOOLS (P7-09): off by default, needs the audit log', () => {
    expect(parseWorkerSettings({}).writeTools).toBe(false);
    const on = parseWorkerSettings({ RB_WRITE_TOOLS: 'on' });
    expect(on.writeTools).toBe(true);
    expect(on.warnings.join(' ')).toContain('RB_WRITE_TOOLS=on');
    fails({ RB_WRITE_TOOLS: 'on', RB_AUDIT: 'off' }, 'RB_WRITE_TOOLS');
    expect(parseWorkerSettings({ RB_WRITE_TOOLS: 'on', RB_RATE_LIMIT: 'off' }).warnings.join(' ')).toContain(
      'not rate limited',
    );
    fails({ RB_WRITE_TOOLS: 'sure' }, 'RB_WRITE_TOOLS');
    // P7-25: the approval switch
    // ADR-0016 / P7-33: unset means required; `client` is an explicit opt-down that warns when writes are on
    expect(parseWorkerSettings({}).requireWriteApproval).toBe(true);
    expect(parseWorkerSettings({ RB_WRITE_TOOLS: 'on' }).requireWriteApproval).toBe(true);
    expect(parseWorkerSettings({ RB_WRITE_TOOLS: 'on' }).warnings.join(' ')).not.toContain(
      'RB_WRITE_APPROVAL',
    );
    expect(
      parseWorkerSettings({ RB_WRITE_TOOLS: 'on', RB_WRITE_APPROVAL: 'required' }).requireWriteApproval,
    ).toBe(true);
    const optDown = parseWorkerSettings({ RB_WRITE_TOOLS: 'on', RB_WRITE_APPROVAL: 'client' });
    expect(optDown.requireWriteApproval).toBe(false);
    expect(optDown.warnings.join(' ')).toContain('RB_WRITE_APPROVAL=client');
    expect(parseWorkerSettings({ RB_WRITE_APPROVAL: 'client' }).warnings.join(' ')).not.toContain(
      'RB_WRITE_APPROVAL=client',
    );
    expect(parseWorkerSettings({ RB_WRITE_APPROVAL: 'required' }).warnings.join(' ')).toContain('no effect');
    fails({ RB_WRITE_APPROVAL: 'always' }, 'RB_WRITE_APPROVAL');
  });

  it('parses RB_PASSTHROUGH (secret and binding are checked at boot)', () => {
    expect(parseWorkerSettings({ RB_PASSTHROUGH: 'off' }).passthrough).toBe(false);
    expect(parseWorkerSettings({ RB_PASSTHROUGH: 'on' }).passthrough).toBe(true);
  });

  describe('plan presets', () => {
    it('free keeps the NerdGraph budget under the 50 external subrequests, and responses small', () => {
      expect(parseWorkerSettings({})).toMatchObject({
        callBudget: 45,
        maxResponseBytes: 512 * 1024,
        concurrency: 5,
      });
      expect(PLAN_PRESETS.free.callBudget).toBeLessThan(50);
    });

    it('paid raises the budget and the response ceiling; concurrency stays within 6', () => {
      expect(parseWorkerSettings({ RB_PLAN: 'paid' })).toMatchObject({
        callBudget: 1000,
        maxResponseBytes: 8 * 1024 * 1024,
        concurrency: 5,
      });
      for (const p of Object.values(PLAN_PRESETS)) expect(p.concurrency).toBeLessThanOrEqual(6);
    });

    it('explicit overrides win over the preset', () => {
      expect(
        parseWorkerSettings({
          RB_PLAN: 'paid',
          RB_CALL_BUDGET: 200 as unknown as string,
          RB_MAX_RESPONSE_BYTES: '1048576',
          RB_CONCURRENCY: '2',
        }),
      ).toMatchObject({ callBudget: 200, maxResponseBytes: 1048576, concurrency: 2 });
    });

    it('rejects out-of-range or malformed overrides instead of clamping them', () => {
      fails({ RB_CALL_BUDGET: '0' }, 'RB_CALL_BUDGET');
      fails({ RB_CALL_BUDGET: '10001' }, 'RB_CALL_BUDGET');
      fails({ RB_CALL_BUDGET: '1e3' }, 'RB_CALL_BUDGET');
      fails({ RB_MAX_RESPONSE_BYTES: '10' }, 'RB_MAX_RESPONSE_BYTES');
      fails({ RB_CONCURRENCY: '7' }, 'RB_CONCURRENCY');
      fails({ RB_CONCURRENCY: '0' }, 'RB_CONCURRENCY');
    });

    it('warns when a Free deployment is configured beyond its platform limits', () => {
      const s = parseWorkerSettings({ RB_CALL_BUDGET: '100', RB_MAX_RESPONSE_BYTES: '2097152' });
      expect(s.warnings).toHaveLength(2);
      expect(parseWorkerSettings({ RB_PLAN: 'paid', RB_CALL_BUDGET: '100' }).warnings).toEqual([]);
    });
  });
});
