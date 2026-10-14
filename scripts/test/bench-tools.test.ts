// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { measureTool, measureTools, quantile, type ToolMeasure } from '../bench/tools-harness.ts';
import { type Environment, renderTable } from '../bench-tools.ts';

const env: Environment = { date: '2026-10-14', machine: 'test box', node: '24.0.0', workerd: '1.0.0' };
const row = (tool: string, p50: number): ToolMeasure => ({
  tool,
  declaredCost: 4,
  requests: 1,
  responseBytes: 2048,
  resultBytes: 512,
  overhead: { p50, p95: p50 * 3, mean: p50 },
  samples: 30,
});

describe('renderTable', () => {
  it('states machine, versions, date and that the numbers are indicative', () => {
    const t = renderTable(env, [row('run_nrql', 0.5)], [row('run_nrql', 2)]);
    expect(t).toContain('2026-10-14');
    expect(t).toContain('test box');
    expect(t).toContain('Node 24.0.0, workerd 1.0.0');
    expect(t).toContain('Indicative only');
  });

  it('puts Node and Workers side by side with cost columns', () => {
    const t = renderTable(env, [row('run_nrql', 0.5)], [row('run_nrql', 2)]);
    expect(t).toContain('| `run_nrql` | 0.50 / 1.5 | 2.0 / 6.0 | 1 | 4 | 2.0 | 0.5 |');
  });

  it('marks a missing Workers pass and a tool error', () => {
    const t = renderTable(
      { ...env, workerd: null },
      [{ ...row('whoami', 0.001), error: 'tool error' }],
      null,
    );
    expect(t).toContain('| `whoami` (error) | <0.01 / <0.01 | n/a |');
    expect(t).not.toContain(', workerd ');
  });
});

describe('quantile', () => {
  it('uses the nearest lower rank', () => {
    expect(quantile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4], 0.95)).toBe(4);
    expect(quantile([], 0.5)).toBe(0);
  });
});

describe('measureTool', () => {
  it('counts the mock requests and bytes, and excludes simulated latency from the overhead', async () => {
    const [run] = await measureTools({ only: ['run_nrql'], samples: 3, warmup: 1, batch: 2, latencyMs: 20 });
    expect(run?.requests).toBe(1);
    expect(run?.responseBytes).toBeGreaterThan(0);
    expect(run?.error).toBeUndefined();
    // 20 ms of "New Relic" per call would dominate if it were counted.
    expect(run?.overhead.p50).toBeLessThan(15);
  });

  it('runs a tool that sends no request', async () => {
    const tools = await measureTools({ only: ['time_range'], samples: 2, warmup: 0, batch: 1 });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.requests).toBe(0);
    expect(typeof measureTool).toBe('function');
  });
});
