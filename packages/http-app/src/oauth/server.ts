// SPDX-License-Identifier: Apache-2.0
// OAuth 2.1 authorization server for MCP clients (P5-01, ADR-0009, ADR-0011): `@cloudflare/workers-oauth-provider`
// run unmodified on Node and Workers, in one origin with the per-project MCP endpoints.
//
// - Issuer = the configured public URL (never the `Host` header): one authorization server whose resources are the
//   per-project URLs `{issuer}/p/{slug}/mcp`. Instances are built per request from the resources the request needs
//   and cached by resource set (configuration only, no request data, T21).
// - State lives in the storage `kv` table under `oauth:` (`kv-namespace.ts`), strongly consistent on both runtimes.
// - Authorization codes are single-use under concurrency: approving writes a marker that the token endpoint consumes
//   with the atomic `kv.take` before the provider sees the code (the provider's own check is read-then-write).
// - The interactive part of `/oauth/authorize` (sign-in, choosing a grant, consent) is the `consent` handler (P5-04);
//   `approve()` re-runs the access resolver, so an approval can't bind a token to a grant the user may not use.
// - Each project is one protected resource with its own RFC 9728 metadata (P5-02), built from the path alone so known
//   and unknown slugs answer alike (T19); the MCP route's 401 points at it (`resource_metadata`).
// - An OAuth access token on `/p/{slug}/mcp` is validated for that slug's resource only (RFC 8707 audience), its
//   props are cross-checked, and its grant goes through `resolveAccess` like a device token's (deny by default).
// The provider module is imported lazily: stdio and token-only deployments never load it.
import type {
  AuthorizationErrorCode,
  AuthRequest,
  ClientInfo,
  OAuthAuthorizationServer,
  OAuthHelpers,
  AuthorizationError as ProviderAuthorizationError,
} from '@cloudflare/workers-oauth-provider';
import { type DenyReason, type EffectiveAccess, resolveAccess } from '@relic-bridge/auth';
import type { Clock, Logger } from '@relic-bridge/core';
import { type CredentialRecord, type KvRepository, SLUG_RE, type Storage } from '@relic-bridge/storage';
import type { Context } from 'hono';
import { type OAuthKvNamespace, oauthKvNamespace } from './kv-namespace.ts';

export const OAUTH_AUTHORIZE_PATH = '/oauth/authorize';
export const OAUTH_TOKEN_PATH = '/oauth/token';
export const OAUTH_REGISTER_PATH = '/oauth/register';
/** RFC 8414 metadata of an issuer without a path. */
export const OAUTH_METADATA_PATH = '/.well-known/oauth-authorization-server';
/** RFC 9728 well-known prefix; a project's metadata is at `{prefix}/p/{slug}/mcp` (path insertion, §3.1). */
export const OAUTH_PROTECTED_RESOURCE_PREFIX = '/.well-known/oauth-protected-resource';
/** The challenge realm of MCP routes (unchanged from P2-06; OAuth adds parameters to it). */
export const MCP_REALM = 'relic-bridge';

/** The scope every MCP token carries (read-only tools). Grants, not scopes, decide what a token may do. */
export const MCP_SCOPE = 'mcp:read';
export const OAUTH_SCOPES: readonly string[] = Object.freeze([MCP_SCOPE, 'offline_access']);

export const DEFAULT_OAUTH_ACCESS_TTL_S = 3600;
export const DEFAULT_OAUTH_REFRESH_TTL_S: number = 30 * 86_400;
/** How long an authorization code may wait for its exchange (the provider's own grant TTL is the same). */
export const OAUTH_CODE_TTL_S = 600;
/** Largest token or registration request body read. */
export const OAUTH_MAX_BODY_BYTES: number = 16 * 1024;

/** Stable reasons an OAuth bearer is refused on an MCP route (logs and audit only; the client gets the same 401). */
export type OAuthDenyReason = 'oauth_invalid' | 'oauth_mismatch';
export const OAUTH_DENY_REASONS: readonly OAuthDenyReason[] = Object.freeze([
  'oauth_invalid',
  'oauth_mismatch',
] as const);

/** What a grant's token carries (encrypted at rest by the provider; handed back on validation). */
export interface OAuthGrantProps {
  readonly grantId: string;
  readonly projectSlug: string;
  readonly userId: string;
  readonly clientId: string;
}

/** The authorization request as the consent step sees it (validated: client, redirect URI, PKCE S256, resource). */
export interface OAuthAuthorizationRequest {
  readonly clientId: string;
  /** From the client's registration or metadata document: untrusted text, escape before display. */
  readonly clientName: string | null;
  readonly redirectUri: string;
  /** Show prominently on the consent screen (phishing resistance, P5-04). */
  readonly redirectHost: string;
  readonly scope: readonly string[];
  /** The RFC 8707 resource (`{issuer}/p/{slug}/mcp`). */
  readonly resource: string;
  /** The project named by the resource. Not looked up yet: unknown slugs fail at `approve()` (no slug probing). */
  readonly projectSlug: string;
}

export type OAuthApproval =
  | { readonly ok: true; readonly redirectTo: string }
  | { readonly ok: false; readonly reason: DenyReason };

/** What the consent handler can do with the request. */
export interface OAuthConsentApi {
  readonly request: OAuthAuthorizationRequest;
  /** The provider's parsed request and helpers, for its consent/upstream helpers (P5-04). */
  readonly authRequest: AuthRequest;
  readonly helpers: OAuthHelpers;
  /**
   * Approve for a signed-in user and one of their grants on the project. Re-checks access first (grant of this user and
   * project, live, usable credential, owner boundary); on success returns the redirect carrying the code.
   */
  approve(input: { readonly userId: string; readonly grantId: string }): Promise<OAuthApproval>;
  /** The `access_denied` redirect (with `state` and `iss`). */
  deny(description?: string): string;
}

/** The interactive step of `/oauth/authorize` (P5-04: sign-in, grant choice, consent). */
export type OAuthConsentHandler = (c: Context, api: OAuthConsentApi) => Response | Promise<Response>;

/** `createHttpApp({ oauth })`: needs sign-in (`identity`), whose public URL is the issuer and whose `kv` holds state. */
export interface OAuthOptions {
  readonly consent: OAuthConsentHandler;
  /** Access-token lifetime in seconds, 60-86400. Default 3600 (plan presets: P5-05). */
  readonly accessTokenTtlSeconds?: number;
  /** Refresh-token lifetime in seconds, 0 (no refresh tokens) or 60-31536000. Default 30 days. */
  readonly refreshTokenTtlSeconds?: number;
  /** RFC 7591 dynamic client registration at `/oauth/register`. Default on (hardening: P5-03). */
  readonly registration?: boolean;
}

export type OAuthAuthentication =
  | {
      readonly ok: true;
      /** `oauth_` + the provider grant id: stable per device authorization, across refreshes. Not a secret. */
      readonly tokenId: string;
      readonly clientId: string;
      /** Epoch ms. */
      readonly tokenExpiresAt: number;
      readonly access: EffectiveAccess;
      readonly credential: CredentialRecord;
    }
  | { readonly ok: false; readonly stage: 'token'; readonly reason: OAuthDenyReason }
  | { readonly ok: false; readonly stage: 'access'; readonly tokenId: string; readonly reason: DenyReason };

type ProviderModule = typeof import('@cloudflare/workers-oauth-provider');
interface ProviderEnv {
  readonly OAUTH_KV: OAuthKvNamespace;
}

/** `userId:grantId:secret` as the provider issues them (user ids are ours: `usr_` + 32 hex). */
const PROVIDER_TOKEN_RE = /^([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{32})$/;
const MAX_CACHED_SERVERS = 64;
const CODE_MARKER_PREFIX = 'oauth-code:';

/** Longest provider-issued token accepted (`userId` ≤ 128 characters, ours are 36). */
export const MAX_OAUTH_TOKEN_CHARS = 200;

/** Cheap offline check: could this be a provider-issued token (access, refresh or code)? */
export function looksLikeOAuthToken(token: string): boolean {
  return token.length <= MAX_OAUTH_TOKEN_CHARS && PROVIDER_TOKEN_RE.test(token);
}

/** Whether any parameter appears more than once. */
function repeated(params: URLSearchParams): boolean {
  const seen = new Set<string>();
  for (const name of params.keys()) {
    if (seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

function checkInt(name: string, value: number, min: number, max: number, zeroOk = false): number {
  if (!Number.isSafeInteger(value) || ((value < min || value > max) && !(zeroOk && value === 0))) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}${zeroOk ? ' (or 0)' : ''}`);
  }
  return value;
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

/**
 * The request body as text, at most `max` bytes (declared or streamed); `null` when it is larger. The caller has
 * already refused a declared length above the limit.
 */
async function readBounded(request: Request, max: number): Promise<string | null> {
  const body = request.body;
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export interface OAuthRuntimeDeps {
  readonly options: OAuthOptions;
  /** Issuer origin (`https://bridge.example.com`), from the configured public URL. */
  readonly issuer: string;
  readonly kv: Pick<KvRepository, 'get' | 'put' | 'delete' | 'list' | 'take'>;
  readonly storage: Pick<Storage, 'projects' | 'grants' | 'users' | 'credentials'>;
  readonly catalog: readonly string[];
  readonly clock: Clock;
  readonly logger: Logger;
  readonly runInBackground: (c: Context, task: Promise<unknown>, what: string) => void;
}

/** One app's OAuth server: the route handlers and the MCP-route token check. Holds configuration and caches only. */
export interface OAuthRuntime {
  readonly issuer: string;
  /** The resource URL of a project slug. */
  resourceUrl(slug: string): string;
  /**
   * The `WWW-Authenticate` value of every 401 on `/p/{slug}/mcp`: a function of the path only (never of whether the
   * project exists or why the request was refused), with `resource_metadata` and `scope` for a valid slug.
   */
  challenge(slug: string): string;
  metadata(c: Context): Promise<Response>;
  /** RFC 9728 metadata of `/p/{slug}/mcp`; the project is not looked up (no slug probing). */
  protectedResource(slug: string): Response;
  authorize(c: Context): Promise<Response>;
  token(c: Context, onRevocation: () => void): Promise<Response>;
  register(c: Context): Promise<Response>;
  /** Validate an OAuth bearer for `/p/{slug}/mcp` and resolve its access. Storage errors propagate (fail closed). */
  authenticate(token: string, slug: string): Promise<OAuthAuthentication>;
}

export function createOAuthRuntime(deps: OAuthRuntimeDeps): OAuthRuntime {
  const { options, logger, clock } = deps;
  const issuer = new URL(deps.issuer).origin;
  const accessTtl = checkInt(
    'oauth.accessTokenTtlSeconds',
    options.accessTokenTtlSeconds ?? DEFAULT_OAUTH_ACCESS_TTL_S,
    60,
    86_400,
  );
  const refreshTtl = checkInt(
    'oauth.refreshTokenTtlSeconds',
    options.refreshTokenTtlSeconds ?? DEFAULT_OAUTH_REFRESH_TTL_S,
    60,
    365 * 86_400,
    true,
  );
  const registration = options.registration ?? true;
  const env: ProviderEnv = Object.freeze({ OAUTH_KV: oauthKvNamespace(deps.kv) });
  const resourceUrl = (slug: string): string => `${issuer}/p/${slug}/mcp`;
  /** Declared for routes that need no project (metadata, registration): never a valid slug, so never a token's. */
  const placeholderResource = `${issuer}/p/-/mcp`;

  let loaded: Promise<ProviderModule> | undefined;
  const provider = (): Promise<ProviderModule> => {
    loaded ??= import('@cloudflare/workers-oauth-provider');
    return loaded;
  };

  const servers = new Map<string, OAuthAuthorizationServer<ProviderEnv>>();
  const server = async (resources: readonly string[]): Promise<OAuthAuthorizationServer<ProviderEnv>> => {
    const list = resources.length === 0 ? [placeholderResource] : [...new Set(resources)].sort();
    const key = list.join('\n');
    const cached = servers.get(key);
    if (cached) return cached;
    const mod = await provider();
    const built = new mod.OAuthAuthorizationServer<ProviderEnv>({
      issuer,
      resources: list,
      scopesSupported: [...OAUTH_SCOPES],
      authorizeEndpoint: OAUTH_AUTHORIZE_PATH,
      tokenEndpoint: OAUTH_TOKEN_PATH,
      ...(registration ? { clientRegistrationEndpoint: OAUTH_REGISTER_PATH } : {}),
      accessTokenTTL: accessTtl,
      refreshTokenTTL: refreshTtl,
      // CIMD needs the SSRF guard (Workers flag / Node connect-time check): P5-03.
      clientIdMetadataDocumentEnabled: false,
      allowTokenExchangeGrant: false,
      // Stable server-side reasons only: never the description's echoed input or the error detail.
      onError: ({ code, status, internal }) => {
        logger.debug('oauth error response', { code, status, reason: internal?.reason ?? null });
      },
    });
    if (servers.size >= MAX_CACHED_SERVERS) servers.delete(servers.keys().next().value as string);
    servers.set(key, built);
    return built;
  };
  const allProjects = async (): Promise<OAuthAuthorizationServer<ProviderEnv>> =>
    server((await deps.storage.projects.list()).map((p) => resourceUrl(p.slug)));

  /** The request re-addressed to the issuer origin (the provider compares endpoints with the issuer's URLs). */
  const atIssuer = (c: Context, body?: string): Request => {
    const url = new URL(c.req.url);
    const headers = new Headers(c.req.raw.headers);
    headers.delete('content-length');
    return new Request(`${issuer}${url.pathname}${url.search}`, {
      method: c.req.method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
  };
  const executionContext = (c: Context) => ({
    waitUntil: (task: Promise<unknown>) => deps.runInBackground(c, task, 'oauth'),
    passThroughOnException: () => undefined,
    props: {},
  });
  const fetchProvider = async (
    as: OAuthAuthorizationServer<ProviderEnv>,
    c: Context,
    body?: string,
  ): Promise<Response> =>
    // The provider's fetch takes the Workers `ExecutionContext`; it only calls `waitUntil` on it.
    as.fetch(atIssuer(c, body), env, executionContext(c) as unknown as Parameters<typeof as.fetch>[2]);

  /**
   * A slug when `resource` is exactly one of our per-project resource URLs. Scheme and host compare
   * case-insensitively (MCP 2026-07-28 "SHOULD accept uppercase scheme and host"; the issuer origin is lowercase),
   * the rest exactly.
   */
  const slugOf = (resource: string): string | null => {
    if (resource.slice(0, issuer.length).toLowerCase() !== issuer) return null;
    const path = resource.slice(issuer.length);
    if (!path.startsWith('/p/') || !path.endsWith('/mcp')) return null;
    const slug = path.slice('/p/'.length, -'/mcp'.length);
    return SLUG_RE.test(slug) ? slug : null;
  };
  /** RFC 8707 on a request: exactly one `resource`, one of ours. */
  const targetSlug = (params: URLSearchParams): string | null => {
    const resources = params.getAll('resource');
    return resources.length === 1 ? slugOf(resources[0] as string) : null;
  };
  const resourceMetadataUrl = (slug: string): string =>
    `${issuer}${OAUTH_PROTECTED_RESOURCE_PREFIX}/p/${slug}/mcp`;

  const codeMarker = async (code: string): Promise<string> => `${CODE_MARKER_PREFIX}${await sha256Hex(code)}`;

  /** A replayed (or raced) code: when it really was issued for its grant, revoke the grant and its tokens. */
  const revokeReplayed = async (code: string, helpers: OAuthHelpers): Promise<void> => {
    const m = PROVIDER_TOKEN_RE.exec(code);
    if (m === null) return;
    const [, userId, grantId] = m as unknown as [string, string, string];
    const grant = (await env.OAUTH_KV.get(`grant:${userId}:${grantId}`, { type: 'json' })) as {
      readonly authCodeId?: unknown;
    } | null;
    if (grant === null || grant.authCodeId !== (await sha256Hex(code))) return;
    await helpers.revokeGrant(grantId, userId);
    logger.warn('oauth authorization code replayed; grant revoked', { oauthGrant: grantId });
  };

  return {
    issuer,
    resourceUrl,

    challenge(slug) {
      // Only a valid slug reaches the header (no quote or comma can), and nothing else does: the same value for every
      // denial on one URL. No `error=` (RFC 6750 §3.1): it would tell a missing token from a refused one.
      if (!SLUG_RE.test(slug)) return `Bearer realm="${MCP_REALM}"`;
      return `Bearer realm="${MCP_REALM}", resource_metadata="${resourceMetadataUrl(slug)}", scope="${MCP_SCOPE}"`;
    },

    protectedResource(slug) {
      // The app's own 404: an invalid slug's metadata URL is not a route at all.
      if (!SLUG_RE.test(slug)) {
        return new Response('{"error":"not_found"}', {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // RFC 9728 §2. No `resource_name`: the project's display name is not public (T19). No `offline_access` in
      // `scopes_supported`: refresh tokens are not a resource requirement (MCP 2026-07-28 §Refresh Tokens).
      const body = {
        resource: resourceUrl(slug),
        authorization_servers: [issuer],
        scopes_supported: [MCP_SCOPE],
        bearer_methods_supported: ['header'],
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },

    async metadata(c) {
      const response = await fetchProvider(await server([]), c);
      if (!response.ok) return response;
      // RFC 9728 `protected_resources` is optional. Project slugs are not public (T19), and this server only declares
      // a placeholder here: clients find a project's resource through its own metadata (P5-02).
      const meta = (await response.json()) as Record<string, unknown>;
      delete meta['protected_resources'];
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      return new Response(JSON.stringify(meta), { status: response.status, headers });
    },

    async register(c) {
      if (!registration) return jsonError(404, 'not_found', 'Client registration is disabled.');
      const body = await readBounded(c.req.raw, OAUTH_MAX_BODY_BYTES);
      if (body === null) return jsonError(413, 'invalid_request', 'Request body too large.');
      return fetchProvider(await server([]), c, body);
    },

    async token(c, onRevocation) {
      const body = await readBounded(c.req.raw, OAUTH_MAX_BODY_BYTES);
      if (body === null) return jsonError(413, 'invalid_request', 'Request body too large.');
      // The media type exactly as the provider reads it, so the code checked here is the code it exchanges.
      const mediaType = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
      const form = mediaType === 'application/x-www-form-urlencoded' ? new URLSearchParams(body) : null;
      // RFC 6749 §3.2: no parameter twice (else the code we consume and the code the provider reads could differ).
      if (form !== null && repeated(form)) {
        return jsonError(400, 'invalid_request', 'Parameters must not be repeated.');
      }
      const grantType = form?.get('grant_type') ?? null;
      // RFC 8707 / MCP 2026-07-28: the token request names its resource too. Checked before the code is consumed, so
      // a client that left it out can retry; the provider then requires it to be the grant's own resource.
      if (
        form !== null &&
        (grantType === 'authorization_code' || grantType === 'refresh_token') &&
        targetSlug(form) === null
      ) {
        return jsonError(400, 'invalid_target', 'resource must name one MCP endpoint of this server.');
      }
      const as = await allProjects();
      if (grantType === 'authorization_code') {
        const code = form?.get('code') ?? '';
        // Single use, atomically: of concurrent exchanges at most one finds the marker (P4 review note, T9).
        const fresh = looksLikeOAuthToken(code) && (await deps.kv.take(await codeMarker(code))) !== null;
        if (!fresh) {
          if (looksLikeOAuthToken(code)) await revokeReplayed(code, as.getOAuthApi(env));
          return jsonError(400, 'invalid_grant', 'Invalid authorization code');
        }
      }
      const response = await fetchProvider(as, c, body);
      // RFC 7009 revocation shares this endpoint (no grant_type): drop cached decisions here at once.
      if (form !== null && grantType === null && form.has('token') && response.ok) onRevocation();
      return response;
    },

    async authorize(c) {
      const url = new URL(c.req.url);
      // RFC 6749 §3.1: no parameter twice (what the consent step is shown must be what the provider acts on).
      if (repeated(url.searchParams)) {
        return jsonError(400, 'invalid_request', 'Parameters must not be repeated.');
      }
      // RFC 8707: exactly one resource, one of ours. Refused before the client is known, so never redirected.
      const slug = targetSlug(url.searchParams);
      if (slug === null) {
        return jsonError(400, 'invalid_target', 'resource must name one MCP endpoint of this server.');
      }
      const resource = resourceUrl(slug);
      const mod = await provider();
      const as = await server([resource]);
      const helpers = as.getOAuthApi(env);
      let authRequest: AuthRequest;
      try {
        authRequest = await helpers.parseAuthRequest(atIssuer(c));
      } catch (error) {
        if (error instanceof mod.AuthorizationError) {
          const e = error as ProviderAuthorizationError;
          // `redirectTo` is set only once the client and its redirect URI were validated (RFC 6749 §4.1.2.1).
          if (e.redirectTo) return redirect(e.redirectTo);
          return jsonError(400, e.code, e.description ?? 'Invalid authorization request.');
        }
        if (error instanceof mod.CimdFetchError) {
          return jsonError(400, 'invalid_client', 'The client metadata document could not be used.');
        }
        logger.debug('oauth authorize request refused', {
          error: error instanceof Error ? error.name : typeof error,
        });
        return jsonError(400, 'invalid_request', 'Invalid authorization request.');
      }
      const refuse = (code: AuthorizationErrorCode, description: string): Response =>
        redirect(mod.authorizationErrorRedirect(authRequest, code, description));
      // OAuth 2.1: PKCE for every client, S256 only (the provider insists only for public clients).
      if (!authRequest.codeChallenge || authRequest.codeChallengeMethod !== 'S256') {
        return refuse('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
      }
      if (authRequest.resource !== resource) return refuse('invalid_target', 'Unknown resource.');
      if (authRequest.responseType !== 'code') return refuse('unsupported_response_type', 'Use code.');
      const client: ClientInfo | null = await helpers.lookupClient(authRequest.clientId);
      if (client === null) return jsonError(400, 'invalid_client', 'Unknown client.');
      const requested = authRequest.scope;
      const scope = [MCP_SCOPE, ...(requested.includes('offline_access') ? ['offline_access'] : [])];
      const request: OAuthAuthorizationRequest = Object.freeze({
        clientId: authRequest.clientId,
        clientName: client.clientName ?? null,
        redirectUri: authRequest.redirectUri,
        redirectHost: new URL(authRequest.redirectUri).host,
        scope: Object.freeze(scope),
        resource,
        projectSlug: slug,
      });
      let used = false;
      const api: OAuthConsentApi = Object.freeze({
        request,
        authRequest,
        helpers,
        deny: (description = 'The user denied the request.') =>
          mod.authorizationErrorRedirect(authRequest, 'access_denied', description),
        approve: async ({ userId, grantId }: { readonly userId: string; readonly grantId: string }) => {
          if (used) throw new Error('an authorization request is approved at most once');
          used = true;
          // The same deny-by-default decision a request with the resulting token will get (owner boundary included).
          const decision = await resolveAccess({
            storage: deps.storage,
            projectSlug: slug,
            principal: { grantId, userId },
            catalog: deps.catalog,
            now: clock.now(),
          });
          if (!decision.ok) return { ok: false, reason: decision.reason } as const;
          if (decision.access.userId !== userId) return { ok: false, reason: 'principal_mismatch' } as const;
          const props: OAuthGrantProps = {
            grantId,
            projectSlug: slug,
            userId,
            clientId: authRequest.clientId,
          };
          const { redirectTo } = await helpers.completeAuthorization({
            request: authRequest,
            userId,
            // T25: grant metadata is stored unencrypted; keep it empty.
            metadata: {},
            scope,
            props,
          });
          const code = new URL(redirectTo).searchParams.get('code');
          if (code === null) throw new Error('the provider returned no authorization code');
          await deps.kv.put(await codeMarker(code), '1', { expirationTtl: OAUTH_CODE_TTL_S });
          return { ok: true, redirectTo } as const;
        },
      });
      return options.consent(c, api);
    },

    async authenticate(token, slug) {
      if (!SLUG_RE.test(slug) || !looksLikeOAuthToken(token)) {
        return { ok: false, stage: 'token', reason: 'oauth_invalid' };
      }
      const resource = resourceUrl(slug);
      const validated = await (await server([resource])).validateToken<OAuthGrantProps>(resource, token, env);
      if (validated === null) return { ok: false, stage: 'token', reason: 'oauth_invalid' };
      const props = validated.props as Partial<OAuthGrantProps> | null;
      if (
        validated.audience !== resource ||
        !validated.scope.includes(MCP_SCOPE) ||
        props === null ||
        typeof props !== 'object' ||
        typeof props.grantId !== 'string' ||
        props.projectSlug !== slug ||
        props.userId !== validated.userId ||
        props.clientId !== validated.clientId
      ) {
        return { ok: false, stage: 'token', reason: 'oauth_mismatch' };
      }
      const providerGrant = (PROVIDER_TOKEN_RE.exec(token) as RegExpExecArray)[2] as string;
      const tokenId = `oauth_${providerGrant}`;
      const decision = await resolveAccess({
        storage: deps.storage,
        projectSlug: slug,
        principal: { grantId: props.grantId, userId: props.userId },
        catalog: deps.catalog,
        now: clock.now(),
      });
      if (!decision.ok) return { ok: false, stage: 'access', tokenId, reason: decision.reason };
      if (decision.access.userId !== props.userId) {
        return { ok: false, stage: 'access', tokenId, reason: 'principal_mismatch' };
      }
      return {
        ok: true,
        tokenId,
        clientId: validated.clientId,
        tokenExpiresAt: validated.expiresAt * 1000,
        access: decision.access,
        credential: decision.credential,
      };
    },
  };
}
