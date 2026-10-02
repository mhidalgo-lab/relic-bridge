// SPDX-License-Identifier: Apache-2.0
// P0-06 spike Worker: simulates relic-bridge's hot path for one MCP tool call.
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  Budget,
  bytesToB64,
  decryptSecret,
  encryptSecret,
  hashToken,
  importMasterKey,
  makeNrqlPayload,
  parseAndShape,
  readCapped,
  SIZES,
} from './hotpath.ts';

interface Env {
  DB: D1Database;
  NERDGRAPH: Fetcher;
  MASTER_KEY: string;
  RB_PLAN?: string;
  MAX_RESPONSE_BYTES?: string;
  ALLOW_SEED?: string;
}

interface Credential {
  id: string;
  key_iv: string;
  key_ct: string;
}

// Isolate-level cache of the imported CryptoKey only (no plaintext, no request data — THREAT_MODEL T21).
let masterKey: Promise<CryptoKey> | undefined;
const getMasterKey = (env: Env): Promise<CryptoKey> => {
  masterKey ??= importMasterKey(env.MASTER_KEY);
  return masterKey;
};

const NRQL_DOC =
  'query($accountId: Int!, $nrql: Nrql!) { actor { account(id: $accountId) { nrql(query: $nrql, timeout: 30) { results } } } }';

function buildServer(env: Env, cred: Credential, budget: Budget): McpServer {
  const server = new McpServer({ name: 'spike-workers-limits', version: '0.0.0' });
  server.registerTool(
    'run_nrql',
    {
      description: 'Spike: fetch a synthetic NRQL result of the given size and shape it.',
      inputSchema: z.object({ size: z.enum(['10k', '100k', '1m', '5m']) }),
      annotations: { readOnlyHint: true },
    },
    async ({ size }) => {
      const t0 = performance.now();
      const apiKey = await decryptSecret(await getMasterKey(env), cred.key_iv, cred.key_ct, `${cred.id}|1`);
      const t1 = performance.now();
      budget.spend();
      const res = await env.NERDGRAPH.fetch('https://mock-nerdgraph/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-key': apiKey, 'x-spike-size': size },
        body: JSON.stringify({
          query: NRQL_DOC,
          variables: { accountId: 1, nrql: 'SELECT * FROM Transaction SINCE 1 hour ago' },
        }),
      });
      const maxBytes = Number(env.MAX_RESPONSE_BYTES ?? 8 * 1024 * 1024);
      const { body, bytes } = await readCapped(res, maxBytes);
      const t2 = performance.now();
      const shaped = parseAndShape(body);
      const t3 = performance.now();
      const summary =
        `rows=${shaped.totalRows} shown=${shaped.shownRows} bytes=${bytes} subrequests=${budget.used} ` +
        `ms(decrypt=${(t1 - t0).toFixed(2)} fetch+read=${(t2 - t1).toFixed(2)} parse+shape=${(t3 - t2).toFixed(2)})`;
      return { content: [{ type: 'text', text: `${summary}\n\n${shaped.text.slice(0, 2000)}` }] };
    },
  );
  return server;
}

type Vars = { cred: Credential; budget: Budget; authMs: number };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.get('/health', (c) => c.text('ok'));

/** Local-only: create schema and seed one token + encrypted synthetic key. */
app.post('/seed', async (c) => {
  if (c.env.ALLOW_SEED !== '1') return c.text('disabled', 403);
  await c.env.DB.batch([
    c.env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, key_iv TEXT, key_ct TEXT)',
    ),
    c.env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS access_tokens (hash TEXT PRIMARY KEY, credential_id TEXT, project_slug TEXT)',
    ),
  ]);
  const token = `rb_spike_${bytesToB64(crypto.getRandomValues(new Uint8Array(32))).replace(/[^A-Za-z0-9]/g, '')}`;
  const { iv, ct } = await encryptSecret(
    await getMasterKey(c.env),
    'NRAK-SYNTHETICSPIKEKEYNOTREAL00',
    'cred-1|1',
  );
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT OR REPLACE INTO credentials VALUES (?, ?, ?)').bind('cred-1', iv, ct),
    c.env.DB.prepare('INSERT OR REPLACE INTO access_tokens VALUES (?, ?, ?)').bind(
      await hashToken(token),
      'cred-1',
      'demo',
    ),
  ]);
  return c.json({ token });
});

/** Pure-CPU micro-benchmark of each step (no network), timed with performance.now(). */
app.get('/bench', async (c) => {
  const size = c.req.query('size') ?? '100k';
  const iter = Math.min(Number(c.req.query('iter') ?? 5), 50);
  const bytes = SIZES[size];
  if (bytes === undefined) return c.text('unknown size', 400);
  const payload = makeNrqlPayload(bytes);
  const key = await getMasterKey(c.env);
  const { iv, ct } = await encryptSecret(key, 'NRAK-SYNTHETICSPIKEKEYNOTREAL00', 'cred-1|1');
  const ms = { hash: 0, decrypt: 0, parseShape: 0 };
  for (let i = 0; i < iter; i++) {
    let t = performance.now();
    await hashToken('rb_spike_exampletokenexampletokenexampletoken');
    ms.hash += performance.now() - t;
    t = performance.now();
    await decryptSecret(key, iv, ct, 'cred-1|1');
    ms.decrypt += performance.now() - t;
    t = performance.now();
    parseAndShape(payload);
    ms.parseShape += performance.now() - t;
  }
  return c.json({
    size,
    payloadBytes: payload.length,
    iter,
    avgMs: { hash: ms.hash / iter, decrypt: ms.decrypt / iter, parseShape: ms.parseShape / iter },
    note: 'Deployed Workers only advance performance.now() across I/O; pure-CPU timings read 0 there.',
  });
});

app.use('/p/:slug/mcp', async (c, next) => {
  const auth = c.req.header('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return c.text('unauthorized', 401);
  const t = performance.now();
  const budget = new Budget(c.env.RB_PLAN === 'paid' ? 1000 : 50);
  budget.spend(); // D1 lookup
  const cred = await c.env.DB.prepare(
    'SELECT c.id, c.key_iv, c.key_ct FROM access_tokens t JOIN credentials c ON c.id = t.credential_id WHERE t.hash = ? AND t.project_slug = ?',
  )
    .bind(await hashToken(auth.slice(7)), c.req.param('slug'))
    .first<Credential>();
  if (!cred) return c.text('unauthorized', 401);
  c.set('cred', cred);
  c.set('budget', budget);
  c.set('authMs', performance.now() - t);
  await next();
  c.header('x-rb-subrequests', String(budget.used));
  c.header('x-rb-auth-ms', c.get('authMs').toFixed(2));
});

app.all('/p/:slug/mcp', (c) => {
  const handler = createMcpHandler(() => buildServer(c.env, c.get('cred'), c.get('budget')), {
    legacy: 'stateless',
  });
  return handler.fetch(c.req.raw);
});

export default app;
