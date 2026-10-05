// SPDX-License-Identifier: Apache-2.0
// Client conformance (P5-06): the official MCP TypeScript SDK client (`@modelcontextprotocol/client` 2.2.0: discovery,
// registration, PKCE, `resource`, refresh, 401 handling, Streamable HTTP) drives the OAuth server end to end, shaped
// like each real client we could not run (claude.ai / Claude mobile / Claude Desktop: CIMD, https callback; Claude
// Code: CIMD, loopback; Cursor / VS Code / MCP Inspector: DCR, loopback or custom scheme). Real clients are NOT
// exercised here; `docs/reference/client-compatibility.md` says which cells are verified by this suite and which are not.
// Runs on every authz host (memory, SQLite, Worker with local D1).
import {
  Client as McpClient,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AuthzApp, createHarness, type Harness } from './harness.ts';
import {
  CLAUDE_AI_CALLBACK,
  CLAUDE_AI_ID,
  CLAUDE_CODE_ID,
  type Consent,
  claudeAiDoc,
  claudeCodeDoc,
  consentStandIn,
  type DocServer,
  docServer,
  ISSUER,
  jsonDoc,
  pkce,
  resourceOf,
} from './oauth-suite.ts';

/** One request the SDK client sent, as the server saw it. */
interface Seen {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** Query (GET) or form body (POST /oauth/*) parameters. */
  readonly params: URLSearchParams;
  readonly bearer: string | null;
}

/** An `OAuthClientProvider` that keeps everything in memory, like a client app's token store. */
class MemoryProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = '';
  authorizationUrl: URL | null = null;
  discovery: OAuthDiscoveryState | undefined;
  /** `invalidateCredentials` calls, in order (the SDK drops what the server refused). */
  readonly invalidated: string[] = [];
  constructor(
    private readonly meta: OAuthClientMetadata,
    private readonly callback: string,
    readonly clientMetadataUrl?: string,
  ) {}
  get redirectUrl(): string {
    return this.callback;
  }
  get clientMetadata(): OAuthClientMetadata {
    return this.meta;
  }
  state(): string {
    return `st-${crypto.randomUUID()}`;
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.info = info;
  }
  tokens(): OAuthTokens | undefined {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens): void {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(v: string): void {
    this.verifier = v;
  }
  codeVerifier(): string {
    return this.verifier;
  }
  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    this.invalidated.push(scope);
    if (scope === 'all' || scope === 'tokens') this.saved = undefined;
    if (scope === 'all' || scope === 'client') this.info = undefined;
    if (scope === 'all' || scope === 'discovery') this.discovery = undefined;
  }
}

/** What a client looks like to the server. */
interface Profile {
  readonly name: string;
  /** CIMD profiles serve this document; DCR profiles leave it null. */
  readonly cimd: { readonly id: string; readonly doc: () => Record<string, unknown> } | null;
  readonly redirect: string;
  readonly meta: OAuthClientMetadata;
}

const PROFILES: readonly Profile[] = [
  {
    name: 'claude.ai-style (CIMD, https callback)',
    cimd: { id: CLAUDE_AI_ID, doc: () => claudeAiDoc() },
    redirect: CLAUDE_AI_CALLBACK,
    meta: {
      client_name: 'Claude',
      redirect_uris: [CLAUDE_AI_CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  },
  {
    name: 'Claude Code-style (CIMD, loopback callback)',
    cimd: { id: CLAUDE_CODE_ID, doc: () => claudeCodeDoc() },
    redirect: 'http://127.0.0.1:54123/callback',
    meta: {
      client_name: 'Claude Code',
      redirect_uris: ['http://127.0.0.1:54123/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  },
  {
    name: 'Cursor / VS Code / Inspector-style (DCR, loopback callback)',
    cimd: null,
    redirect: 'http://127.0.0.1:6274/oauth/callback',
    meta: {
      client_name: 'Inspector-like client',
      redirect_uris: ['http://127.0.0.1:6274/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  },
  {
    name: 'Cursor-style (DCR, custom-scheme and loopback callbacks)',
    cimd: null,
    redirect: 'http://localhost:7777/callback',
    meta: {
      client_name: 'Cursor-like client',
      redirect_uris: [
        'cursor://anysphere.cursor-retrieval/oauth/user-x/callback',
        'http://localhost:7777/callback',
      ],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  },
  {
    name: 'claude.ai legacy-style (DCR, https callback)',
    cimd: null,
    redirect: CLAUDE_AI_CALLBACK,
    meta: {
      client_name: 'Claude',
      redirect_uris: [CLAUDE_AI_CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  },
];

export function clientConformanceSuite(): void {
  let h: Harness;
  let consent: Consent;
  let docs: DocServer;
  let app: AuthzApp;
  let secrets: string[];

  beforeEach(async () => {
    h = await createHarness();
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['Date'], now: h.world.clock.now() });
    consent = consentStandIn();
    docs = docServer();
    secrets = [];
    for (const p of PROFILES) {
      if (p.cimd !== null)
        docs.docs.set(p.cimd.id, jsonDoc(p.cimd.doc(), { 'cache-control': 'max-age=3600' }));
    }
    app = h.makeApp({
      oauth: {
        consent: consent.handler,
        accessTokenTtlSeconds: 600,
        clientMetadataDocuments: { fetch: docs.fetch },
      },
    });
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

  /** A client application: the SDK, a provider and a `fetch` that goes to the app and records what the server saw. */
  class App {
    readonly seen: Seen[] = [];
    readonly provider: MemoryProvider;
    constructor(readonly profile: Profile) {
      this.provider = new MemoryProvider(profile.meta, profile.redirect, profile.cimd?.id);
    }

    readonly fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const form =
        request.method === 'POST' && url.pathname.startsWith('/oauth/') && url.pathname !== '/oauth/register';
      const params = form
        ? new URLSearchParams(new TextDecoder().decode(await request.clone().arrayBuffer()))
        : url.searchParams;
      const res = await app.fetch(request);
      this.seen.push({
        method: request.method,
        path: url.pathname,
        status: res.status,
        params,
        bearer: request.headers.get('authorization'),
      });
      return res;
    };

    transport(slug = 'prod'): StreamableHTTPClientTransport {
      return new StreamableHTTPClientTransport(new URL(resourceOf(slug)), {
        authProvider: this.provider,
        fetch: this.fetchFn,
      });
    }

    sdk(): McpClient {
      return new McpClient({ name: this.profile.name, version: '0.0.0' }, {});
    }

    /** The first connect: no token, so the SDK discovers, registers and hands us the authorization URL. */
    async startAuthorization(slug = 'prod'): Promise<StreamableHTTPClientTransport> {
      const transport = this.transport(slug);
      await expect(this.sdk().connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
      expect(this.provider.authorizationUrl).not.toBeNull();
      return transport;
    }

    /** The user's browser: follow the authorization URL, the consent stand-in approves, read the code from the redirect. */
    async approve(): Promise<URLSearchParams> {
      const res = await app.fetch(new Request(this.provider.authorizationUrl as URL));
      expect(res.status, await res.clone().text()).toBe(302);
      const location = new URL(res.headers.get('location') as string);
      expect(`${location.origin}${location.pathname}`).toBe(this.profile.redirect);
      const code = location.searchParams.get('code');
      if (code !== null) secrets.push(code);
      return location.searchParams;
    }

    /** The whole first-time connection; returns a connected SDK client. */
    async connect(slug = 'prod'): Promise<McpClient> {
      const transport = await this.startAuthorization(slug);
      const callback = await this.approve();
      await transport.finishAuth(callback);
      const tokens = this.provider.saved as OAuthTokens;
      secrets.push(tokens.access_token, tokens.refresh_token ?? '');
      const client = this.sdk();
      await client.connect(this.transport(slug));
      // The SDK opens its standalone GET stream right after `initialized`, asynchronously: let it finish.
      await vi.waitFor(() => expect(this.requests('GET', resourcePath(slug)).length).toBeGreaterThan(0));
      return client;
    }

    /** The saved tokens (the SDK's own copy), pushed to the leak scan as they change. */
    get tokens(): OAuthTokens {
      const t = this.provider.saved as OAuthTokens;
      secrets.push(t.access_token, t.refresh_token ?? '');
      return t;
    }

    requests(method: string, path: string): Seen[] {
      return this.seen.filter((s) => s.method === method && s.path === path);
    }
  }

  const resourcePath = (slug: string): string => `/p/${slug}/mcp`;

  const whoami = async (client: McpClient) => {
    const res = await client.callTool({ name: 'whoami', arguments: {} });
    expect(res.isError ?? false, JSON.stringify(res)).toBe(false);
    return res;
  };

  for (const profile of PROFILES) {
    describe(profile.name, () => {
      it('discovers (PRM then AS metadata), registers, uses PKCE S256 and `resource`, and calls a tool', async () => {
        const a = new App(profile);
        const client = await a.connect();

        // 401 first, then discovery in the order the MCP spec gives: PRM (from the challenge), then AS metadata.
        const paths = a.seen.map((s) => s.path);
        const first401 = a.seen.findIndex((s) => s.status === 401);
        expect(first401).toBeGreaterThanOrEqual(0);
        const prm = paths.indexOf('/.well-known/oauth-protected-resource/p/prod/mcp');
        const asMeta = paths.indexOf('/.well-known/oauth-authorization-server');
        expect(prm).toBeGreaterThan(first401);
        expect(asMeta).toBeGreaterThan(prm);

        // Registration by the client's kind: a metadata document (fetched once by the server) or DCR.
        if (profile.cimd !== null) {
          expect(a.requests('POST', '/oauth/register')).toHaveLength(0);
          expect(a.provider.authorizationUrl?.searchParams.get('client_id')).toBe(profile.cimd.id);
          expect(docs.calls.filter((u) => u === profile.cimd?.id).length).toBeGreaterThan(0);
        } else {
          expect(a.requests('POST', '/oauth/register')).toHaveLength(1);
          expect(a.requests('POST', '/oauth/register')[0]?.status).toBe(201);
        }

        // The authorization request: PKCE S256, resource, state, code response type, exactly our redirect.
        const auth = a.provider.authorizationUrl as URL;
        expect(auth.pathname).toBe('/oauth/authorize');
        expect(auth.searchParams.get('response_type')).toBe('code');
        expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
        expect(auth.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(auth.searchParams.get('resource')).toBe(resourceOf('prod'));
        expect(auth.searchParams.get('redirect_uri')).toBe(profile.redirect);
        expect(auth.searchParams.get('state')).toBeTruthy();

        // The code exchange carries the verifier and the resource.
        const exchange = a.requests('POST', '/oauth/token');
        expect(exchange).toHaveLength(1);
        expect(exchange[0]?.status).toBe(200);
        expect(exchange[0]?.params.get('grant_type')).toBe('authorization_code');
        expect(exchange[0]?.params.get('resource')).toBe(resourceOf('prod'));
        expect(exchange[0]?.params.get('code_verifier')).toBeTruthy();
        expect(exchange[0]?.params.get('redirect_uri')).toBe(profile.redirect);

        // Streamable HTTP: initialized, lists tools, calls one with the token.
        expect((await client.listTools()).tools.map((t) => t.name)).toContain('whoami');
        await whoami(client);
        await client.close();
      });

      it('the callback carries `iss` and the SDK accepts it (RFC 9207)', async () => {
        const a = new App(profile);
        const transport = await a.startAuthorization();
        const callback = await a.approve();
        expect(callback.get('iss')).toBe(ISSUER);
        expect(callback.get('state')).toBe(a.provider.authorizationUrl?.searchParams.get('state'));
        await transport.finishAuth(callback);
        expect(a.tokens.access_token).toBeTruthy();
      });

      it('refreshes by itself after the access token expires: `resource` sent, tokens rotated, the old refresh token refused', async () => {
        const a = new App(profile);
        const client = await a.connect();
        const first = { ...a.tokens };
        advance(601_000);
        await whoami(client); // 401 -> SDK refresh -> retry

        const refreshes = a
          .requests('POST', '/oauth/token')
          .filter((s) => s.params.get('grant_type') === 'refresh_token');
        expect(refreshes).toHaveLength(1);
        expect(refreshes[0]?.status).toBe(200);
        expect(refreshes[0]?.params.get('resource')).toBe(resourceOf('prod'));
        expect(refreshes[0]?.params.get('client_id')).toBe(profile.cimd?.id ?? a.provider.info?.client_id);
        const second = a.tokens;
        expect(second.access_token).not.toBe(first.access_token);
        expect(second.refresh_token).toBeTruthy();
        expect(second.refresh_token).not.toBe(first.refresh_token);

        // Rotation: the previous refresh token is dead (and presenting it revokes the device, see below).
        const replay = await app.fetch(
          new Request(`${ISSUER}/oauth/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: first.refresh_token as string,
              client_id: profile.cimd?.id ?? (a.provider.info?.client_id as string),
              resource: resourceOf('prod'),
            }).toString(),
          }),
        );
        expect(replay.status).toBe(400);
        expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');
        // Reuse revoked the whole device: even the newest token is gone.
        const after = await app.fetch(
          new Request(resourceOf('prod'), {
            method: 'POST',
            headers: {
              authorization: `Bearer ${second.access_token}`,
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
          }),
        );
        expect(after.status).toBe(401);
        await client.close();
      });

      it('a long-lived session keeps working across several refreshes (each refresh token used once)', async () => {
        const a = new App(profile);
        const client = await a.connect();
        for (let i = 0; i < 3; i++) {
          advance(601_000);
          await whoami(client);
        }
        const refreshes = a
          .requests('POST', '/oauth/token')
          .filter((s) => s.params.get('grant_type') === 'refresh_token');
        expect(refreshes.map((r) => r.status)).toEqual([200, 200, 200]);
        await client.close();
      });

      it('parallel requests over an expired token: the SDK does not coalesce refreshes, so strict rotation revokes the device', async () => {
        const a = new App(profile);
        const client = await a.connect();
        advance(601_000);
        await Promise.allSettled([whoami(client), whoami(client), whoami(client)]);
        const refreshes = a
          .requests('POST', '/oauth/token')
          .filter((s) => s.params.get('grant_type') === 'refresh_token');
        // Whatever the SDK does, one refresh token never yields two token pairs.
        expect(refreshes.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
        // SDK 2.2.0 sends one refresh per failed request (and retries each once): more than one means reuse (P5-05),
        // and the whole device is revoked. If a future SDK serialises refreshes this branch stops applying.
        if (refreshes.length > 1) {
          await expect(whoami(client)).rejects.toThrow();
        }
        expect({ coalesced: refreshes.length === 1 }).toEqual({ coalesced: false });
        await client.close();
      });

      it('RFC 7009 revocation: the advertised endpoint revokes the refresh token and with it the device', async () => {
        const a = new App(profile);
        const client = await a.connect();
        const meta = (await (
          await app.fetch(new Request(`${ISSUER}/.well-known/oauth-authorization-server`))
        ).json()) as {
          revocation_endpoint?: string;
        };
        expect(meta.revocation_endpoint).toBe(`${ISSUER}/oauth/token`);
        const tokens = a.tokens;
        const res = await a.fetchFn(meta.revocation_endpoint as string, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: tokens.refresh_token as string,
            token_type_hint: 'refresh_token',
            client_id: profile.cimd?.id ?? (a.provider.info?.client_id as string),
          }).toString(),
        });
        expect(res.status).toBe(200);
        // The device is gone: the access token no longer works and the SDK cannot get a new one without a new consent.
        advance(1000);
        await expect(client.callTool({ name: 'whoami', arguments: {} })).rejects.toThrow();
        await client.close();
      });

      it('after the device is gone the SDK drops its tokens and asks for a new authorization instead of looping', async () => {
        const a = new App(profile);
        const client = await a.connect();
        for (const k of (await h.world.storage.kv.list({ prefix: 'oauth:grant:usr_a:' })).keys) {
          await h.world.storage.kv.delete(k.name);
        }
        advance(601_000);
        a.provider.authorizationUrl = null;
        await expect(client.callTool({ name: 'whoami', arguments: {} })).rejects.toBeInstanceOf(
          UnauthorizedError,
        );
        expect(a.provider.invalidated.length).toBeGreaterThan(0);
        expect(a.provider.authorizationUrl).not.toBeNull();
        // Bounded: a refresh and at most one retry, every one refused; no unbounded loop.
        const attempts = a
          .requests('POST', '/oauth/token')
          .filter((s) => s.params.get('grant_type') === 'refresh_token');
        expect(attempts.length).toBeLessThanOrEqual(2);
        expect(attempts.every((r) => r.status === 400)).toBe(true);
        await client.close();
      });

      it('the 401 challenge is enough: a client with no prior knowledge finds everything from the MCP URL', async () => {
        const a = new App(profile);
        await a.startAuthorization();
        const unauth = a.seen[0] as Seen;
        expect(unauth.status).toBe(401);
        expect(unauth.path).toBe('/p/prod/mcp');
        expect(unauth.bearer).toBeNull();
      });

      it('a token for one project is refused on another, with the same discovery challenge (audience binding)', async () => {
        const a = new App(profile);
        const client = await a.connect('prod');
        await client.close();
        const res = await a.fetchFn(resourceOf('other'), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${a.tokens.access_token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toContain(
          '/.well-known/oauth-protected-resource/p/other/mcp',
        );
      });
    });
  }

  describe('SDK behaviours the matrix relies on', () => {
    it('a user who denies consent: the SDK sees access_denied on the redirect, nothing is issued', async () => {
      const a = new App(PROFILES[0] as Profile);
      const transport = await a.startAuthorization();
      consent.next = 'deny';
      const res = await app.fetch(new Request(a.provider.authorizationUrl as URL));
      const location = new URL(res.headers.get('location') as string);
      expect(location.searchParams.get('error')).toBe('access_denied');
      expect(location.searchParams.get('code')).toBeNull();
      expect(a.provider.saved).toBeUndefined();
      void transport;
    });

    describe('scopes and parameters claude.ai is documented or reported to send', () => {
      const authorizeAs = async (scope: string | undefined, extra: Record<string, string> = {}) => {
        const a = new App(PROFILES[0] as Profile);
        const url = new URL(`${ISSUER}/oauth/authorize`);
        const { verifier: _v, challenge } = await pkce();
        for (const [k, v] of Object.entries({
          response_type: 'code',
          client_id: CLAUDE_AI_ID,
          redirect_uri: CLAUDE_AI_CALLBACK,
          state: 'st-1',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          resource: resourceOf('prod'),
          ...(scope === undefined ? {} : { scope }),
          ...extra,
        })) {
          url.searchParams.set(k, v);
        }
        const res = await a.fetchFn(url, { redirect: 'manual' });
        return new URL(res.headers.get('location') ?? ISSUER);
      };

      it.each([
        [
          'mcp:read offline_access',
          'the scope the 401 challenge and AS metadata advertise (what claude.ai requests)',
        ],
        ['mcp:read', 'without offline_access'],
        [undefined, 'no scope parameter'],
      ])('%s: %s', async (scope) => {
        const location = await authorizeAs(scope, { prompt: 'consent' });
        expect(location.searchParams.get('error'), location.toString()).toBeNull();
        expect(location.searchParams.get('code')).toBeTruthy();
      });

      it('"mcp offline_access" (reported in anthropics/claude-ai-mcp#1092 for another server): accepted, never an invalid_scope', async () => {
        // The consent seam grants `mcp:read` (plus offline_access when asked) whatever else the client names, so a
        // client that sends a bare `mcp` still connects; grants decide access, not scopes (pending decision P5-01).
        const location = await authorizeAs('mcp offline_access');
        expect(location.searchParams.get('error'), location.toString()).toBeNull();
        expect(location.searchParams.get('code')).toBeTruthy();
      });
    });

    it('the authorization server metadata advertises what these clients select on', async () => {
      const res = await app.fetch(new Request(`${ISSUER}/.well-known/oauth-authorization-server`));
      const meta = (await res.json()) as Record<string, unknown>;
      expect(meta.issuer).toBe(ISSUER);
      expect(meta.code_challenge_methods_supported).toEqual(['S256']);
      expect(meta.client_id_metadata_document_supported).toBe(true);
      expect(meta.registration_endpoint).toBe(`${ISSUER}/oauth/register`);
      expect(meta.token_endpoint_auth_methods_supported).toContain('none');
      expect(meta.grant_types_supported).toEqual(
        expect.arrayContaining(['authorization_code', 'refresh_token']),
      );
      expect(meta.authorization_response_iss_parameter_supported).toBe(true);
    });
  });
}
