// SPDX-License-Identifier: Apache-2.0
// Per-tool overhead and cost benchmark (P8-03): relic-bridge's own time and the NerdGraph requests of every built-in
// tool, on Node and on Workers (workerd), against a deterministic NerdGraph mock (recorded fixtures; no New Relic key).
//
//   node scripts/bench-tools.ts                 both runtimes, Markdown table on stdout
//   node scripts/bench-tools.ts --out table.md  also write the table to a file
//   node scripts/bench-tools.ts --node          Node only (no workerd needed)
//   node scripts/bench-tools.ts --samples 60    timed samples per tool (default 30, each the mean of 10 calls)
//
// Not a required check and not in CI: the numbers belong to the machine they ran on (see the header of the table).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureTools, type ToolMeasure } from './bench/tools-harness.ts';

export interface Environment {
  readonly date: string;
  readonly machine: string;
  readonly node: string;
  readonly workerd: string | null;
}

const fmt = (ms: number): string => (ms < 0.005 ? '<0.01' : ms.toFixed(ms < 1 ? 2 : 1));
const kib = (bytes: number): string => (bytes / 1024).toFixed(1);

/** The table: one row per tool, Node and Workers overhead side by side, then cost columns. */
export function renderTable(
  env: Environment,
  node: readonly ToolMeasure[],
  workers: readonly ToolMeasure[] | null,
): string {
  const byTool = new Map((workers ?? []).map((m) => [m.tool, m]));
  const lines = [
    `Measured ${env.date} on ${env.machine}; Node ${env.node}${env.workerd === null ? '' : `, workerd ${env.workerd}`}.`,
    'Mock NerdGraph (recorded fixtures, zero latency), in-memory MCP client, sample arguments from the contract tests.',
    '**Indicative only**: the numbers depend on the machine, and local workerd is not production Workers.',
    '',
    '| Tool | Node p50 / p95 (ms) | Workers p50 / p95 (ms) | NerdGraph requests | Declared cost | NerdGraph response (KiB) | Result (KiB) |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const m of node) {
    const w = byTool.get(m.tool);
    const workersCell = w === undefined ? 'n/a' : `${fmt(w.overhead.p50)} / ${fmt(w.overhead.p95)}`;
    const note = m.error === undefined ? '' : ' (error)';
    lines.push(
      `| \`${m.tool}\`${note} | ${fmt(m.overhead.p50)} / ${fmt(m.overhead.p95)} | ${workersCell} | ${m.requests} | ${m.declaredCost} | ${kib(m.responseBytes)} | ${kib(m.resultBytes)} |`,
    );
  }
  lines.push(
    '',
    'Overhead is wall time minus the time inside the mock NerdGraph request, per call, so it is what relic-bridge adds',
    '(validation, document building, parsing, shaping, MCP framing). On Workers it stands in for CPU time. NerdGraph requests are',
    'also the external subrequests a Worker call spends. The sample count and the mean of 10 calls per sample average',
    'out the coarse (whole millisecond) workerd clock, so Workers figures below 1 ms are approximations.',
  );
  return lines.join('\n');
}

const root = fileURLToPath(new URL('..', import.meta.url));

function workerdVersion(): string | null {
  try {
    const dir = readdirSync(join(root, 'node_modules/.pnpm')).find((d) => d.startsWith('workerd@'));
    return dir === undefined ? null : dir.slice('workerd@'.length);
  } catch {
    return null;
  }
}

/** Runs the Workers project (`apps/worker/bench/tools.bench.ts`) and returns the harness rows. */
function runWorkers(): ToolMeasure[] {
  const dir = mkdtempSync(join(tmpdir(), 'rb-bench-tools-'));
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
        'tools.bench',
        '--reporter=json',
        `--outputFile=${out}`,
      ],
      { cwd: join(root, 'apps/worker'), stdio: ['ignore', 'inherit', 'inherit'], encoding: 'utf8' },
    );
    let report: {
      testResults: { assertionResults: { status: string; meta?: { tools?: ToolMeasure[] } }[] }[];
    };
    try {
      report = JSON.parse(readFileSync(out, 'utf8'));
    } catch {
      throw new Error(`the Workers benchmark did not produce a report (vitest exit ${res.status})`);
    }
    const a = report.testResults.flatMap((f) => f.assertionResults)[0];
    if (a?.status !== 'passed' || a.meta?.tools === undefined)
      throw new Error(`the Workers benchmark ${a?.status ?? 'did not run'}`);
    return a.meta.tools;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  const samples = flag('--samples');
  const node = await measureTools(samples === undefined ? {} : { samples: Number(samples) });
  const workers = args.includes('--node') ? null : runWorkers();
  const cpu = cpus();
  const env: Environment = {
    date: new Date().toISOString().slice(0, 10),
    machine: `${cpu[0]?.model.trim() ?? 'unknown CPU'}, ${cpu.length} threads, ${Math.round(totalmem() / 2 ** 30)} GiB`,
    node: process.versions.node,
    workerd: workers === null ? null : workerdVersion(),
  };
  const table = renderTable(env, node, workers);
  process.stdout.write(`${table}\n`);
  const out = flag('--out');
  if (out !== undefined) writeFileSync(out, `${table}\n`);
}
