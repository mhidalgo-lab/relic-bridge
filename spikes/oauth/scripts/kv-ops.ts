// SPDX-License-Identifier: Apache-2.0
// Counts KV operations per OAuth step (Workers Free: 1,000 writes/day, 100,000 reads/day; each op also
// costs one subrequest). Runs the app in-process: node --import ./src/node-register.ts scripts/kv-ops.ts
import { createHash, randomBytes } from 'node:crypto';
import { type Env, handle } from '../src/app.ts';
import { SqliteKv } from '../src/kv-sqlite.ts';

const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
const counts = { get: 0, put: 0, delete: 0, list: 0 };
const kv = new SqliteKv();
const counted = new Proxy(kv, {
  get(target, prop: keyof typeof counts) {
    const value = Reflect.get(target, prop) as unknown;
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => {
      if (prop in counts) counts[prop]++;
      return (value as (...a: unknown[]) => unknown).apply(target, args);
    };
  },
});
const env = { OAUTH_KV: counted } as unknown as Env;
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;
const BASE = 'http://127.0.0.1:1';
const REDIRECT = 'http://127.0.0.1:5/cb';
const call = (url: string, init?: RequestInit): Promise<Response> =>
  handle(new Request(url, init), env, ctx, { cimd: false });

function step(name: string): void {
  console.log(
    `${name.padEnd(34)} get=${counts.get} put=${counts.put} delete=${counts.delete} list=${counts.list}`,
  );
  counts.get = counts.put = counts.delete = counts.list = 0;
}

const form = (body: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body),
});
const mcp = (token: string): RequestInit => ({
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
});

const reg = (await (
  await call(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'kv',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    }),
  })
).json()) as { client_id: string };
step('DCR registration');

const verifier = b64u(randomBytes(32));
const auth = new URL(`${BASE}/authorize`);
auth.search = new URLSearchParams({
  response_type: 'code',
  client_id: reg.client_id,
  redirect_uri: REDIRECT,
  code_challenge: b64u(createHash('sha256').update(verifier).digest()),
  code_challenge_method: 'S256',
  state: 's',
  scope: 'mcp:read offline_access',
  resource: `${BASE}/p/a/mcp`,
}).toString();
const code =
  new URL((await call(auth.toString())).headers.get('location') ?? '').searchParams.get('code') ?? '';
step('authorize + consent (first grant)');

const tok = (await (
  await call(
    `${BASE}/oauth/token`,
    form({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: reg.client_id,
      code_verifier: verifier,
    }),
  )
).json()) as { access_token: string; refresh_token: string };
step('code → token exchange');

const status = (await call(`${BASE}/p/a/mcp`, mcp(tok.access_token))).status;
step(`MCP call (token validation) [${status}]`);

const ref = (await (
  await call(
    `${BASE}/oauth/token`,
    form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id }),
  )
).json()) as { access_token: string };
step('refresh');

await call(`${BASE}/p/a/mcp`, mcp(ref.access_token));
step('MCP call with refreshed token');
