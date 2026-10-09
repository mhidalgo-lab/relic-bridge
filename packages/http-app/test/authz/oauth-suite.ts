// SPDX-License-Identifier: Apache-2.0
// The OAuth 2.1 integration suite (P5-01), ported from the P0-08 spike (`spikes/oauth/scripts/e2e.ts`) and extended
// with the authorization checks that matter here: single-use codes, PKCE S256 only, RFC 8707 audience per slug,
// refresh can't retarget, and OAuth tokens going through the same deny-by-default resolver as device tokens.
// Runs on every authz host: the HTTP app on memory storage (Node), the CLI's SQLite storage (Node), and the Worker
// on local D1 (workerd). Web-standard only. The consent step is a test stand-in (the real one is P5-04).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthApproval, OAuthAuthorizationRequest, OAuthConsentHandler } from '../../src/index.ts';
import {
  ADMIN_TOKEN,
  type AuthzApp,
  type Captured,
  createHarness,
  type Harness,
  PUBLIC_ORIGIN,
} from './harness.ts';
import { MCP_ROUTES, OAUTH_ROUTES, type RouteCase, requestFor } from './matrix.ts';

const ISSUER = PUBLIC_ORIGIN;
const REDIRECT = 'http://127.0.0.1:53682/callback';
const resourceOf = (slug: string): string => `${ISSUER}/p/${slug}/mcp`;

const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64u(digest) };
}

/** What the stand-in consent does with the next authorization request. */
type Decision = { readonly userId: string; readonly grantId: string } | 'deny';

interface Consent {
  next: Decision | null;
  readonly seen: OAuthAuthorizationRequest[];
  readonly results: OAuthApproval[];
  readonly handler: OAuthConsentHandler;
}

function consentStandIn(): Consent {
  const state: Consent = {
    next: null,
    seen: [],
    results: [],
    handler: async (_c, api) => {
      state.seen.push(api.request);
      const decision = state.next;
      if (decision === null) return new Response('{"error":"no_decision"}', { status: 409 });
      if (decision === 'deny') return Response.redirect(api.deny(), 302);
      const result = await api.approve(decision);
      state.results.push(result);
      if (!result.ok) return new Response(JSON.stringify({ refused: result.reason }), { status: 403 });
      return new Response(null, { status: 302, headers: { location: result.redirectTo } });
    },
  };
  return state;
}

interface Tokens {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
  readonly resource?: string;
}

/** OAuth client steps against one app. */
class Client {
  clientId = '';
  constructor(
    private readonly h: Harness,
    private readonly app: AuthzApp,
    private readonly secrets: string[],
  ) {}

  async send(request: Request): Promise<Captured> {
    return this.h.send(request, this.app);
  }

  form(path: string, body: Record<string, string>): Promise<Captured> {
    return this.send(
      new Request(`${ISSUER}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      }),
    );
  }

  async register(redirectUris: readonly string[] = [REDIRECT]): Promise<string> {
    const res = await this.send(
      new Request(`${ISSUER}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'authz test client',
          redirect_uris: redirectUris,
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
      }),
    );
    expect(res.status, res.text).toBe(201);
    this.clientId = (JSON.parse(res.text) as { client_id: string }).client_id;
    return this.clientId;
  }

  authorizeUrl(params: Record<string, string | undefined>): string {
    const u = new URL(`${ISSUER}/oauth/authorize`);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: REDIRECT,
      state: 'st-123',
      scope: 'mcp:read offline_access',
      ...params,
    })) {
      if (v !== undefined) u.searchParams.set(k, v);
    }
    return u.toString();
  }

  /** Authorize (the consent stand-in decides) and return the redirect it produced. */
  async authorize(slug: string, extra: Record<string, string | undefined> = {}) {
    const { verifier, challenge } = await pkce();
    const res = await this.send(
      new Request(
        this.authorizeUrl({
          code_challenge: challenge,
          code_challenge_method: 'S256',
          resource: resourceOf(slug),
          ...extra,
        }),
      ),
    );
    const location = res.headers.get('location');
    const url = location === null ? null : new URL(location);
    const code = url?.searchParams.get('code') ?? null;
    if (code !== null) this.secrets.push(code);
    return { res, url, code, verifier };
  }

  async exchange(code: string, verifier: string, resource: string): Promise<Captured> {
    const res = await this.form('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: this.clientId,
      code_verifier: verifier,
      resource,
    });
    if (res.status === 200) {
      const t = JSON.parse(res.text) as Tokens;
      this.secrets.push(t.access_token, t.refresh_token);
    }
    return res;
  }

  /** register-less: authorize + exchange for `slug`; fails the test unless both succeed. */
  async tokens(slug: string): Promise<Tokens> {
    const { code, verifier, res } = await this.authorize(slug);
    expect(code, `authorize: ${res.status} ${res.text} ${res.headers.get('location')}`).not.toBeNull();
    const tok = await this.exchange(code as string, verifier, resourceOf(slug));
    expect(tok.status, tok.text).toBe(200);
    return JSON.parse(tok.text) as Tokens;
  }

  mcp(slug: string, token: string, route: RouteCase = MCP_ROUTES[0] as RouteCase): Promise<Captured> {
    return this.send(requestFor(route, { headers: { authorization: `Bearer ${token}` }, slug }));
  }
}

const WHOAMI = (id = 2) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'whoami', arguments: {} },
});

/** The generic denial every MCP refusal must equal (status, headers apart from the request id, body). */
function observable(r: Captured): string {
  const headers = [...r.headers.entries()]
    .filter(([name]) => name !== 'x-request-id')
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({ status: r.status, headers, body: r.text });
}

export function oauthSuite(): void {
  let h: Harness;
  let consent: Consent;
  let app: AuthzApp;
  let client: Client;
  /** Every OAuth secret the suite saw (codes, access and refresh tokens): never in a log line or an audit row. */
  let secrets: string[];

  beforeEach(async () => {
    h = await createHarness();
    // The provider reads `Date.now()`; keep it on the world's clock (the Worker host already does).
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['Date'], now: h.world.clock.now() });
    consent = consentStandIn();
    secrets = [];
    app = h.makeApp({ oauth: { consent: consent.handler, accessTokenTtlSeconds: 600 } });
    client = new Client(h, app, secrets);
    consent.next = { userId: 'usr_a', grantId: h.world.grantIds.prod };
  });

  afterEach(async () => {
    await h.scan();
    const audit = JSON.stringify(await h.auditRows());
    const logs = h.logLines.join('\n');
    for (const s of secrets) {
      expect(logs.includes(s), 'an OAuth secret reached a log line').toBe(false);
      expect(audit.includes(s), 'an OAuth secret reached the audit log').toBe(false);
    }
    vi.useRealTimers();
  });

  const advance = (ms: number): void => {
    h.world.clock.advance(ms);
    vi.setSystemTime(h.world.clock.now());
  };

  /** A request with no credentials: the reference denial. */
  const reference = (slug = 'prod') =>
    h.send(requestFor(MCP_ROUTES[0] as RouteCase, { headers: {}, slug }), app);

  async function expectGenericDenial(res: Captured, reason: string): Promise<void> {
    expect(res.status).toBe(401);
    expect(observable(res)).toBe(observable(await reference()));
    const row = await h.deniedRow(res.requestId as string);
    expect(row).toMatchObject({ kind: 'auth', status: 'denied', errorCode: reason });
  }

  describe('OAuth 2.1 authorization server (P5-01)', () => {
    it('publishes RFC 8414 metadata for the configured issuer: S256 only, iss supported, no CIMD yet', async () => {
      const res = await client.send(new Request(`${ISSUER}/.well-known/oauth-authorization-server`));
      expect(res.status).toBe(200);
      const meta = JSON.parse(res.text) as Record<string, unknown>;
      expect(meta).toMatchObject({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        registration_endpoint: `${ISSUER}/oauth/register`,
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
        response_types_supported: ['code'],
      });
      expect(meta['client_id_metadata_document_supported'] ?? false).toBe(false);
      // The placeholder resource of project-less routes is never advertised.
      expect(res.text).not.toContain('/p/-/mcp');
    });

    it('full flow: DCR → PKCE authorize (state, iss) → code → token → MCP tool call, audited with the client', async () => {
      await client.register();
      const { url, code, verifier } = await client.authorize('prod');
      expect(url?.origin + (url?.pathname ?? '')).toBe(REDIRECT);
      expect(url?.searchParams.get('state')).toBe('st-123');
      expect(url?.searchParams.get('iss')).toBe(ISSUER);
      expect(consent.seen[0]).toMatchObject({
        clientId: client.clientId,
        clientName: 'authz test client',
        redirectHost: '127.0.0.1:53682',
        resource: resourceOf('prod'),
        projectSlug: 'prod',
        scope: ['mcp:read', 'offline_access'],
      });
      const tok = await client.exchange(code as string, verifier, resourceOf('prod'));
      expect(tok.status, tok.text).toBe(200);
      const t = JSON.parse(tok.text) as Tokens;
      expect(t).toMatchObject({ expires_in: 600, resource: resourceOf('prod') });
      expect(tok.headers.get('cache-control')).toContain('no-store');

      expect((await client.mcp('prod', t.access_token)).status).toBe(200);
      const call = await client.send(
        new Request(`${ISSUER}/p/prod/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${t.access_token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2025-11-25',
          },
          body: JSON.stringify(WHOAMI()),
        }),
      );
      expect(call.status).toBe(200);
      expect(call.text).toContain('alpha');
      let row: Record<string, unknown> | undefined;
      await vi.waitFor(async () => {
        row = (await h.auditRows()).find((r) => r.kind === 'tool_call' && r.action === 'whoami') as
          | Record<string, unknown>
          | undefined;
        if (row === undefined) throw new Error('no tool_call row');
      });
      expect(row).toMatchObject({
        clientId: client.clientId,
        grantId: h.world.grantIds.prod,
        userId: 'usr_a',
        projectId: h.world.projectIds.prod,
      });
      expect(String(row?.['tokenId'])).toMatch(/^oauth_[A-Za-z0-9_-]{16}$/);
    });

    it('device tokens (rb_…) keep working next to OAuth', async () => {
      const res = await client.mcp('prod', h.world.tokens.prod);
      expect(res.status).toBe(200);
    });

    it('RFC 8707: a token for one slug is the generic 401 on another, and refresh cannot retarget', async () => {
      await client.register();
      const t = await client.tokens('prod');
      await expectGenericDenial(await client.mcp('eu', t.access_token), 'oauth_invalid');
      await expectGenericDenial(await client.mcp('no-such-project', t.access_token), 'oauth_invalid');
      const retarget = await client.form('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id: client.clientId,
        resource: resourceOf('eu'),
      });
      expect(retarget.status).toBe(400);
      expect(JSON.parse(retarget.text)).toMatchObject({ error: 'invalid_target' });
    });

    it('refresh issues a new access token for the same project; revocation (RFC 7009) ends it', async () => {
      await client.register();
      const t = await client.tokens('prod');
      const refreshed = await client.form('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id: client.clientId,
        resource: resourceOf('prod'),
      });
      expect(refreshed.status, refreshed.text).toBe(200);
      const r = JSON.parse(refreshed.text) as Tokens;
      secrets.push(r.access_token, r.refresh_token);
      expect(r.access_token).not.toBe(t.access_token);
      expect((await client.mcp('prod', r.access_token)).status).toBe(200);
      const revoked = await client.form('/oauth/token', {
        token: r.access_token,
        token_type_hint: 'access_token',
        client_id: client.clientId,
      });
      expect(revoked.status).toBe(200);
      await expectGenericDenial(await client.mcp('prod', r.access_token), 'oauth_invalid');
    });

    it('an expired access token is the generic 401', async () => {
      await client.register();
      const t = await client.tokens('prod');
      advance(601_000);
      await expectGenericDenial(await client.mcp('prod', t.access_token), 'oauth_invalid');
    });

    it('a code works once: a replay is refused and revokes the grant it was issued for (T9)', async () => {
      await client.register();
      const { code, verifier } = await client.authorize('prod');
      const first = await client.exchange(code as string, verifier, resourceOf('prod'));
      expect(first.status).toBe(200);
      const access = (JSON.parse(first.text) as Tokens).access_token;
      expect((await client.mcp('prod', access)).status).toBe(200);
      const replay = await client.exchange(code as string, verifier, resourceOf('prod'));
      expect(replay.status).toBe(400);
      expect(JSON.parse(replay.text)).toMatchObject({ error: 'invalid_grant' });
      await expectGenericDenial(await client.mcp('prod', access), 'oauth_invalid');
    });

    it('concurrent redemptions of one code yield at most one token set', async () => {
      await client.register();
      const { code, verifier } = await client.authorize('prod');
      const results = await Promise.all(
        Array.from({ length: 6 }, () => client.exchange(code as string, verifier, resourceOf('prod'))),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 400)).toHaveLength(5);
    });

    it('repeated parameters are refused (the code consumed is the code exchanged)', async () => {
      await client.register();
      const first = await client.authorize('prod');
      const second = await client.authorize('prod');
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: first.code as string,
        redirect_uri: REDIRECT,
        client_id: client.clientId,
        code_verifier: second.verifier,
        resource: resourceOf('prod'),
      });
      body.append('code', second.code as string);
      const res = await client.send(
        new Request(`${ISSUER}/oauth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
          body: body.toString(),
        }),
      );
      expect(res.status).toBe(400);
      expect(JSON.parse(res.text)).toMatchObject({ error: 'invalid_request' });
      const doubled = new URL(
        client.authorizeUrl({ code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' }),
      );
      doubled.searchParams.set('resource', resourceOf('prod'));
      doubled.searchParams.append('redirect_uri', 'https://evil.example/cb');
      const auth = await client.send(new Request(doubled));
      expect(auth.status).toBe(400);
      expect(auth.headers.get('location')).toBeNull();
      // Both codes are still fresh: nothing was consumed by the refused requests.
      expect((await client.exchange(second.code as string, second.verifier, resourceOf('prod'))).status).toBe(
        200,
      );
    });

    it('a code exchanged with a wrong verifier is burnt (an intercepted code is useless)', async () => {
      await client.register();
      const { code, verifier } = await client.authorize('prod');
      const wrong = await client.exchange(code as string, `${verifier}x`, resourceOf('prod'));
      expect(wrong.status).toBe(400);
      const right = await client.exchange(code as string, verifier, resourceOf('prod'));
      expect(right.status).toBe(400);
    });

    it('PKCE is required and S256 only; the error goes back to the registered redirect with state and iss', async () => {
      await client.register();
      const plain = await client.authorize('prod', {
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'plain',
      });
      const missing = await client.authorize('prod', {
        code_challenge: undefined,
        code_challenge_method: undefined,
      });
      for (const r of [plain, missing]) {
        expect(r.res.status).toBe(302);
        expect(r.code).toBeNull();
        expect(r.url?.origin + (r.url?.pathname ?? '')).toBe(REDIRECT);
        expect(r.url?.searchParams.get('error')).toBe('invalid_request');
        expect(r.url?.searchParams.get('state')).toBe('st-123');
        expect(r.url?.searchParams.get('iss')).toBe(ISSUER);
      }
      expect(consent.seen).toEqual([]);
    });

    it('resource is required and must be one of our MCP endpoints (refused before any redirect)', async () => {
      await client.register();
      const cases = [
        { resource: undefined },
        { resource: 'https://evil.example/p/prod/mcp' },
        { resource: `${ISSUER}/p/prod/mcp/extra` },
        { resource: `${ISSUER}/p/PROD/mcp` },
        { resource: `${ISSUER}/admin` },
      ];
      for (const extra of cases) {
        const r = await client.authorize('prod', extra);
        expect(r.res.status, JSON.stringify(extra)).toBe(400);
        expect(r.res.headers.get('location')).toBeNull();
        expect(JSON.parse(r.res.text)).toMatchObject({ error: 'invalid_target' });
      }
      // Two resources at once: refused too.
      const u = new URL(
        client.authorizeUrl({ code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' }),
      );
      u.searchParams.append('resource', resourceOf('prod'));
      u.searchParams.append('resource', resourceOf('eu'));
      expect((await client.send(new Request(u))).status).toBe(400);
      expect(consent.seen).toEqual([]);
    });

    it('an unregistered redirect URI or unknown client is a 400 page, never a redirect (no open redirect)', async () => {
      await client.register();
      const foreign = await client.authorize('prod', { redirect_uri: 'https://evil.example/cb' });
      expect(foreign.res.status).toBe(400);
      expect(foreign.res.headers.get('location')).toBeNull();
      const unknown = await client.authorize('prod', { client_id: 'no-such-client' });
      expect(unknown.res.status).toBe(400);
      expect(unknown.res.headers.get('location')).toBeNull();
      expect(consent.seen).toEqual([]);
    });

    it('a denied consent redirects access_denied with state and iss', async () => {
      await client.register();
      consent.next = 'deny';
      const r = await client.authorize('prod');
      expect(r.code).toBeNull();
      expect(r.url?.searchParams.get('error')).toBe('access_denied');
      expect(r.url?.searchParams.get('iss')).toBe(ISSUER);
    });

    it('approval re-checks access: another user’s grant, a service grant, an unknown project or an owner key used by an admin mint no code', async () => {
      await client.register();
      const admin = await h.addUser('admin@example.com', 'admin');
      const member = await h.addUser('member@example.com', 'member');
      const service = await h.addGrant(h.world.projectIds.prod, { userId: null });
      const ownerKey = await h.addCredential({ ownerUserId: 'usr_a' });
      // Written straight to storage: grant creation already refuses this (the owner boundary, P4-18).
      const adminOnOwnerKey = await h.addGrant(h.world.projectIds.prod, {
        userId: admin,
        credentialId: ownerKey,
      });
      const memberGrant = await h.addGrant(h.world.projectIds.prod, { userId: member });
      const cases: [Decision, string][] = [
        [{ userId: admin, grantId: h.world.grantIds.prod }, 'principal_mismatch'],
        [{ userId: 'usr_a', grantId: service }, 'principal_mismatch'],
        [{ userId: 'usr_a', grantId: memberGrant }, 'principal_mismatch'],
        [{ userId: admin, grantId: adminOnOwnerKey }, 'credential_not_permitted'],
      ];
      for (const [decision, reason] of cases) {
        consent.next = decision;
        const r = await client.authorize('prod');
        expect(r.res.status).toBe(403);
        expect(r.code).toBeNull();
        expect(consent.results.at(-1)).toEqual({ ok: false, reason });
      }
      // A grant of another project, approved for this resource.
      const euGrant = (await h.world.storage.grants.list({ projectId: h.world.projectIds.eu }))[0]
        ?.id as string;
      consent.next = { userId: 'usr_a', grantId: euGrant };
      expect((await client.authorize('prod')).res.status).toBe(403);
      expect(consent.results.at(-1)).toEqual({ ok: false, reason: 'grant_wrong_project' });
      // An unknown project reaches the consent step (no slug probing before sign-in) but can't be approved.
      consent.next = { userId: 'usr_a', grantId: h.world.grantIds.prod };
      expect((await client.authorize('ghost')).res.status).toBe(403);
      expect(consent.results.at(-1)).toEqual({ ok: false, reason: 'project_not_found' });
    });

    it('an issued token goes through resolveAccess on every request: revoked grant, disabled user, owner key', async () => {
      await client.register();
      const admin = await h.addUser('admin2@example.com', 'admin');
      const grant = await h.addGrant(h.world.projectIds.prod, { userId: admin });
      consent.next = { userId: admin, grantId: grant };
      const t = await client.tokens('prod');
      expect((await client.mcp('prod', t.access_token)).status).toBe(200);

      // The grant is moved onto the owner's personal key: the owner boundary refuses it.
      const ownerKey = await h.addCredential({ ownerUserId: 'usr_a' });
      await h.world.storage.grants.update(grant, { credentialId: ownerKey });
      await expectGenericDenial(await client.mcp('prod', t.access_token), 'credential_not_permitted');
      await h.world.storage.grants.update(grant, { credentialId: null });
      expect((await client.mcp('prod', t.access_token)).status).toBe(200);

      await h.world.storage.users.update(admin, { disabledAt: h.world.clock.now() });
      await expectGenericDenial(await client.mcp('prod', t.access_token), 'user_disabled');
      await h.world.storage.users.update(admin, { disabledAt: null });
      expect((await client.mcp('prod', t.access_token)).status).toBe(200);

      await h.world.storage.grants.update(grant, { revokedAt: h.world.clock.now() });
      await expectGenericDenial(await client.mcp('prod', t.access_token), 'grant_revoked');
    });

    it('OAuth bearers are refused before any lookup when malformed, and a session cookie is not one', async () => {
      await client.register();
      const t = await client.tokens('prod');
      const [userId, grantId, secret] = t.access_token.split(':') as [string, string, string];
      const tampered = `${userId}:${grantId}:${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`;
      await expectGenericDenial(await client.mcp('prod', tampered), 'oauth_invalid');
      // Refresh tokens and codes are not access tokens.
      await expectGenericDenial(await client.mcp('prod', t.refresh_token), 'oauth_invalid');
      await expectGenericDenial(await client.mcp('prod', `${t.access_token}:x`), 'malformed');
      const session = await h.addSession({ role: 'owner' });
      const res = await h.send(
        requestFor(MCP_ROUTES[0] as RouteCase, { headers: session.headers, slug: 'prod' }),
        app,
      );
      await expectGenericDenial(res, 'missing_token');
    });

    it('the OAuth endpoints answer alike whatever credentials a caller presents', async () => {
      const session = await h.addSession({ role: 'owner' });
      const callers = [
        {},
        { authorization: `Bearer ${h.world.tokens.prod}` },
        { authorization: `Bearer ${ADMIN_TOKEN}` },
        { cookie: session.cookie },
      ];
      for (const route of OAUTH_ROUTES) {
        const answers = new Set<string>();
        for (const headers of callers) {
          const res = await h.send(requestFor(route, { headers }), app);
          expect(res.status, `${route.method} ${route.path}`).toBeLessThan(500);
          // Registration mints a fresh client id each time: compare the status and error code only.
          answers.add(route.pattern === '/oauth/register' ? String(res.status) : `${res.status} ${res.text}`);
        }
        expect(answers.size, `${route.method} ${route.path}`).toBe(1);
      }
    });

    it('without the oauth option the routes do not exist and provider-shaped bearers are malformed', async () => {
      const off = h.makeApp();
      for (const route of OAUTH_ROUTES) {
        const res = await h.send(requestFor(route, { headers: {} }), off);
        expect(`${res.status} ${res.text}`).toBe('404 {"error":"not_found"}');
      }
      const shaped = `usr_a:${'g'.repeat(16)}:${'s'.repeat(32)}`;
      const res = await h.send(
        requestFor(MCP_ROUTES[0] as RouteCase, {
          headers: { authorization: `Bearer ${shaped}` },
          slug: 'prod',
        }),
        off,
      );
      expect(res.status).toBe(401);
      expect((await h.deniedRow(res.requestId as string)).errorCode).toBe('malformed');
    });

    it('oversized token and registration bodies are refused before the provider reads them', async () => {
      const big = 'x'.repeat(20 * 1024);
      for (const path of ['/oauth/token', '/oauth/register']) {
        const res = await client.send(
          new Request(`${ISSUER}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: big,
          }),
        );
        expect(res.status, path).toBe(413);
      }
    });
  });
}
