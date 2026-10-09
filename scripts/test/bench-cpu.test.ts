// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  type Baseline,
  compare,
  type Measured,
  persistentRegressions,
  renderTable,
  toBaseline,
} from '../bench-cpu.ts';

const m = (typical: number): Measured => ({ typical, p50: typical, p95: typical * 2, mean: typical, n: 100 });
const baseline: Baseline = { schema: 1, calibrationMs: 4, scenarios: { big: 8, tiny: 0.05 } };

describe('compare', () => {
  it('passes a run within tolerance', () => {
    const c = compare({ calibration: m(4), big: m(10), tiny: m(0.06) }, baseline);
    expect(c.regressions).toEqual([]);
    expect(c.rows.map((r) => r.status)).toEqual(['ok', 'ok']);
  });

  it('flags a clear regression', () => {
    const c = compare({ calibration: m(4), big: m(20), tiny: m(0.05) }, baseline);
    expect(c.regressions).toEqual(['big']);
  });

  it('scales the expectation with the machine speed (a slow runner is not a regression)', () => {
    // Calibration took 3x as long, so 3x slower scenarios are expected.
    const c = compare({ calibration: m(12), big: m(24), tiny: m(0.15) }, baseline);
    expect(c.regressions).toEqual([]);
  });

  it('ignores a large ratio on a tiny absolute change', () => {
    const c = compare({ calibration: m(4), big: m(8), tiny: m(0.5) }, baseline);
    expect(c.regressions).toEqual([]);
  });

  it('reports new and missing scenarios without failing', () => {
    const c = compare({ calibration: m(4), big: m(8), extra: m(1) }, baseline);
    expect(c.rows.find((r) => r.name === 'extra')?.status).toBe('new');
    expect(c.missing).toEqual(['tiny']);
    expect(c.regressions).toEqual([]);
  });

  it('refuses a run whose clock did not advance', () => {
    expect(() => compare({ calibration: m(0), big: m(8) }, baseline)).toThrow(/calibration/);
    expect(() => compare({ big: m(8) }, baseline)).toThrow(/calibration/);
  });
});

describe('persistentRegressions (phase 6 review: confirm before failing)', () => {
  const slow = compare({ calibration: m(4), big: m(20), tiny: m(0.05) }, baseline);
  const fine = compare({ calibration: m(4), big: m(9), tiny: m(0.05) }, baseline);

  it('a regression in one run only is noise', () => {
    expect(persistentRegressions([slow, fine])).toEqual([]);
    expect(persistentRegressions([slow, slow, fine])).toEqual([]);
  });

  it('a regression in every run fails', () => {
    expect(persistentRegressions([slow])).toEqual(['big']);
    expect(persistentRegressions([slow, slow, slow])).toEqual(['big']);
  });

  it('no runs, no regressions', () => {
    expect(persistentRegressions([])).toEqual([]);
  });
});

describe('baseline and table', () => {
  it('builds a baseline from a run, calibration separate', () => {
    expect(toBaseline({ calibration: m(4.0004), big: m(8.12345) })).toEqual({
      schema: 1,
      calibrationMs: 4,
      scenarios: { big: 8.123 },
    });
  });

  it('renders a row per scenario with the share of the Free limit', () => {
    const c = compare({ calibration: m(4), big: m(20) }, baseline);
    const table = renderTable(c, 4);
    expect(table).toContain('| big | 20.00 |');
    expect(table).toContain('200%');
    expect(table).toContain('REGRESSION');
  });
});

describe('.github/workflows/bench.yml', () => {
  const raw = readFileSync(new URL('../../.github/workflows/bench.yml', import.meta.url), 'utf8');
  const workflow = parse(raw) as {
    on: { pull_request?: { paths?: string[] }; push?: unknown };
    permissions?: Record<string, string>;
  };

  it('is path-filtered for pull requests, never runs on push and holds read-only permissions', () => {
    expect(workflow.on.pull_request?.paths?.length).toBeGreaterThan(0);
    expect(workflow.on.push).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('pins every action by commit SHA and uses no secrets', () => {
    const code = raw.replace(/#.*$/gm, '');
    for (const m of code.matchAll(/uses:\s*(\S+)/g)) expect(m[1]).toMatch(/@[0-9a-f]{40}$/);
    expect(code).not.toContain('secrets.');
  });
});
