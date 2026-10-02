// SPDX-License-Identifier: Apache-2.0
// P0-08 end-to-end OAuth client: discovery → DCR → PKCE authorize → token → MCP call → cross-slug
// negative → refresh → revocation, plus negative checks. Usage: node scripts/e2e.ts [baseUrl]
import { createHash, randomBytes } from 'node:crypto';

const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
const BASE = process.argv[2] ?? 'http://127.0.0.1:8797';
const REDIRECT = 'http://127.0.0.1:53682/callback';
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = b64u(randomBytes(32));
  return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) };
}

async function form(url: string, body: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
}

async function readMcp(res: Response): Promise<unknown> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    return data.length ? JSON.parse(data[data.length - 1] as string) : null;
  }
  return text ? JSON.parse(text) : null;
}

async function mcpCall(
  slug: string,
  token: string | undefined,
  method: string,
  params: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-11-25',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${BASE}/p/${slug}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

interface AsMeta {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
  authorization_response_iss_parameter_supported?: boolean;
  client_id_metadata_document_supported?: boolean;
  protected_resources?: string[];
}

async function authorizeAndToken(
  as: AsMeta,
  clientId: string,
  resource: string,
): Promise<{ access_token: string; refresh_token: string; resource?: string; iss: string | null }> {
  const { verifier, challenge } = pkce();
  const state = b64u(randomBytes(8));
  const u = new URL(as.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: 'mcp:read offline_access',
    resource,
  }).toString();
  const res = await fetch(u, { redirect: 'manual' });
  const loc = new URL(res.headers.get('location') ?? 'http://invalid/');
  if (loc.searchParams.get('state') !== state) throw new Error(`state mismatch (status ${res.status})`);
  const code = loc.searchParams.get('code');
  if (!code) throw new Error(`no code: ${loc.search}`);
  const tok = await form(as.token_endpoint, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource,
  });
  const json = (await tok.json()) as { access_token: string; refresh_token: string; resource?: string };
  if (!tok.ok) throw new Error(`token failed: ${JSON.stringify(json)}`);
  return { ...json, iss: loc.searchParams.get('iss') };
}

async function main(): Promise<void> {
  const resA = `${BASE}/p/a/mcp`;
  const resB = `${BASE}/p/b/mcp`;

  // 1. Unauthenticated request → 401 challenge naming the per-slug PRM (RFC 9728 §5.1).
  const unauth = await mcpCall('a', undefined, 'tools/list', {});
  const challenge = unauth.headers.get('www-authenticate') ?? '';
  const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  check('401 without token', unauth.status === 401, challenge);
  check(
    'challenge points at per-path PRM',
    prmUrl === `${BASE}/.well-known/oauth-protected-resource/p/a/mcp`,
    prmUrl ?? '(none)',
  );

  // 2. Protected Resource Metadata.
  const prm = (await (await fetch(prmUrl ?? '')).json()) as {
    resource: string;
    authorization_servers: string[];
  };
  check('PRM resource = /p/a/mcp', prm.resource === resA);
  const prmB = (await (await fetch(`${BASE}/.well-known/oauth-protected-resource/p/b/mcp`)).json()) as {
    resource: string;
  };
  check('PRM for slug b is distinct', prmB.resource === resB);

  // 3. Authorization server metadata (RFC 8414).
  const issuer = prm.authorization_servers[0] ?? '';
  const as = (await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json()) as AsMeta;
  check('AS metadata: issuer', as.issuer === issuer, as.issuer);
  check('AS metadata: PKCE S256 only', JSON.stringify(as.code_challenge_methods_supported) === '["S256"]');
  check('AS metadata: RFC 9207 iss supported', as.authorization_response_iss_parameter_supported === true);
  check(
    'AS metadata: CIMD advertised',
    as.client_id_metadata_document_supported === true,
    String(as.client_id_metadata_document_supported),
  );
  check('AS metadata: protected_resources lists both slugs', !!as.protected_resources?.includes(resB));

  // 4. Dynamic Client Registration (RFC 7591), public client.
  const reg = await fetch(as.registration_endpoint ?? '', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'spike e2e',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const client = (await reg.json()) as { client_id: string };
  check('DCR registered public client', reg.status === 201 && !!client.client_id, `status ${reg.status}`);

  // 5–6. Authorize (PKCE) + token for slug a.
  const a = await authorizeAndToken(as, client.client_id, resA);
  check('authorization response carries iss = issuer (RFC 9207)', a.iss === issuer, String(a.iss));
  check('token response names resource a', a.resource === resA, String(a.resource));

  // 7. MCP call with token A at slug a.
  const list = await mcpCall('a', a.access_token, 'tools/list', {});
  const listJson = (await readMcp(list)) as { result?: { tools?: { name: string }[] } };
  check(
    'tools/list at /p/a/mcp with token A',
    list.status === 200 && !!listJson.result?.tools?.some((t) => t.name === 'echo'),
    `status ${list.status}`,
  );
  const call = await mcpCall('a', a.access_token, 'tools/call', {
    name: 'echo',
    arguments: { message: 'hi' },
  });
  const callJson = (await readMcp(call)) as { result?: { content?: { text: string }[] } };
  const echoed = JSON.parse(callJson.result?.content?.[0]?.text ?? '{}') as { project?: string };
  check('echo sees grant bound to project a', echoed.project === 'a', JSON.stringify(echoed));

  // 8. Cross-slug negative: token for a presented at b.
  const cross = await mcpCall('b', a.access_token, 'tools/list', {});
  check('token A rejected at /p/b/mcp (RFC 8707 audience)', cross.status === 401, `status ${cross.status}`);

  // 9. A second grant for b, same client; grant a must survive.
  const b = await authorizeAndToken(as, client.client_id, resB);
  const bOk = await mcpCall('b', b.access_token, 'tools/list', {});
  check('token B accepted at /p/b/mcp', bOk.status === 200);
  const aStill = await mcpCall('a', a.access_token, 'tools/list', {});
  check('grant a not revoked by grant b', aStill.status === 200);

  // 10. Refresh rotation; retargeting the resource on refresh must fail.
  const retarget = await form(as.token_endpoint, {
    grant_type: 'refresh_token',
    refresh_token: a.refresh_token,
    client_id: client.client_id,
    resource: resB,
  });
  const retargetJson = (await retarget.json()) as { error?: string };
  check(
    'refresh cannot retarget a → b',
    retargetJson.error === 'invalid_target',
    JSON.stringify(retargetJson),
  );
  const ref = await form(as.token_endpoint, {
    grant_type: 'refresh_token',
    refresh_token: a.refresh_token,
    client_id: client.client_id,
  });
  const refJson = (await ref.json()) as { access_token?: string; refresh_token?: string };
  check(
    'refresh issues new tokens',
    ref.ok && !!refJson.access_token && refJson.refresh_token !== a.refresh_token,
  );
  const afterRefresh = await mcpCall('a', refJson.access_token, 'tools/list', {});
  check('refreshed access token works', afterRefresh.status === 200);

  // 11. Unknown resource at authorize → invalid_target (no grant created).
  const { challenge: c2 } = pkce();
  const bad = new URL(as.authorization_endpoint);
  bad.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: c2,
    code_challenge_method: 'S256',
    state: 's',
    resource: `${BASE}/p/zzz/mcp`,
  }).toString();
  const badRes = await fetch(bad, { redirect: 'manual' });
  const badLoc = badRes.headers.get('location') ?? '';
  check(
    'unknown resource rejected',
    badLoc.includes('error=invalid_target') || badRes.status === 400,
    badLoc || String(badRes.status),
  );

  // 12. PKCE plain / missing must fail for a public client.
  const plain = new URL(bad);
  plain.searchParams.set('resource', resA);
  plain.searchParams.set('code_challenge_method', 'plain');
  const plainRes = await fetch(plain, { redirect: 'manual' });
  check(
    'PKCE plain rejected',
    !(plainRes.headers.get('location') ?? '').includes('code='),
    String(plainRes.status),
  );
  const nopkce = new URL(plain);
  nopkce.searchParams.delete('code_challenge');
  nopkce.searchParams.delete('code_challenge_method');
  const nopkceRes = await fetch(nopkce, { redirect: 'manual' });
  check(
    'missing PKCE rejected',
    !(nopkceRes.headers.get('location') ?? '').includes('code='),
    String(nopkceRes.status),
  );

  // 13. Runtime project creation: servers are rebuilt per request; existing tokens keep working.
  const add = await fetch(`${BASE}/_spike/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'c' }),
  });
  check('project c added at runtime', add.ok);
  const c = await authorizeAndToken(as, client.client_id, `${BASE}/p/c/mcp`);
  check(
    'token for new project c works',
    (await mcpCall('c', c.access_token, 'tools/list', {})).status === 200,
  );
  check(
    'token A still valid after project list changed',
    (await mcpCall('a', refJson.access_token, 'tools/list', {})).status === 200,
  );

  // 14. CIMD with a non-https client_id (local) — expected to be refused (HTTPS required by the draft).
  const cimd = new URL(as.authorization_endpoint);
  cimd.search = new URLSearchParams({
    response_type: 'code',
    client_id: `${BASE}/clients/spike-cli.json`,
    redirect_uri: REDIRECT,
    code_challenge: c2,
    code_challenge_method: 'S256',
    state: 's',
    resource: resA,
  }).toString();
  const cimdRes = await fetch(cimd, { redirect: 'manual' });
  check(
    'CIMD http://localhost client_id refused (expected; https-only)',
    !(cimdRes.headers.get('location') ?? '').includes('code='),
    `${cimdRes.status} ${(await cimdRes.text()).slice(0, 80)}`,
  );

  // 15. Revocation (RFC 7009).
  if (as.revocation_endpoint) {
    const rev = await form(as.revocation_endpoint, {
      token: refJson.access_token ?? '',
      client_id: client.client_id,
    });
    check('revocation endpoint accepts', rev.ok, `status ${rev.status}`);
    const afterRev = await mcpCall('a', refJson.access_token, 'tools/list', {});
    check('revoked access token rejected', afterRev.status === 401, `status ${afterRev.status}`);
  } else {
    check('revocation endpoint advertised', false);
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
