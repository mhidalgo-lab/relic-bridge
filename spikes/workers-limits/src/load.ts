// SPDX-License-Identifier: Apache-2.0
// P0-06 load generator for a *deployed* spike Worker (see deploy-and-measure.md).
// Usage: node src/load.ts <base-url> <token> [calls-per-size=50]
// Prints status counts (1102 = exceeded resource limits) and wall-time percentiles per payload size.
export {};

const [base, token, n = '50'] = process.argv.slice(2);
if (!base || !token) {
  console.error('Usage: node src/load.ts <base-url> <token> [calls-per-size]');
  process.exit(2);
}
const calls = Number(n);

async function call(size: string): Promise<{ status: number; ms: number; cf1102: boolean }> {
  const t = performance.now();
  const res = await fetch(`${base}/p/demo/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'run_nrql', arguments: { size } },
    }),
  });
  const text = await res.text();
  return {
    status: res.status,
    ms: performance.now() - t,
    cf1102: text.includes('1102') || text.includes('exceeded resource limits'),
  };
}

for (const size of ['10k', '100k', '1m', '5m']) {
  const ms: number[] = [];
  const statuses = new Map<string, number>();
  for (let i = 0; i < calls; i++) {
    const r = await call(size);
    ms.push(r.ms);
    const k = r.cf1102 ? `${r.status}/1102` : String(r.status);
    statuses.set(k, (statuses.get(k) ?? 0) + 1);
  }
  ms.sort((a, b) => a - b);
  const p = (q: number): string => (ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] ?? 0).toFixed(0);
  console.log(
    `${size}: statuses ${JSON.stringify(Object.fromEntries(statuses))} wall ms p50 ${p(0.5)} p95 ${p(0.95)}`,
  );
}
