// SPDX-License-Identifier: Apache-2.0
// P0-08 CIMD check with a real, public Client ID Metadata Document (Claude Code's), no registration call.
// Usage: node scripts/cimd.ts [baseUrl]. The server fetches the document from claude.ai.
import { createHash, randomBytes } from 'node:crypto';

const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
const BASE = process.argv[2] ?? 'http://127.0.0.1:8797';
const CLIENT_ID = 'https://claude.ai/oauth/claude-code-client-metadata';
let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function flow(redirectUri: string): Promise<void> {
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash('sha256').update(verifier).digest());
  const resource = `${BASE}/p/a/mcp`;
  const auth = new URL(`${BASE}/authorize`);
  auth.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st',
    scope: 'mcp:read offline_access',
    resource,
  }).toString();
  const res = await fetch(auth, { redirect: 'manual' });
  const loc = new URL(res.headers.get('location') ?? 'http://invalid/');
  const code = loc.searchParams.get('code');
  check(`CIMD authorize with ${redirectUri}`, !!code, code ? '' : `${res.status} ${await res.text()}`);
  if (!code) return;
  const tok = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      resource,
    }),
  });
  const json = (await tok.json()) as { access_token?: string; error?: string };
  check(`CIMD token exchange (${redirectUri})`, !!json.access_token, json.error ?? '');
}

await flow('http://127.0.0.1:49152/callback'); // RFC 8252 loopback, ephemeral port
await flow('http://localhost:53999/callback'); // Claude Code also uses localhost with any port
// Negative: a redirect not in the document must be refused.
const bad = new URL(`${BASE}/authorize`);
bad.search = new URLSearchParams({
  response_type: 'code',
  client_id: CLIENT_ID,
  redirect_uri: 'https://evil.example/callback',
  code_challenge: 'x'.repeat(43),
  code_challenge_method: 'S256',
  state: 'st',
  resource: `${BASE}/p/a/mcp`,
}).toString();
const badRes = await fetch(bad, { redirect: 'manual' });
check(
  'redirect URI outside CIMD document refused (no redirect)',
  badRes.status === 400,
  String(badRes.status),
);
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
