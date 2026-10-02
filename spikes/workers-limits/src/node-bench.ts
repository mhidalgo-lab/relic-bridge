// SPDX-License-Identifier: Apache-2.0
// P0-06 Node cross-check: same V8 engine as workerd, precise timers + process.cpuUsage().
// Runs (a) each pure step and (b) the full Worker app (Hono + SDK v2 handler + tool) with fake bindings,
// so we can estimate the CPU a real tool call costs. Network/D1 latency is excluded by construction.
import { cpuUsage } from 'node:process';
import {
  decryptSecret,
  encryptSecret,
  hashToken,
  importMasterKey,
  makeNrqlPayload,
  parseAndShape,
  readCapped,
  SIZES,
} from './hotpath.ts';
import app from './worker.ts';

const ITER = 30;
const WARMUP = 5;
const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};
const fmt = (xs: number[]): string => `p50 ${pct(xs, 50).toFixed(2)} / p95 ${pct(xs, 95).toFixed(2)}`;

async function cpuMs(fn: () => Promise<unknown>): Promise<number> {
  const start = cpuUsage();
  await fn();
  const d = cpuUsage(start);
  return (d.user + d.system) / 1000;
}

const masterB64 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const key = await importMasterKey(masterB64);
const sealed = await encryptSecret(key, 'NRAK-SYNTHETICSPIKEKEYNOTREAL00', 'cred-1|1');
const TOKEN = 'rb_spike_exampletokenexampletokenexampletoken';
const tokenHash = await hashToken(TOKEN);

// Fake bindings: D1 returns the credential row, NERDGRAPH returns the synthetic payload.
const payloads = new Map(Object.entries(SIZES).map(([k, v]) => [k, makeNrqlPayload(v)]));
const env = {
  MASTER_KEY: masterB64,
  RB_PLAN: 'free',
  DB: {
    prepare: () => ({
      bind: (hash: string) => ({
        first: async () =>
          hash === tokenHash ? { id: 'cred-1', key_iv: sealed.iv, key_ct: sealed.ct } : null,
      }),
    }),
  },
  NERDGRAPH: {
    fetch: async (_url: string, init: RequestInit) => {
      const size = new Headers(init.headers).get('x-spike-size') ?? '10k';
      return new Response(payloads.get(size), { headers: { 'content-type': 'application/json' } });
    },
  },
};

async function toolCall(size: string): Promise<string> {
  const res = await app.fetch(
    new Request('http://local/p/demo/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'run_nrql', arguments: { size } },
      }),
    }),
    env,
  );
  return res.text();
}

const rows: string[] = [];
rows.push(
  '| payload | hash | decrypt | readCapped | parse+shape | full tool call (CPU ms) | full tool call (wall ms) |',
);
rows.push('|---|---|---|---|---|---|---|');
for (const [size, payload] of payloads) {
  const t = { hash: [] as number[], decrypt: [] as number[], read: [] as number[], shape: [] as number[] };
  const full: number[] = [];
  const wall: number[] = [];
  for (let i = 0; i < WARMUP + ITER; i++) {
    const h = await cpuMs(() => hashToken(TOKEN));
    const d = await cpuMs(() => decryptSecret(key, sealed.iv, sealed.ct, 'cred-1|1'));
    const r = await cpuMs(() => readCapped(new Response(payload), 8 * 1024 * 1024));
    const s = await cpuMs(async () => parseAndShape(payload));
    const w0 = performance.now();
    let body = '';
    const f = await cpuMs(async () => {
      body = await toolCall(size);
    });
    const w = performance.now() - w0;
    if (i === 0 && !body.includes('rows=')) throw new Error(`tool call failed: ${body.slice(0, 300)}`);
    if (i >= WARMUP) {
      t.hash.push(h);
      t.decrypt.push(d);
      t.read.push(r);
      t.shape.push(s);
      full.push(f);
      wall.push(w);
    }
  }
  rows.push(
    `| ${size} (${payload.length} B) | ${fmt(t.hash)} | ${fmt(t.decrypt)} | ${fmt(t.read)} | ${fmt(t.shape)} | ${fmt(full)} | ${fmt(wall)} |`,
  );
}

// Cold path: first call in a fresh "isolate" includes master-key import and SDK/zod schema setup.
console.log(
  `Node ${process.version}, ${ITER} iterations after ${WARMUP} warmup (CPU = process.cpuUsage user+system)\n`,
);
console.log(rows.join('\n'));
