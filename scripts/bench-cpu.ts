// SPDX-License-Identifier: Apache-2.0
// CPU benchmark runner (P3-10). Runs `apps/worker/bench/cpu.bench.ts` in workerd, prints a table and compares it with
// the committed `apps/worker/bench/baseline.json`.
//
//   node scripts/bench-cpu.ts            run, print the table, exit 1 on a clear regression (confirmed by re-runs)
//   node scripts/bench-cpu.ts --update   run and rewrite the baseline (do this on a quiet machine, commit the result)
//   node scripts/bench-cpu.ts --report   run and print only; never fails on a regression
//
// Comparison: CI runners differ in speed and are noisy, so every scenario is judged as a ratio to the `calibration`
// scenario (a fixed pure-CPU job measured in the same run). A scenario regresses only when its ratio grew by more
// than TOLERANCE times AND it got slower by more than MIN_DELTA_MS in calibrated terms. Both must hold, so a tiny
// scenario doubling from 0.05 to 0.1 ms is not a failure, and neither is a 20% drift in a big one.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Ratio growth that counts as a regression (2 = twice as slow, relative to calibration). */
export const TOLERANCE = 2;
/** Minimum slowdown, in ms at the baseline machine's speed, before a ratio growth counts. */
export const MIN_DELTA_MS = 1;
/**
 * Runs before a regression counts (phase 6 review). A scenario fails only when it regresses in every run: a real
 * slowdown repeats, a burst of load from another process (parallel test runs, a busy laptop) rarely hits the same
 * scenario three times. The first run alone decides when it has no regression.
 */
export const MAX_RUNS = 3;
/** Workers Free CPU limit per request, the reference column of the table. */
export const FREE_CPU_MS = 10;
/** `typical` of the calibration scenario below this means the clock did not advance: the measurement is meaningless. */
export const MIN_CALIBRATION_MS = 0.5;

export interface Measured {
  readonly typical: number;
  readonly p50: number;
  readonly p95: number;
  readonly mean: number;
  readonly n: number;
}

export interface Baseline {
  readonly schema: 1;
  /** `typical` of the calibration scenario when the baseline was taken (ms). */
  readonly calibrationMs: number;
  /** Scenario -> `typical` in ms. */
  readonly scenarios: Readonly<Record<string, number>>;
}

export interface Row {
  readonly name: string;
  readonly typical: number;
  readonly p95: number;
  /** `typical` relative to the calibration run; 1 = as before the baseline's own ratio. */
  readonly vsBaseline: number | null;
  readonly status: 'ok' | 'regression' | 'new';
}

export interface Comparison {
  readonly rows: readonly Row[];
  readonly missing: readonly string[];
  readonly regressions: readonly string[];
}

/** Compares a run with the baseline. Throws when the calibration scenario is absent or unusable. */
export function compare(
  results: Readonly<Record<string, Measured>>,
  baseline: Baseline,
  tolerance: number = TOLERANCE,
  minDeltaMs: number = MIN_DELTA_MS,
): Comparison {
  const cal = results['calibration'];
  if (cal === undefined || cal.typical < MIN_CALIBRATION_MS) {
    throw new Error(
      `calibration scenario missing or below ${MIN_CALIBRATION_MS} ms (${cal?.typical ?? 'absent'}): the clock did not advance`,
    );
  }
  // Speed of this machine relative to the baseline's: >1 means slower.
  const speed = cal.typical / baseline.calibrationMs;
  const rows: Row[] = [];
  const regressions: string[] = [];
  for (const [name, m] of Object.entries(results)) {
    if (name === 'calibration') continue;
    const base = baseline.scenarios[name];
    if (base === undefined) {
      rows.push({ name, typical: m.typical, p95: m.p95, vsBaseline: null, status: 'new' });
      continue;
    }
    const expected = base * speed;
    const vsBaseline = m.typical / expected;
    const regressed = vsBaseline > tolerance && m.typical - expected > minDeltaMs * speed;
    if (regressed) regressions.push(name);
    rows.push({ name, typical: m.typical, p95: m.p95, vsBaseline, status: regressed ? 'regression' : 'ok' });
  }
  const missing = Object.keys(baseline.scenarios).filter((n) => results[n] === undefined);
  return { rows, missing, regressions };
}

/** Scenarios that regressed in every comparison (the runs so far). */
export function persistentRegressions(comparisons: readonly Comparison[]): string[] {
  const [first, ...rest] = comparisons;
  if (first === undefined) return [];
  return first.regressions.filter((name) => rest.every((c) => c.regressions.includes(name)));
}

export function toBaseline(results: Readonly<Record<string, Measured>>): Baseline {
  const cal = results['calibration'];
  if (cal === undefined || cal.typical < MIN_CALIBRATION_MS) throw new Error('calibration scenario unusable');
  const scenarios: Record<string, number> = {};
  for (const [name, m] of Object.entries(results)) {
    if (name !== 'calibration') scenarios[name] = Number(m.typical.toFixed(3));
  }
  return { schema: 1, calibrationMs: Number(cal.typical.toFixed(3)), scenarios };
}

/** A Markdown table (readable in the log and in the job summary). */
export function renderTable(c: Comparison, calibrationMs: number): string {
  const lines = [
    '| Scenario | CPU typical (ms) | p95 (ms) | of Free 10 ms | vs baseline | |',
    '|---|---:|---:|---:|---:|---|',
  ];
  for (const r of c.rows) {
    const vs = r.vsBaseline === null ? 'n/a' : `${r.vsBaseline.toFixed(2)}x`;
    const flag = r.status === 'regression' ? 'REGRESSION' : r.status === 'new' ? 'new' : '';
    lines.push(
      `| ${r.name} | ${r.typical.toFixed(2)} | ${r.p95.toFixed(1)} | ${Math.round((r.typical / FREE_CPU_MS) * 100)}% | ${vs} | ${flag} |`,
    );
  }
  lines.push('', `Calibration (fixed JS job): ${calibrationMs.toFixed(2)} ms on this machine.`);
  if (c.missing.length > 0) lines.push(`In the baseline but not run: ${c.missing.join(', ')}.`);
  return lines.join('\n');
}

const root = fileURLToPath(new URL('..', import.meta.url));
const baselinePath = join(root, 'apps/worker/bench/baseline.json');

/** Runs the benchmark project and returns the per-scenario summaries from the JSON reporter. */
function run(): Record<string, Measured> {
  const dir = mkdtempSync(join(tmpdir(), 'rb-bench-'));
  const out = join(dir, 'report.json');
  try {
    const res = spawnSync(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--config',
        'vitest.bench.config.ts',
        'cpu.bench',
        '--reporter=json',
        `--outputFile=${out}`,
      ],
      { cwd: join(root, 'apps/worker'), stdio: ['ignore', 'inherit', 'inherit'], encoding: 'utf8' },
    );
    let report: {
      testResults: { assertionResults: { title: string; status: string; meta?: { cpu?: Measured } }[] }[];
    };
    try {
      report = JSON.parse(readFileSync(out, 'utf8'));
    } catch {
      throw new Error(`the benchmark did not produce a report (vitest exit ${res.status})`);
    }
    const results: Record<string, Measured> = {};
    for (const a of report.testResults.flatMap((f) => f.assertionResults)) {
      if (a.status !== 'passed' || a.meta?.cpu === undefined)
        throw new Error(`scenario ${a.title}: ${a.status}`);
      results[a.title] = a.meta.cpu;
    }
    return results;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  const results = run();
  if (args.has('--update')) {
    const baseline = toBaseline(results);
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(`baseline written: ${baselinePath}\n`);
    process.exit(0);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
  const comparisons = [compare(results, baseline)];
  let last = results;
  // Re-run only to confirm: stop as soon as no scenario has regressed in every run so far.
  while (comparisons.length < MAX_RUNS && persistentRegressions(comparisons).length > 0) {
    process.stderr.write(
      `\nPossible regression (${persistentRegressions(comparisons).join(', ')}): confirming, run ${comparisons.length + 1} of ${MAX_RUNS}.\n`,
    );
    last = run();
    comparisons.push(compare(last, baseline));
  }
  const regressions = persistentRegressions(comparisons);
  const comparison = comparisons[comparisons.length - 1] as Comparison;
  const table = renderTable(comparison, last['calibration']?.typical ?? 0);
  const runsNote =
    comparisons.length > 1 ? `\nRuns: ${comparisons.length} (the table is the last one).\n` : '';
  process.stdout.write(`\n${table}\n${runsNote}`);
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '')
    appendFileSync(summary, `### Worker CPU benchmark\n\n${table}\n${runsNote}`);
  if (regressions.length > 0) {
    process.stderr.write(
      `\nCPU regression (more than ${TOLERANCE}x slower relative to calibration in ${comparisons.length} runs): ${regressions.join(', ')}\n`,
    );
    process.exit(args.has('--report') ? 0 : 1);
  }
}
