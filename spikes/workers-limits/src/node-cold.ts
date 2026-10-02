// SPDX-License-Identifier: Apache-2.0
// P0-06: CPU of the *first* tool call in a fresh process (closest Node analogue of a cold isolate).
// Module evaluation (imports) is excluded, as Workers bill global-scope work to startup, not to the request.
import { cpuUsage } from 'node:process';
import { encryptSecret, hashToken, importMasterKey, makeNrqlPayload } from './hotpath.ts';
import app from './worker.ts';

const masterB64 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const sealed = await encryptSecret(
  await importMasterKey(masterB64),
  'NRAK-SYNTHETICSPIKEKEYNOTREAL00',
  'cred-1|1',
);
const tokenHash = await hashToken('rb_spike_cold');
const payload = makeNrqlPayload(10 * 1024);
const env = {
  MASTER_KEY: masterB64,
  DB: {
    prepare: () => ({
      bind: () => ({ first: async () => ({ id: 'cred-1', key_iv: sealed.iv, key_ct: sealed.ct }) }),
    }),
  },
  NERDGRAPH: { fetch: async () => new Response(payload) },
};
void tokenHash;
const start = cpuUsage();
const res = await app.fetch(
  new Request('http://local/p/demo/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer rb_spike_cold',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'run_nrql', arguments: { size: '10k' } },
    }),
  }),
  env,
);
await res.text();
const d = cpuUsage(start);
console.log(`first tool call (10k payload) CPU ms: ${((d.user + d.system) / 1000).toFixed(2)}`);
