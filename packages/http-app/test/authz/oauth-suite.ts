// SPDX-License-Identifier: Apache-2.0
// The OAuth 2.1 integration suite (P5-01), ported from the P0-08 spike (`spikes/oauth/scripts/e2e.ts`) and extended
// with the authorization checks that matter here: single-use codes, PKCE S256 only, RFC 8707 audience per slug,
// refresh can't retarget, and OAuth tokens going through the same deny-by-default resolver as device tokens.
// Runs on every authz host: the HTTP app on memory storage (Node), the CLI's SQLite storage (Node), and the Worker
// on local D1 (workerd). Web-standard only. The consent step is a test stand-in (the real one is P5-04).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ClientMetadataFetch,
  MAX_OAUTH_CIMD_CLIENTS,
  OAUTH_CIMD_FETCHES_PER_IP,
  type OAuthApproval,
  type OAuthAuthorizationRequest,
  type OAuthConsentHandler,
  type OAuthOptions,
} from '../../src/index.ts';
import {
  ADMIN_TOKEN,
  type AuthzApp,
  type Captured,
  createHarness,
  type Harness,
  PUBLIC_ORIGIN,
} from './harness.ts';
import { ADMIN_ROUTES, MCP_ROUTES, OAUTH_ROUTES, type RouteCase, requestFor } from './matrix.ts';

export const ISSUER = PUBLIC_ORIGIN;
export const REDIRECT = 'http://127.0.0.1:53682/callback';
export const resourceOf = (slug: string): string => `${ISSUER}/p/${slug}/mcp`;
const metadataOf = (slug: string): string => `${ISSUER}/.well-known/oauth-protected-resource/p/${slug}/mcp`;
const challengeOf = (slug: string): string =>
  `Bearer realm="relic-bridge", resource_metadata="${metadataOf(slug)}", scope="mcp:read"`;

/** Claude Code's metadata document URL (P0-08 spike) and the shape of its document (loopback redirects, any port). */
export const CLAUDE_CODE_ID = 'https://claude.ai/oauth/claude-code-client-metadata';
/** A claude.ai-hosted document (web, Desktop and mobile share one client); the callback is the documented one. */
export const CLAUDE_AI_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
export const CLAUDE_AI_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

/** A stand-in for the internet: client metadata documents by URL, and every URL asked for. Never a real fetch. */
export interface DocServer {
  readonly calls: string[];
  readonly docs: Map<string, () => Response | Promise<Response>>;
  readonly fetch: ClientMetadataFetch;
}

export function docServer(): DocServer {
  const calls: string[] = [];
  const docs = new Map<string, () => Response | Promise<Response>>();
  return {
    calls,
    docs,
    fetch: async (url) => {
      calls.push(url);
      const make = docs.get(url);
      return make ? make() : new Response('not found', { status: 404 });
    },
  };
}

export const jsonDoc =
  (body: unknown, headers: Record<string, string> = {}) =>
  (): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    });

export const claudeCodeDoc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  client_id: CLAUDE_CODE_ID,
  client_name: 'Claude Code',
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  ...over,
});

export const claudeAiDoc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  client_id: CLAUDE_AI_ID,
  client_name: 'Claude',
  client_uri: 'https://claude.ai',
  redirect_uris: [CLAUDE_AI_CALLBACK],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  ...over,
});

const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64u(digest) };
}

/** What the stand-in consent does with the next authorization request. */
export type Decision = { readonly userId: string; readonly grantId: string } | 'deny';

export interface Consent {
  next: Decision | null;
  readonly seen: OAuthAuthorizationRequest[];
  readonly results: OAuthApproval[];
  readonly handler: OAuthConsentHandler;
}

export function consentStandIn(): Consent {
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

export interface Tokens {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
  readonly resource?: string;
}

/** OAuth client steps against one app. */
export class Client {
  clientId = '';
  /** The redirect URI this client authorizes and exchanges with. */
  redirectUri = REDIRECT;
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

  /** RFC 7591 registration request (any metadata); the raw answer. */
  registerRaw(metadata: Record<string, unknown>): Promise<Captured> {
    return this.send(
      new Request(`${ISSUER}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(metadata),
      }),
    );
  }

  async register(redirectUris: readonly string[] = [REDIRECT]): Promise<string> {
    const res = await this.registerRaw({
      client_name: 'authz test client',
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect(res.status, res.text).toBe(201);
    this.clientId = (JSON.parse(res.text) as { client_id: string }).client_id;
    return this.clientId;
  }

  authorizeUrl(params: Record<string, string | undefined>): string {
    const u = new URL(`${ISSUER}/oauth/authorize`);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
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
      redirect_uri: this.redirectUri,
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

export const WHOAMI = (id = 2) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'whoami', arguments: {} },
});

/** The generic denial every MCP refusal must equal (status, headers apart from the request id, body). */
export function observable(r: Captured): string {
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

  /** The same answer as a request without credentials to the same slug (the challenge names the slug). */
  async function expectGenericDenial(res: Captured, reason: string, slug = 'prod'): Promise<void> {
    expect(res.status).toBe(401);
    expect(observable(res)).toBe(observable(await reference(slug)));
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
      await expectGenericDenial(await client.mcp('eu', t.access_token), 'oauth_invalid', 'eu');
      await expectGenericDenial(
        await client.mcp('no-such-project', t.access_token),
        'oauth_invalid',
        'no-such-project',
      );
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

    it('concurrent redemptions of one code yield at most one token set (P5-05: possibly none)', async () => {
      await client.register();
      const { code, verifier } = await client.authorize('prod');
      const results = await Promise.all(
        Array.from({ length: 6 }, () => client.exchange(code as string, verifier, resourceOf('prod'))),
      );
      // At most one: a loser that sees the code mid-exchange revokes the grant (replay), and the winner's tokens are
      // then refused too (P5-05 tombstone), so none at all is also a correct outcome.
      const ok = results.filter((r) => r.status === 200);
      expect(ok.length).toBeLessThanOrEqual(1);
      expect(results.filter((r) => r.status === 400)).toHaveLength(6 - ok.length);
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

    it('review: a code_verifier outside RFC 7636 (43-128 unreserved) is refused and the code stays usable', async () => {
      await client.register();
      // A client that hashed a one-character verifier: its challenge looks like any other S256 challenge.
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('a')));
      const challenge = btoa(String.fromCharCode(...digest))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '');
      const weak = await client.authorize('prod', { code_challenge: challenge });
      expect(weak.code).not.toBeNull();
      const refused = await client.exchange(weak.code as string, 'a', resourceOf('prod'));
      expect(refused.status).toBe(400);
      expect(JSON.parse(refused.text)).toMatchObject({ error: 'invalid_request' });
      // Refused before the single-use marker is taken: a proper exchange of a proper code still works.
      const good = await client.authorize('prod');
      expect((await client.exchange(good.code as string, 'x'.repeat(129), resourceOf('prod'))).status).toBe(
        400,
      );
      expect((await client.exchange(good.code as string, good.verifier, resourceOf('prod'))).status).toBe(
        200,
      );
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

  describe('Protected Resource Metadata and audience binding (P5-02, P2-12 negative cases)', () => {
    const prm = (slug: string) =>
      client.send(new Request(`${ISSUER}/.well-known/oauth-protected-resource/p/${slug}/mcp`));

    it('publishes RFC 9728 metadata per slug, the same for known, unknown and disabled projects', async () => {
      await h.world.storage.projects.update(h.world.projectIds.eu, { disabledAt: h.world.clock.now() });
      const answers: string[] = [];
      for (const slug of ['prod', 'eu', 'no-such-project']) {
        const res = await prm(slug);
        expect(res.status, slug).toBe(200);
        expect(res.headers.get('content-type')).toContain('application/json');
        expect(JSON.parse(res.text)).toEqual({
          resource: resourceOf(slug),
          authorization_servers: [ISSUER],
          scopes_supported: ['mcp:read'],
          bearer_methods_supported: ['header'],
        });
        answers.push(observable(res).replaceAll(slug, '{slug}'));
      }
      expect(new Set(answers).size).toBe(1);
      // An invalid slug is not a resource of ours; nor is the root (no MCP endpoint lives there).
      for (const path of ['p/PROD/mcp', 'p/a..b/mcp', 'p/prod/mcp/x', '']) {
        const res = await client.send(new Request(`${ISSUER}/.well-known/oauth-protected-resource/${path}`));
        expect(`${res.status} ${res.text}`, path).toBe('404 {"error":"not_found"}');
      }
    });

    it('every 401 on an MCP route points at its slug’s metadata, byte-identical for every denial and any slug', async () => {
      await client.register();
      const t = await client.tokens('prod');
      for (const route of MCP_ROUTES) {
        const ref = await h.send(requestFor(route, { headers: {}, slug: 'prod' }), app);
        expect(ref.status).toBe(401);
        expect(ref.headers.get('www-authenticate')).toBe(challengeOf('prod'));
        // Device-token and OAuth denials, and a project that does not exist, give the same answer.
        const denials = [
          { headers: { authorization: 'Bearer rb_nope' }, slug: 'prod' },
          { headers: { authorization: `Bearer ${h.world.tokens.eu}` }, slug: 'prod' },
          { headers: { authorization: `Bearer ${t.access_token}` }, slug: 'eu' },
          { headers: { authorization: `Bearer ${h.world.tokens.prod}` }, slug: 'no-such-project' },
          { headers: {}, slug: 'no-such-project' },
        ];
        for (const d of denials) {
          const res = await h.send(requestFor(route, d), app);
          expect(res.status).toBe(401);
          const own = await h.send(requestFor(route, { headers: {}, slug: d.slug }), app);
          expect(observable(res), `${route.method} ${d.slug}`).toBe(observable(own));
          expect(observable(res).replaceAll(d.slug, 'prod')).toBe(observable(ref));
        }
      }
      // Following the challenge leads to the metadata of exactly this resource.
      const ref = await reference('prod');
      const url = /resource_metadata="([^"]+)"/.exec(ref.headers.get('www-authenticate') ?? '')?.[1];
      expect(url).toBe(metadataOf('prod'));
      expect(JSON.parse((await client.send(new Request(url as string))).text).resource).toBe(
        resourceOf('prod'),
      );
      // An invalid slug keeps the plain challenge (nothing to point at), as does a server without OAuth.
      const bad = await h.send(requestFor(MCP_ROUTES[0] as RouteCase, { headers: {}, slug: 'PROD' }), app);
      expect(bad.headers.get('www-authenticate')).toBe('Bearer realm="relic-bridge"');
      const off = await h.send(
        requestFor(MCP_ROUTES[0] as RouteCase, { headers: {}, slug: 'prod' }),
        h.makeApp(),
      );
      expect(off.headers.get('www-authenticate')).toBe('Bearer realm="relic-bridge"');
    });

    it('the token endpoint requires one resource of ours; a missing one does not burn the code', async () => {
      await client.register();
      const { code, verifier } = await client.authorize('prod');
      const base = {
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: REDIRECT,
        client_id: client.clientId,
        code_verifier: verifier,
      };
      for (const resource of [
        undefined,
        'https://evil.example/p/prod/mcp',
        `${ISSUER}/p/prod`,
        `${ISSUER}/`,
      ]) {
        const res = await client.form('/oauth/token', resource === undefined ? base : { ...base, resource });
        expect(res.status, String(resource)).toBe(400);
        expect(JSON.parse(res.text), String(resource)).toMatchObject({ error: 'invalid_target' });
      }
      const twice = new URLSearchParams({ ...base, resource: resourceOf('prod') });
      twice.append('resource', resourceOf('prod'));
      const doubled = await client.send(
        new Request(`${ISSUER}/oauth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: twice.toString(),
        }),
      );
      expect(JSON.parse(doubled.text)).toMatchObject({ error: 'invalid_request' });
      // None of those consumed the code.
      const ok = await client.exchange(code as string, verifier, resourceOf('prod'));
      expect(ok.status, ok.text).toBe(200);
      const t = JSON.parse(ok.text) as Tokens;

      // A refresh must name its resource too.
      const refresh = {
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id: client.clientId,
      };
      const bare = await client.form('/oauth/token', refresh);
      expect(bare.status).toBe(400);
      expect(JSON.parse(bare.text)).toMatchObject({ error: 'invalid_target' });
      const right = await client.form('/oauth/token', { ...refresh, resource: resourceOf('prod') });
      expect(right.status, right.text).toBe(200);
      const r = JSON.parse(right.text) as Tokens;
      secrets.push(r.access_token, r.refresh_token);
    });

    it('a code for slug A exchanged for slug B is refused and yields no token', async () => {
      await client.register();
      const { code, verifier } = await client.authorize('prod');
      const res = await client.exchange(code as string, verifier, resourceOf('eu'));
      expect(res.status).toBe(400);
      expect(JSON.parse(res.text)).toMatchObject({ error: 'invalid_target' });
    });

    it('scheme and host of the resource compare case-insensitively; the path does not', async () => {
      await client.register();
      const loud = resourceOf('prod').replace(/^http:\/\/localhost/, 'HTTP://LocalHost');
      const { code, verifier, url } = await client.authorize('prod', { resource: loud });
      expect(code, url?.toString()).not.toBeNull();
      expect(consent.seen.at(-1)?.resource).toBe(resourceOf('prod'));
      const tok = await client.exchange(code as string, verifier, loud);
      expect(tok.status, tok.text).toBe(200);
      const t = JSON.parse(tok.text) as Tokens;
      expect(t.resource).toBe(resourceOf('prod'));
      expect((await client.mcp('prod', t.access_token)).status).toBe(200);
      for (const resource of [`${ISSUER}/P/prod/mcp`, `${ISSUER}/p/prod/MCP`]) {
        const r = await client.authorize('prod', { resource });
        expect(r.res.status, resource).toBe(400);
        expect(JSON.parse(r.res.text)).toMatchObject({ error: 'invalid_target' });
      }
    });

    it('cross-slug reuse: a token for project A is the generic 401 on project B, even with a grant there', async () => {
      await client.register();
      const t = await client.tokens('prod');
      // usr_a also holds a working grant on eu: the token is still not for eu.
      const euGrant = (await h.world.storage.grants.list({ projectId: h.world.projectIds.eu }))[0]
        ?.id as string;
      consent.next = { userId: 'usr_a', grantId: euGrant };
      const eu = await client.tokens('eu');
      expect((await client.mcp('eu', eu.access_token)).status).toBe(200);
      for (const route of MCP_ROUTES) {
        const res = await client.mcp('eu', t.access_token, route);
        expect(res.status).toBe(401);
        expect(observable(res)).toBe(
          observable(await h.send(requestFor(route, { headers: {}, slug: 'eu' }), app)),
        );
      }
      await expectGenericDenial(await client.mcp('eu', t.access_token), 'oauth_invalid', 'eu');
      await expectGenericDenial(await client.mcp('prod', eu.access_token), 'oauth_invalid');
    });

    it('a token for a disabled project is the generic 401 until the project is enabled again', async () => {
      await client.register();
      const t = await client.tokens('prod');
      expect((await client.mcp('prod', t.access_token)).status).toBe(200);
      await h.world.storage.projects.update(h.world.projectIds.prod, { disabledAt: h.world.clock.now() });
      await expectGenericDenial(await client.mcp('prod', t.access_token), 'project_disabled');
      await h.world.storage.projects.update(h.world.projectIds.prod, { disabledAt: null });
      expect((await client.mcp('prod', t.access_token)).status).toBe(200);
    });

    it('an OAuth access token is not an admin credential: every admin route answers as without one', async () => {
      await client.register();
      const t = await client.tokens('prod');
      const adminRows = (await h.world.storage.auditLog.list({ kind: 'admin' })).length;
      for (const route of ADMIN_ROUTES) {
        const reference = await h.send(requestFor(route, { headers: {} }), app);
        const res = await h.send(
          requestFor(route, { headers: { authorization: `Bearer ${t.access_token}` } }),
          app,
        );
        expect(res.status, `${route.method} ${route.path}`).toBe(401);
        expect(observable(res), `${route.method} ${route.path}`).toBe(observable(reference));
      }
      expect((await h.world.storage.auditLog.list({ kind: 'admin' })).length).toBe(adminRows);
      // Nor a session for the admin UI: the answer is the sign-in redirect.
      const ui = await h.send(
        new Request(`${ISSUER}/admin`, { headers: { authorization: `Bearer ${t.access_token}` } }),
        app,
      );
      const anon = await h.send(new Request(`${ISSUER}/admin`), app);
      expect(ui.status).toBe(anon.status);
      expect(ui.headers.get('location')).toBe(anon.headers.get('location'));
    });
  });

  describe('Client registration: CIMD and DCR (P5-03)', () => {
    let docs: DocServer;
    let cimdApp: AuthzApp;
    let cimd: Client;
    const oauthWith = (
      over: Partial<OAuthOptions> = {},
    ): Partial<OAuthOptions> & { consent: OAuthConsentHandler } => ({
      consent: consent.handler,
      accessTokenTtlSeconds: 600,
      clientMetadataDocuments: { fetch: docs.fetch },
      ...over,
    });

    beforeEach(() => {
      docs = docServer();
      docs.docs.set(CLAUDE_CODE_ID, jsonDoc(claudeCodeDoc(), { 'cache-control': 'max-age=600' }));
      docs.docs.set(CLAUDE_AI_ID, jsonDoc(claudeAiDoc()));
      cimdApp = h.makeApp({ oauth: oauthWith() });
      cimd = new Client(h, cimdApp, secrets);
    });

    /**
     * The expiry (epoch s) the app's storage gives a row written now with this TTL. Each host's app storage has its own
     * clock in tests (memory: frozen, SQLite: real time, Worker: the faked `Date`), so read it from a row the app wrote:
     * the registration counter of this window (written by a registration just now, 3600 s TTL by default).
     */
    const appExpiry = async (ttlSeconds: number): Promise<number> => {
      const counter = (await h.world.storage.kv.list({ prefix: 'oauth-dcr-count:' })).keys;
      expect(counter.length).toBe(1);
      return (counter[0]?.expiration ?? 0) - 3600 + ttlSeconds;
    };

    const logged = (reason: string): boolean => h.logLines.some((l) => l.includes(`"reason":"${reason}"`));

    it('advertises CIMD only with a guarded fetcher (and keeps DCR and the none auth method)', async () => {
      const on = JSON.parse(
        (await cimd.send(new Request(`${ISSUER}/.well-known/oauth-authorization-server`))).text,
      );
      expect(on).toMatchObject({
        client_id_metadata_document_supported: true,
        registration_endpoint: `${ISSUER}/oauth/register`,
      });
      expect(on.token_endpoint_auth_methods_supported).toContain('none');
      const off = JSON.parse(
        (await client.send(new Request(`${ISSUER}/.well-known/oauth-authorization-server`))).text,
      );
      expect(off.client_id_metadata_document_supported).toBe(false);
    });

    it('Claude Code (CIMD, loopback on any port, localhost and 127.0.0.1) completes authorize → token → MCP', async () => {
      cimd.clientId = CLAUDE_CODE_ID;
      for (const redirect of ['http://127.0.0.1:49152/callback', 'http://localhost:53999/callback']) {
        cimd.redirectUri = redirect;
        const t = await cimd.tokens('prod');
        expect((await cimd.mcp('prod', t.access_token)).status).toBe(200);
      }
      expect(consent.seen[0]).toMatchObject({
        clientId: CLAUDE_CODE_ID,
        clientKind: 'metadata_document',
        clientHost: 'claude.ai',
        clientName: 'Claude Code',
        redirectHost: '127.0.0.1:49152',
      });
      // Fetched once, then served from the stored record until its cache lifetime ends.
      expect(docs.calls).toEqual([CLAUDE_CODE_ID]);
    });

    it('claude.ai (CIMD) completes the flow; refresh after the cache lifetime fetches the document again', async () => {
      await new Client(h, cimdApp, secrets).register(); // a clock reference (appExpiry)
      cimd.clientId = CLAUDE_AI_ID;
      cimd.redirectUri = CLAUDE_AI_CALLBACK;
      const t = await cimd.tokens('prod');
      expect((await cimd.mcp('prod', t.access_token)).status).toBe(200);
      expect(docs.calls).toEqual([CLAUDE_AI_ID]);
      // No Cache-Control: cached for one hour. (Memory storage has a frozen clock: the end of the lifetime is the
      // row's expiry, then the row going away.)
      const cached = async () =>
        (await h.world.storage.kv.list({ prefix: `oauth:client:${CLAUDE_AI_ID}` })).keys;
      expect(Math.abs(((await cached())[0]?.expiration ?? 0) - (await appExpiry(3600)))).toBeLessThanOrEqual(
        2,
      );
      const expire = async () => {
        advance(3_601_000);
        await h.world.storage.kv.delete(`oauth:client:${CLAUDE_AI_ID}`);
      };
      await expire();
      const refreshed = await cimd.form('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id: CLAUDE_AI_ID,
        resource: resourceOf('prod'),
      });
      expect(refreshed.status, refreshed.text).toBe(200);
      const r = JSON.parse(refreshed.text) as Tokens;
      secrets.push(r.access_token, r.refresh_token);
      expect(docs.calls).toEqual([CLAUDE_AI_ID, CLAUDE_AI_ID]);
      // The document changed: its client can't refresh any more (and the code that failed burns nothing).
      docs.docs.set(CLAUDE_AI_ID, jsonDoc(claudeAiDoc({ client_id: 'https://claude.ai/other' })));
      await expire();
      const refused = await cimd.form('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: r.refresh_token,
        client_id: CLAUDE_AI_ID,
        resource: resourceOf('prod'),
      });
      expect(refused.status).toBe(400);
      expect(JSON.parse(refused.text)).toMatchObject({ error: 'invalid_client' });
    });

    it('claude.ai (DCR request shape) registers and completes the flow', async () => {
      const res = await cimd.registerRaw({
        client_name: 'Claude',
        redirect_uris: [CLAUDE_AI_CALLBACK],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
      expect(res.status, res.text).toBe(201);
      cimd.clientId = (JSON.parse(res.text) as { client_id: string }).client_id;
      cimd.redirectUri = CLAUDE_AI_CALLBACK;
      const t = await cimd.tokens('prod');
      expect((await cimd.mcp('prod', t.access_token)).status).toBe(200);
      expect(consent.seen[0]).toMatchObject({
        clientKind: 'dynamic',
        clientHost: null,
        clientName: 'Claude',
      });
      expect(docs.calls).toEqual([]);
    });

    it('malicious or broken metadata documents are a 400 page: no redirect, no consent, nothing cached', async () => {
      const id = 'https://evil.example.com/client.json';
      const big = 'x'.repeat(6000);
      const cases: Record<string, () => Response | Promise<Response>> = {
        no_usable_redirect_uri: jsonDoc({
          ...claudeAiDoc(),
          client_id: id,
          redirect_uris: ['com.example.app:/callback'],
        }),
        redirect_uri_ip_literal: jsonDoc({
          ...claudeAiDoc(),
          client_id: id,
          redirect_uris: ['https://10.0.0.1/cb'],
        }),
        redirect_uri_fragment: jsonDoc({
          ...claudeAiDoc(),
          client_id: id,
          redirect_uris: [`https://evil.example.com/cb#x`],
        }),
        redirect_uri_wildcard: jsonDoc({
          ...claudeAiDoc(),
          client_id: id,
          redirect_uris: ['https://*.evil.example.com/cb'],
        }),
        foreign_host_only: jsonDoc({ ...claudeAiDoc(), client_id: id, redirect_uris: [CLAUDE_AI_CALLBACK] }),
        client_id_mismatch: jsonDoc({ ...claudeAiDoc() }),
        client_secret: jsonDoc({
          ...claudeAiDoc(),
          client_id: id,
          redirect_uris: ['https://evil.example.com/cb'],
          client_secret: 's',
        }),
        token_endpoint_auth_method: jsonDoc({
          ...claudeAiDoc(),
          client_id: id,
          redirect_uris: ['https://evil.example.com/cb'],
          token_endpoint_auth_method: 'private_key_jwt',
        }),
        client_name: jsonDoc({
          ...claudeAiDoc(),
          client_id: id,
          redirect_uris: ['https://evil.example.com/cb'],
          client_name: 'Claude‮',
        }),
        too_large_declared: () =>
          new Response(big, {
            status: 200,
            headers: { 'content-type': 'application/json', 'content-length': '6000' },
          }),
        too_large_streamed: () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (let i = 0; i < 4; i++) controller.enqueue(new TextEncoder().encode('x'.repeat(2000)));
                controller.close();
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        content_type: () =>
          new Response(JSON.stringify(claudeAiDoc({ client_id: id })), {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
        redirect: () =>
          new Response(null, {
            status: 302,
            headers: { location: 'http://169.254.169.254/latest/meta-data' },
          }),
        http_status: () => new Response('nope', { status: 500 }),
        not_json: () => new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }),
        fetch_failed: () => {
          throw new TypeError('connect refused');
        },
      };
      cimd.clientId = id;
      cimd.redirectUri = 'https://evil.example.com/cb';
      for (const [reason, make] of Object.entries(cases)) {
        docs.docs.set(id, make);
        const before = docs.calls.length;
        const { res } = await cimd.authorize('prod');
        expect(res.status, reason).toBe(400);
        expect(res.headers.get('location'), reason).toBeNull();
        expect(JSON.parse(res.text), reason).toMatchObject({ error: 'invalid_client' });
        expect(docs.calls.length, reason).toBe(before + 1);
        const expected = reason.startsWith('too_large')
          ? 'too_large'
          : reason === 'foreign_host_only'
            ? 'no_usable_redirect_uri'
            : reason;
        expect(logged(expected), reason).toBe(true);
      }
      expect(consent.seen).toEqual([]);
      // Errors are never cached: a fixed document works at once.
      docs.docs.set(
        id,
        jsonDoc({ ...claudeAiDoc(), client_id: id, redirect_uris: ['https://evil.example.com/cb'] }),
      );
      const fixed = await cimd.authorize('prod');
      expect(fixed.code).not.toBeNull();
    });

    it('a redirect URI the document does not hold (or holds on another host) is refused before any redirect', async () => {
      docs.docs.set(
        CLAUDE_AI_ID,
        jsonDoc(claudeAiDoc({ redirect_uris: [CLAUDE_AI_CALLBACK, 'https://evil.example/cb'] })),
      );
      cimd.clientId = CLAUDE_AI_ID;
      for (const redirect of [
        'https://evil.example/cb',
        'https://claude.ai/api/mcp/other',
        'http://127.0.0.1:5000/cb',
      ]) {
        cimd.redirectUri = redirect;
        const { res } = await cimd.authorize('prod');
        expect(res.status, redirect).toBe(400);
        expect(res.headers.get('location'), redirect).toBeNull();
      }
      expect(consent.seen).toEqual([]);
    });

    it('client ids that must not be fetched are refused without a fetch (SSRF, T11)', async () => {
      const refused = [
        'https://127.0.0.1/client.json',
        'https://10.0.0.1/client.json',
        'https://169.254.169.254/latest/meta-data',
        'https://[::1]/client.json',
        'https://[fd00::1]/client.json',
        'https://localhost/client.json',
        'https://metadata.google.internal/computeMetadata/v1',
        'https://printer.local/client.json',
        'https://intranet/client.json',
        'https://claude.ai:8443/client.json',
        'https://claude.ai:443/client.json',
        'https://CLAUDE.ai/oauth/client.json',
        'https://claude.ai/oauth/../client.json',
        'https://claude.ai',
        'https://claude.ai/',
        'https://user:pw@claude.ai/client.json',
        'https://claude.ai/client.json#frag',
        'https://0x7f.1/client.json',
        `${ISSUER}/client.json`,
        `https://claude.ai/${'a'.repeat(600)}`,
      ];
      for (const id of refused) {
        cimd.clientId = id;
        const { res } = await cimd.authorize('prod');
        expect(res.status, id).toBe(400);
        expect(res.headers.get('location'), id).toBeNull();
      }
      expect(docs.calls).toEqual([]);
      expect(consent.seen).toEqual([]);
      // At the token endpoint too.
      const tok = await cimd.form('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: `usr_a:${'g'.repeat(16)}:${'s'.repeat(32)}`,
        client_id: 'https://169.254.169.254/latest/meta-data',
        resource: resourceOf('prod'),
      });
      expect(tok.status).toBe(400);
      expect(docs.calls).toEqual([]);
    });

    it('without a fetcher, URL client ids are refused at authorize and token and nothing is fetched', async () => {
      client.clientId = CLAUDE_CODE_ID;
      const { res } = await client.authorize('prod');
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      expect(logged('cimd_disabled')).toBe(true);
      const tok = await client.form('/oauth/token', {
        grant_type: 'authorization_code',
        code: `usr_a:${'g'.repeat(16)}:${'s'.repeat(32)}`,
        redirect_uri: REDIRECT,
        client_id: CLAUDE_CODE_ID,
        code_verifier: 'v'.repeat(43),
        resource: resourceOf('prod'),
      });
      expect(tok.status).toBe(400);
      expect(JSON.parse(tok.text)).toMatchObject({ error: 'invalid_client' });
      expect(docs.calls).toEqual([]);
    });

    it('DCR: redirect URIs and names are checked before anything is stored', async () => {
      const base = { client_name: 'x', token_endpoint_auth_method: 'none' };
      const bad: [string, Record<string, unknown>][] = [
        ['http on a public host', { ...base, redirect_uris: ['http://evil.example/cb'] }],
        ['fragment', { ...base, redirect_uris: ['https://app.example/cb#x'] }],
        ['wildcard', { ...base, redirect_uris: ['https://*.example/cb'] }],
        ['private IP', { ...base, redirect_uris: ['https://192.168.1.10/cb'] }],
        ['metadata IP', { ...base, redirect_uris: ['https://169.254.169.254/cb'] }],
        ['userinfo', { ...base, redirect_uris: ['https://u:p@app.example/cb'] }],
        ['none', { ...base, redirect_uris: [] }],
        ['missing', { ...base }],
        [
          'too many',
          { ...base, redirect_uris: Array.from({ length: 11 }, (_, i) => `https://app.example/cb${i}`) },
        ],
        ['only private-use', { ...base, redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback'] }],
        ['javascript', { ...base, redirect_uris: ['javascript:alert(1)'] }],
        ['bidi name', { ...base, client_name: 'Cl‮aude', redirect_uris: [REDIRECT] }],
        ['zero-width name', { ...base, client_name: 'Cla​ude', redirect_uris: [REDIRECT] }],
        ['long name', { ...base, client_name: 'x'.repeat(101), redirect_uris: [REDIRECT] }],
      ];
      for (const [what, meta] of bad) {
        const res = await client.registerRaw(meta);
        expect(res.status, what).toBe(400);
        expect(['invalid_redirect_uri', 'invalid_client_metadata'], what).toContain(
          JSON.parse(res.text).error,
        );
      }
      // A private-use scheme may be listed next to a usable callback (Cursor does).
      const ok = await client.registerRaw({
        ...base,
        redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback', 'https://cursor.example/cb'],
      });
      expect(ok.status, ok.text).toBe(201);
      const notJson = await client.send(
        new Request(`${ISSUER}/oauth/register`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: JSON.stringify({ ...base, redirect_uris: [REDIRECT] }),
        }),
      );
      expect(notJson.status).toBe(400);
      expect((await h.world.storage.kv.list({ prefix: 'oauth:client:' })).keys.length).toBe(1);
    });

    it('DCR: an allow-list of redirect hosts, loopback always allowed', async () => {
      const listed = h.makeApp({ oauth: oauthWith({ registrationRedirectHosts: ['claude.ai'] }) });
      const c = new Client(h, listed, secrets);
      expect((await c.registerRaw({ redirect_uris: [CLAUDE_AI_CALLBACK] })).status).toBe(201);
      expect((await c.registerRaw({ redirect_uris: [REDIRECT] })).status).toBe(201);
      const other = await c.registerRaw({ redirect_uris: ['https://evil.example/cb'] });
      expect(other.status).toBe(400);
      expect(JSON.parse(other.text).error).toBe('invalid_redirect_uri');
    });

    it('DCR: one registration cap for every instance (shared storage counter), 429 with Retry-After', async () => {
      const limit = { requests: 3, perSeconds: 3600 };
      const one = new Client(h, h.makeApp({ oauth: oauthWith({ registrationLimit: limit }) }), secrets);
      const two = new Client(h, h.makeApp({ oauth: oauthWith({ registrationLimit: limit }) }), secrets);
      const meta = { redirect_uris: [REDIRECT] };
      expect((await one.registerRaw(meta)).status).toBe(201);
      expect((await two.registerRaw(meta)).status).toBe(201);
      expect((await one.registerRaw(meta)).status).toBe(201);
      for (const c of [one, two]) {
        const res = await c.registerRaw(meta);
        expect(res.status).toBe(429);
        expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
        expect(Number(res.headers.get('retry-after'))).toBeLessThanOrEqual(3600);
      }
      // Refused requests are not counted against the policy (a bad request still uses up a slot: it was checked).
      expect((await h.world.storage.kv.list({ prefix: 'oauth:client:' })).keys.length).toBe(3);
      advance(3_600_000);
      expect((await two.registerRaw(meta)).status).toBe(201);
    });

    /** A request that the app sees as coming from `ip` (the tests' `clientIp` reads this header). */
    const fromIp = (ip: string, path: string, body: unknown): Request =>
      new Request(`${ISSUER}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-ip': ip },
        body: JSON.stringify(body),
      });
    const byIp = (c: { req: { header(name: string): string | undefined } }): string | null =>
      c.req.header('x-test-ip') ?? null;

    it('DCR: one address cannot use up registration for the others; refused requests are not counted (P5-10)', async () => {
      const ipApp = h.makeApp({
        oauth: oauthWith({
          registrationLimit: { requests: 100, perSeconds: 3600 },
          registrationIpLimit: { requests: 3, perSeconds: 3600 },
          clientIp: byIp,
        }),
      });
      const meta = { redirect_uris: [REDIRECT] };
      // Requests the policy refuses never count.
      for (let i = 0; i < 5; i++) {
        const bad = await h.send(
          fromIp('203.0.113.1', '/oauth/register', { redirect_uris: ['https://x.example/#f'] }),
          ipApp,
        );
        expect(bad.status).toBe(400);
      }
      for (let i = 0; i < 3; i++) {
        expect((await h.send(fromIp('203.0.113.1', '/oauth/register', meta), ipApp)).status).toBe(201);
      }
      const refused = await h.send(fromIp('203.0.113.1', '/oauth/register', meta), ipApp);
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await h.send(fromIp('203.0.113.2', '/oauth/register', meta), ipApp)).status).toBe(201);
      advance(3_600_000);
      expect((await h.send(fromIp('203.0.113.1', '/oauth/register', meta), ipApp)).status).toBe(201);
    });

    it('CIMD: one address may make the server fetch only a budgeted number of documents (P5-10)', async () => {
      const ipApp = h.makeApp({ oauth: oauthWith({ clientIp: byIp }) });
      const urls: string[] = [];
      for (let i = 0; i < 25; i++) {
        const url = `https://app${i}.example.com/oauth/client.json`;
        urls.push(url);
        docs.docs.set(
          url,
          jsonDoc({ client_id: url, client_name: `App ${i}`, redirect_uris: ['http://127.0.0.1/cb'] }),
        );
      }
      const ask = (ip: string, url: string): Promise<Captured> => {
        const u = new URL(`${ISSUER}/oauth/authorize`);
        u.searchParams.set('response_type', 'code');
        u.searchParams.set('client_id', url);
        u.searchParams.set('redirect_uri', 'http://127.0.0.1/cb');
        u.searchParams.set('resource', resourceOf('prod'));
        return h.send(new Request(u, { headers: { 'x-test-ip': ip } }), ipApp);
      };
      for (const url of urls) await ask('203.0.113.7', url);
      expect(docs.calls).toHaveLength(OAUTH_CIMD_FETCHES_PER_IP.requests);
      expect((await h.world.storage.kv.list({ prefix: 'oauth:client:https://' })).keys.length).toBe(
        OAUTH_CIMD_FETCHES_PER_IP.requests,
      );
      expect(logged('fetch_budget')).toBe(true);
      // Another address has its own budget; a cached document costs nothing.
      await ask('203.0.113.8', urls[24] as string);
      expect(docs.calls).toHaveLength(OAUTH_CIMD_FETCHES_PER_IP.requests + 1);
      await ask('203.0.113.7', urls[0] as string);
      expect(docs.calls).toHaveLength(OAUTH_CIMD_FETCHES_PER_IP.requests + 1);
    });

    it('CIMD: stored document clients are capped; more are refused without a fetch (P5-10)', async () => {
      for (let i = 0; i < MAX_OAUTH_CIMD_CLIENTS; i++) {
        await h.world.storage.kv.put(
          `oauth:client:https://stored${i}.example.com/c.json`,
          JSON.stringify({ clientId: `https://stored${i}.example.com/c.json` }),
          { expirationTtl: 3600 },
        );
      }
      const res = await cimd.send(
        new Request(
          cimd.authorizeUrl({
            client_id: CLAUDE_CODE_ID,
            redirect_uri: 'http://127.0.0.1/callback',
            resource: resourceOf('prod'),
          }),
        ),
      );
      expect(res.status).toBe(400);
      expect(docs.calls).toEqual([]);
      expect(logged('too_many_clients')).toBe(true);
    });

    it('DCR: a registration nobody uses expires after a day; the first exchange renews it', async () => {
      const used = await cimd.register();
      const unusedClient = new Client(h, cimdApp, secrets);
      const unused = await unusedClient.register();
      const ttl = async (id: string) =>
        (await h.world.storage.kv.list({ prefix: `oauth:client:${id}` })).keys[0]?.expiration ?? null;
      const day = await appExpiry(86_400);
      expect(Math.abs(((await ttl(unused)) ?? 0) - day)).toBeLessThanOrEqual(2);
      expect(Math.abs(((await ttl(used)) ?? 0) - day)).toBeLessThanOrEqual(2);
      await cimd.tokens('prod');
      expect((await ttl(used)) ?? 0).toBeGreaterThan(day + 80 * 86_400);
      advance(86_401_000);
      // (Memory storage has a frozen clock: the expired row is removed by hand there.)
      await h.world.storage.kv.delete(`oauth:client:${unused}`);
      expect(await ttl(unused)).toBeNull();
      const gone = await unusedClient.authorize('prod');
      expect(gone.res.status).toBe(400);
      expect(gone.res.headers.get('location')).toBeNull();
      expect((await cimd.authorize('prod')).code).not.toBeNull();
    });
  });
}
