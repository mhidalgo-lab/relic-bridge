// SPDX-License-Identifier: Apache-2.0
// Per-tool overhead and cost harness (P8-03). Runtime-neutral (no `node:*`): the same code runs under Node
// (`scripts/bench-tools.ts`) and inside workerd (`apps/worker/bench/tools.bench.ts`).
//
// Every built-in tool is called through an in-memory MCP client with the contract tests' sample arguments, against the
// recorded-fixture NerdGraph mock. Request counts come from the mock's recording and are compared with the tool's
// declared `cost` (P6-20); nothing is counted a second way.
import {
  createBudget,
  createBuiltinTools,
  type FetchLike,
  type ToolDefinition,
} from '../../packages/core/src/index.ts';
import { testContext } from '../../packages/core/test/helpers/context.ts';
import { connectInMemory } from '../../packages/core/test/helpers/mcp.ts';
import { MOCK_ACCOUNT, mockNerdGraph } from '../../packages/core/test/helpers/mock-nerdgraph.ts';
import { SAMPLE_CALLS } from '../../packages/core/test/helpers/sample-calls.ts';

/** One tool's measurements on one runtime. Times are milliseconds of relic-bridge's own work per call. */
export interface ToolMeasure {
  readonly tool: string;
  /** Declared cost (budget units a call may spend). */
  readonly declaredCost: number;
  /** NerdGraph requests one call sent (the Workers external subrequests). */
  readonly requests: number;
  /** NerdGraph response bytes one call received. */
  readonly responseBytes: number;
  /** Bytes of the tool result returned to the client. */
  readonly resultBytes: number;
  readonly overhead: { readonly p50: number; readonly p95: number; readonly mean: number };
  readonly samples: number;
  /** Set when the call ended in a tool error (the row is then not a normal run). */
  readonly error?: string;
}

export interface HarnessOptions {
  /** Timed samples per tool (each the average of `batch` calls). */
  readonly samples?: number;
  readonly warmup?: number;
  /** Calls per timed sample; averages out a coarse clock (workerd ticks in whole milliseconds). */
  readonly batch?: number;
  /** Simulated New Relic time per request; it is excluded from the overhead. Default 0. */
  readonly latencyMs?: number;
  /** Restrict to these tools. */
  readonly only?: readonly string[];
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Quantile of an unsorted list (nearest rank, lower). */
export function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

async function connect(fetch: FetchLike): Promise<Awaited<ReturnType<typeof connectInMemory>>> {
  return connectInMemory(createBuiltinTools({ fetch, sleep: async () => {} }), () =>
    testContext({
      accounts: { allowed: [MOCK_ACCOUNT], default: MOCK_ACCOUNT },
      budget: createBudget(500),
      clock: { now: () => 1790943448000 },
    }),
  );
}

/** Measures one tool. `now` is injectable for tests. */
export async function measureTool(
  tool: ToolDefinition,
  opts: HarnessOptions = {},
  now: () => number = () => performance.now(),
): Promise<ToolMeasure> {
  const args = SAMPLE_CALLS[tool.name] ?? {};
  const latency = opts.latencyMs ?? 0;
  const batch = opts.batch ?? 10;

  // Pass 1 (untimed): request count and bytes, from the mock's own recording.
  const mock = mockNerdGraph();
  let responseBytes = 0;
  const counting: FetchLike = async (url, init) => {
    const res = await mock.fetch(url, init);
    responseBytes += (await res.clone().text()).length;
    return res;
  };
  const first = await connect(counting);
  const result = await first.callTool({ name: tool.name, arguments: args });
  await first.close();
  const resultBytes = JSON.stringify(result.content).length;

  // Pass 2 (timed): wall time minus the time spent inside the mock (and its simulated latency).
  let inside = 0;
  const timedMock = mockNerdGraph();
  const timed: FetchLike = async (url, init) => {
    const t0 = now();
    const res = await timedMock.fetch(url, init);
    if (latency > 0) await wait(latency);
    inside += now() - t0;
    return res;
  };
  const client = await connect(timed);
  try {
    for (let i = 0; i < (opts.warmup ?? 5); i++) await client.callTool({ name: tool.name, arguments: args });
    const samples: number[] = [];
    for (let i = 0; i < (opts.samples ?? 30); i++) {
      inside = 0;
      const start = now();
      for (let j = 0; j < batch; j++) await client.callTool({ name: tool.name, arguments: args });
      samples.push(Math.max(0, now() - start - inside) / batch);
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    return {
      tool: tool.name,
      declaredCost: tool.cost,
      requests: mock.calls.length,
      responseBytes,
      resultBytes,
      overhead: { p50: quantile(samples, 0.5), p95: quantile(samples, 0.95), mean },
      samples: samples.length,
      ...(result.isError === true ? { error: 'tool error' } : {}),
    };
  } finally {
    await client.close();
  }
}

/** Measures every built-in tool (or `opts.only`). */
export async function measureTools(opts: HarnessOptions = {}): Promise<ToolMeasure[]> {
  const out: ToolMeasure[] = [];
  for (const tool of createBuiltinTools({ fetch: async () => new Response('{}') })) {
    if (opts.only !== undefined && !opts.only.includes(tool.name)) continue;
    out.push(await measureTool(tool, opts));
  }
  return out;
}
