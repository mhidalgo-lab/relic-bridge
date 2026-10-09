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
// - Token lifecycle (P5-05): every token issuance (code exchange, refresh) re-runs `resolveAccess` (a refusal revokes
//   the device), access tokens never outlive their grant, refresh tokens are single-use under concurrency (a marker
//   consumed with `kv.take`) and a reused one revokes its whole family. A device is one provider grant
//   (`oauth_<grantId>`); `devices` lists and revokes them for the admin API (P5-05).
// The provider module is imported lazily: stdio and token-only deployments never load it.
import type {
  AuthorizationErrorCode,
  AuthRequest,
  ClientInfo,
  OAuthAuthorizationServer,
  OAuthHelpers,
  AuthorizationError as ProviderAuthorizationError,
  TokenExchangeCallbackOptions,
  TokenExchangeCallbackResult,
} from '@cloudflare/workers-oauth-provider';
import { type DenyReason, type EffectiveAccess, resolveAccess } from '@relic-bridge/auth';
import type { Clock, Logger } from '@relic-bridge/core';
import { type CredentialRecord, type KvRepository, SLUG_RE, type Storage } from '@relic-bridge/storage';
import type { Context } from 'hono';
import type { AdminAuditEvent } from '../audit.ts';
import {
  ClientMetadataError,
  type ClientMetadataFetch,
  checkRegistration,
  clientIdUrlProblem,
  fetchMetadataDocument,
  looksLikeClientIdUrl,
  readBoundedBytes,
  safeClientName,
} from './clients.ts';
import { type OAuthKvNamespace, oauthKvNamespace } from './kv-namespace.ts';
import { forgetApprovals, type StoredApproval } from './remembered.ts';

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
/** Dynamic registrations per window, across every isolate and process (shared `kv` counter, P5-03). */
export const DEFAULT_OAUTH_REGISTRATION_LIMIT: { readonly requests: number; readonly perSeconds: number } =
  Object.freeze({ requests: 30, perSeconds: 3600 });
/** A dynamic registration that never exchanges a code is gone after this (the first exchange renews it). */
export const OAUTH_UNUSED_REGISTRATION_TTL_S = 86_400;
/** Least lifetime of a used dynamic registration (renewed by the provider at half-life on every token request). */
export const OAUTH_MIN_REGISTRATION_TTL_S: number = 90 * 86_400;

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
  /**
   * `metadata_document`: the client id is the https URL of a document we fetched (CIMD); show {@link clientHost}.
   * `dynamic`: registered through `/oauth/register` by anyone (DCR): nothing about it is verified.
   */
  readonly clientKind: 'metadata_document' | 'dynamic';
  /** CIMD: the host of the client id (the draft says to show it); null for dynamic clients. */
  readonly clientHost: string | null;
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
  /** `client_refused`: a metadata-document client whose document can no longer be fetched or validated. */
  | { readonly ok: false; readonly reason: DenyReason | 'client_refused' };

/** What the consent handler can do with the request. */
export interface OAuthConsentApi {
  readonly request: OAuthAuthorizationRequest;
  /** The provider's parsed request and helpers, for its consent/upstream helpers (P5-04). */
  readonly authRequest: AuthRequest;
  readonly helpers: OAuthHelpers;
  /**
   * Approve for a signed-in user and one of their grants on the project. Re-checks access first (grant of this user and
   * project, live, usable credential, owner boundary); on success returns the redirect carrying the code. `label`
   * (P5-04): the device name the user gave, kept as the provider grant's only metadata (checked text, ≤ 60 characters).
   */
  approve(input: {
    readonly userId: string;
    readonly grantId: string;
    readonly label?: string | null;
  }): Promise<OAuthApproval>;
  /** The `access_denied` redirect (with `state` and `iss`). */
  deny(description?: string): string;
}

/** The interactive step of `/oauth/authorize` (P5-04: sign-in, grant choice, consent). */
export type OAuthConsentHandler = (c: Context, api: OAuthConsentApi) => Response | Promise<Response>;

/** `createHttpApp({ oauth })`: needs sign-in (`identity`), whose public URL is the issuer and whose `kv` holds state. */
export interface OAuthOptions {
  /**
   * The interactive step of `/oauth/authorize`. Default: the built-in sign-in and consent screen (P5-04,
   * `consent.ts`). Tests may inject a stand-in.
   */
  readonly consent?: OAuthConsentHandler;
  /** Access-token lifetime in seconds, 60-86400. Default 3600 on every plan (P5-05). Capped at the grant's expiry. */
  readonly accessTokenTtlSeconds?: number;
  /**
   * Absolute refresh lifetime of a device authorization in seconds, 0 (no refresh tokens) or 60-31536000. Default 30
   * days, counted from the code exchange; refreshing never extends it (P5-05). Capped at the grant's expiry.
   */
  readonly refreshTokenTtlSeconds?: number;
  /** RFC 7591 dynamic client registration at `/oauth/register`. Default on. */
  readonly registration?: boolean;
  /**
   * Dynamic registrations allowed per window, shared by every isolate and process (a `kv` counter). Default 30 per
   * hour; `null` turns the cap off (the per-IP `oauth` rate limit still applies).
   */
  readonly registrationLimit?: { readonly requests: number; readonly perSeconds: number } | null;
  /** When set, dynamically registered https redirect URIs must be on one of these hosts (loopback is always allowed). */
  readonly registrationRedirectHosts?: readonly string[];
  /**
   * Client ID Metadata Documents (CIMD, P5-03): off unless the host gives a fetcher that refuses non-public
   * destinations and does not follow redirects (Node: `apps/cli` connect-time guard; Workers: the
   * `global_fetch_strictly_public` flag). Then https client ids are resolved by fetching their document.
   */
  readonly clientMetadataDocuments?: { readonly fetch: ClientMetadataFetch };
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
  /** The request being served (audit rows); absent for calls outside a request. */
  readonly RB_REQUEST_ID?: string;
}

/** `userId:grantId:secret` as the provider issues them (user ids are ours: `usr_` + 32 hex). */
const PROVIDER_TOKEN_RE = /^([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{32})$/;
const MAX_CACHED_SERVERS = 64;
const CODE_MARKER_PREFIX = 'oauth-code:';
/**
 * Refresh-token markers (P5-05), `oauth-refresh:<sha256(token)>`: `live` for the one usable refresh token of a device,
 * `used` once it has been rotated. Taken with `kv.take` before the provider sees the token.
 */
const REFRESH_MARKER_PREFIX = 'oauth-refresh:';
const REFRESH_LIVE = 'live';
/**
 * Revoked device tombstones, `oauth-revoked:<userId>:<grantId>`: written before a device is revoked, so a token
 * request the provider was answering at that moment (it reads the grant, then writes it back) can't bring the device
 * back: the token endpoint looks for the tombstone after the provider answered and revokes again.
 */
const TOMBSTONE_PREFIX = 'oauth-revoked:';
const REFRESH_USED = 'used';
/** An OAuth device's public id: `oauth_` + the provider grant id (also the audit `tokenId`). */
const DEVICE_ID_RE = /^oauth_([A-Za-z0-9_-]{16})$/;
/** Access grant ids as stored in grant metadata (the admin API's id shape). */
const ACCESS_GRANT_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Devices read per user (listing and revoke-all). */
export const MAX_OAUTH_DEVICES_PER_USER = 100;
/** Shared registration counter windows (`kv`, outside the provider's `oauth:` namespace). */
const REGISTRATION_COUNTER_PREFIX = 'oauth-dcr-count:';

/** Longest provider-issued token accepted (`userId` ≤ 128 characters, ours are 36). */
export const MAX_OAUTH_TOKEN_CHARS = 200;

/** Cheap offline check: could this be a provider-issued token (access, refresh or code)? */
export function looksLikeOAuthToken(token: string): boolean {
  return token.length <= MAX_OAUTH_TOKEN_CHARS && PROVIDER_TOKEN_RE.test(token);
}

/** A device label as stored: trimmed, safe display text (no control, bidi or zero-width characters), else null. */
export function deviceLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_DEVICE_LABEL_CHARS) return null;
  return safeClientName(text);
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

/** The request body as text, at most `max` bytes (declared or streamed); `null` when it is larger. */
async function readBounded(request: Request, max: number): Promise<string | null> {
  const bytes = await readBoundedBytes(request.body, max);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

export interface OAuthRuntimeDeps {
  readonly options: OAuthOptions;
  /** Issuer origin (`https://bridge.example.com`), from the configured public URL. */
  readonly issuer: string;
  readonly kv: Pick<KvRepository, 'get' | 'put' | 'delete' | 'list' | 'take' | 'increment'>;
  readonly storage: Pick<Storage, 'projects' | 'grants' | 'users' | 'credentials'>;
  readonly catalog: readonly string[];
  readonly clock: Clock;
  readonly logger: Logger;
  readonly runInBackground: (c: Context, task: Promise<unknown>, what: string) => void;
  /** Used when `options.consent` is not given (the built-in screen). */
  readonly defaultConsent?: OAuthConsentHandler;
  /** `admin` audit rows (refresh reuse, refused issuance); never rejects. */
  readonly audit?: (event: AdminAuditEvent) => Promise<void>;
}

/** Longest device label kept as grant metadata (P5-04). */
export const MAX_DEVICE_LABEL_CHARS = 60;

/** One OAuth device authorization (a provider grant) as the admin API shows it (P5-05). No token material. */
export interface OAuthDevice {
  /** `oauth_` + the provider grant id: the audit `tokenId` of its requests. */
  readonly id: string;
  readonly userId: string;
  readonly clientId: string;
  /** From the client's registration or metadata document (untrusted text, checked when stored); null if unknown now. */
  readonly clientName: string | null;
  readonly clientKind: 'metadata_document' | 'dynamic';
  /** CIMD: the client id's host; null for dynamic clients. */
  readonly clientHost: string | null;
  /** The device name typed on the consent page. */
  readonly label: string | null;
  /** The project of the token's resource. */
  readonly projectSlug: string | null;
  /** The access grant the device was approved with (null for authorizations made before P5-05). */
  readonly grantId: string | null;
  /** Epoch ms. */
  readonly createdAt: number;
  /** End of the refresh lifetime (epoch ms); null when it has none. */
  readonly expiresAt: number | null;
}

/** OAuth devices of a user: list and revoke (admin API, P5-05). Revoking also forgets remembered approvals. */
export interface OAuthDevices {
  list(userId: string): Promise<readonly OAuthDevice[]>;
  /** Revoke one device (its whole token family); null when the user has no such device. */
  revoke(userId: string, deviceId: string): Promise<OAuthDevice | null>;
  /**
   * Revoke every device of the user, or only those approved with one access grant / for one project (revoke-all when a
   * grant is revoked, a user disabled or a project deleted). Resolves with the number revoked.
   */
  revokeAll(
    userId: string,
    filter?: { readonly grantId?: string; readonly projectSlug?: string },
  ): Promise<number>;
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
  /**
   * Validate an authorization request given as query parameters (the consent form re-validates the request it shows
   * on every step, P5-04): the error answer (400 page or error redirect), or the consent API for it.
   */
  prepare(c: Context, params: URLSearchParams): Promise<Response | OAuthConsentApi>;
  token(c: Context, onRevocation: () => void): Promise<Response>;
  register(c: Context): Promise<Response>;
  /** Validate an OAuth bearer for `/p/{slug}/mcp` and resolve its access. Storage errors propagate (fail closed). */
  authenticate(token: string, slug: string): Promise<OAuthAuthentication>;
  /** Users' OAuth devices (P5-05). */
  readonly devices: OAuthDevices;
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
  const registrationLimit =
    options.registrationLimit === undefined ? DEFAULT_OAUTH_REGISTRATION_LIMIT : options.registrationLimit;
  if (registrationLimit !== null) {
    checkInt('oauth.registrationLimit.requests', registrationLimit.requests, 1, 100_000);
    checkInt('oauth.registrationLimit.perSeconds', registrationLimit.perSeconds, 60, 86_400);
  }
  const redirectHosts = options.registrationRedirectHosts?.map((h) => {
    const host = h.trim().toLowerCase();
    if (!/^[a-z0-9.-]{1,253}$/.test(host) || !host.includes('.')) {
      throw new TypeError('oauth.registrationRedirectHosts must be host names');
    }
    return host;
  });
  const consent = options.consent ?? deps.defaultConsent;
  if (typeof consent !== 'function') throw new TypeError('oauth.consent must be a function');
  const cimd = options.clientMetadataDocuments;
  if (cimd !== undefined && typeof cimd.fetch !== 'function') {
    throw new TypeError('oauth.clientMetadataDocuments.fetch must be a function');
  }
  // A used registration must outlive every refresh token issued to it: the provider renews it at half-life on each
  // token request, so twice the refresh lifetime is enough.
  const registrationTtl = Math.max(OAUTH_MIN_REGISTRATION_TTL_S, 2 * refreshTtl, 2 * accessTtl);
  const env: ProviderEnv = Object.freeze({ OAUTH_KV: oauthKvNamespace(deps.kv) });
  const issuerHost = new URL(issuer).hostname;
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
      // CIMD is resolved by us (`resolveClient`, ADR-0012) and handed to the provider as a stored client record.
      clientIdMetadataDocumentEnabled: false,
      clientRegistrationTTL: registrationTtl,
      allowTokenExchangeGrant: false,
      // P5-05: access is decided again on every issuance (code exchange and refresh).
      tokenExchangeCallback: (o) => checkIssuance(mod, o),
      // Stable server-side reasons only: never the description's echoed input or the error detail.
      onError: ({ code, status, internal }) => {
        logger.debug('oauth error response', { code, status, reason: internal?.reason ?? null });
      },
    });
    if (servers.size >= MAX_CACHED_SERVERS) servers.delete(servers.keys().next().value as string);
    servers.set(key, built);
    return built;
  };
  /**
   * Every token issuance (code exchange, refresh) re-runs the access decision for the grant the device was approved
   * with. A refusal is `invalid_grant`, on which the provider revokes the device's grant (its whole token family). On
   * success the access token (and, at the code exchange, the refresh lifetime) is capped at the grant's own expiry.
   */
  const checkIssuance = async (
    mod: ProviderModule,
    o: TokenExchangeCallbackOptions<ProviderEnv>,
  ): Promise<TokenExchangeCallbackResult | undefined> => {
    const code = o.grantType === mod.GrantType.AUTHORIZATION_CODE;
    if (!code && o.grantType !== mod.GrantType.REFRESH_TOKEN) {
      throw new mod.OAuthError('unsupported_grant_type', { description: 'Grant type not supported' });
    }
    const refuse = async (reason: string): Promise<never> => {
      logger.info('oauth token refused; device revoked', {
        reason,
        oauthGrant: o.grantId,
        grantType: o.grantType,
      });
      await deps.audit?.({
        actor: {
          requestId: o.env.RB_REQUEST_ID ?? null,
          userId: o.userId,
          clientId: o.clientId.slice(0, 200),
          tokenId: `oauth_${o.grantId}`,
        },
        action: 'oauth.token.refused',
        targetType: 'oauth_device',
        targetId: `oauth_${o.grantId}`,
        status: 'denied',
        errorCode: reason,
        details: { grantType: o.grantType, revoked: true },
      });
      throw new mod.OAuthError('invalid_grant', { description: 'The authorization is no longer valid.' });
    };
    const props = o.props as Partial<OAuthGrantProps> | null;
    const slug = typeof o.resource === 'string' ? slugOf(o.resource) : null;
    if (
      props === null ||
      typeof props !== 'object' ||
      typeof props.grantId !== 'string' ||
      props.userId !== o.userId ||
      props.clientId !== o.clientId ||
      slug === null ||
      props.projectSlug !== slug
    ) {
      return refuse('oauth_mismatch');
    }
    const decision = await resolveAccess({
      storage: deps.storage,
      projectSlug: slug,
      principal: { grantId: props.grantId, userId: o.userId },
      catalog: deps.catalog,
      now: clock.now(),
    });
    if (!decision.ok) return refuse(decision.reason);
    if (decision.access.userId !== o.userId) return refuse('principal_mismatch');
    const grantEnd = decision.access.expiresAt;
    if (grantEnd === null) return undefined;
    const remaining = Math.floor((grantEnd - clock.now()) / 1000);
    if (remaining < 60) return refuse('grant_expired');
    return {
      accessTokenTTL: Math.min(accessTtl, remaining),
      ...(code && refreshTtl !== 0 ? { refreshTokenTTL: Math.min(refreshTtl, remaining) } : {}),
    };
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
  /** The provider's env for one request (the request id reaches the issuance check's audit rows). */
  const requestEnv = (c: Context): ProviderEnv => {
    const requestId = c.get('requestId') as unknown;
    return typeof requestId === 'string' ? { ...env, RB_REQUEST_ID: requestId } : env;
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
    as.fetch(
      atIssuer(c, body),
      requestEnv(c),
      executionContext(c) as unknown as Parameters<typeof as.fetch>[2],
    );

  /**
   * A slug when `resource` is exactly one of our per-project resource URLs. Scheme and host compare
   * case-insensitively (MCP 2026-07-28 "SHOULD accept uppercase scheme and host"; the issuer origin is lowercase),
   * the rest exactly.
   */
  const slugOf = (resource: string): string | null => {
    // ASCII folding only: `toLowerCase()` would also map e.g. U+212A KELVIN SIGN to `k`.
    if (resource.slice(0, issuer.length).replace(/[A-Z]/g, (ch) => ch.toLowerCase()) !== issuer) return null;
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

  /**
   * CIMD (P5-03): makes sure an https client id has a live client record, fetching and validating its document when
   * none is cached. Resolves null when the request may go on (not a URL client id, or resolved), else a stable reason.
   * Errors are never cached; a validated document is stored for its (bounded) HTTP cache lifetime.
   */
  const resolveClient = async (clientId: string | null | undefined): Promise<string | null> => {
    if (clientId === null || clientId === undefined || !looksLikeClientIdUrl(clientId)) return null;
    if (cimd === undefined) return 'cimd_disabled';
    const problem = clientIdUrlProblem(clientId, issuerHost);
    if (problem !== null) return problem;
    if ((await env.OAUTH_KV.get(`client:${clientId}`)) !== null) return null;
    try {
      const { client, ttlSeconds } = await fetchMetadataDocument(
        clientId,
        cimd.fetch,
        Math.floor(clock.now() / 1000),
      );
      await env.OAUTH_KV.put(`client:${clientId}`, JSON.stringify(client), { expirationTtl: ttlSeconds });
      return null;
    } catch (error) {
      return error instanceof ClientMetadataError ? error.reason : 'fetch_failed';
    }
  };
  const refusedClient = (clientId: string, reason: string): Response => {
    // The client id is public (a URL or a random id); log its host only, never the document.
    let host: string | null = null;
    try {
      host = new URL(clientId).hostname;
    } catch {
      // not a URL
    }
    logger.info('oauth client refused', { reason, clientHost: host });
    return jsonError(400, 'invalid_client', 'The client metadata document could not be used.');
  };

  const codeMarker = async (code: string): Promise<string> => `${CODE_MARKER_PREFIX}${await sha256Hex(code)}`;

  const tombstone = (userId: string, grantId: string): string => `${TOMBSTONE_PREFIX}${userId}:${grantId}`;
  /** Revoke a device's provider grant and every token of it, leaving a tombstone first (see {@link TOMBSTONE_PREFIX}). */
  const revokeFamily = async (userId: string, grantId: string, helpers: OAuthHelpers): Promise<void> => {
    await deps.kv.put(tombstone(userId, grantId), '1', {
      expirationTtl: Math.max(refreshTtl, accessTtl, 60),
    });
    await helpers.revokeGrant(grantId, userId);
  };
  /**
   * After the provider issued tokens for the token in `presented`: if its device was revoked meanwhile (a concurrent
   * reuse, an administrator), revoke again (the provider may have written the grant back) and refuse.
   */
  const revokedMeanwhile = async (presented: string, helpers: OAuthHelpers): Promise<boolean> => {
    const m = PROVIDER_TOKEN_RE.exec(presented);
    if (m === null) return false;
    const [, userId, grantId] = m as unknown as [string, string, string];
    if ((await deps.kv.get(tombstone(userId, grantId))) === null) return false;
    await helpers.revokeGrant(grantId, userId);
    logger.warn('oauth tokens issued for a revoked device; revoked again', { oauthGrant: grantId });
    return true;
  };

  /** A replayed (or raced) code: when it really was issued for its grant, revoke the grant and its tokens. */
  const revokeReplayed = async (code: string, helpers: OAuthHelpers): Promise<void> => {
    const m = PROVIDER_TOKEN_RE.exec(code);
    if (m === null) return;
    const [, userId, grantId] = m as unknown as [string, string, string];
    const grant = (await env.OAUTH_KV.get(`grant:${userId}:${grantId}`, { type: 'json' })) as {
      readonly authCodeId?: unknown;
    } | null;
    if (grant === null || grant.authCodeId !== (await sha256Hex(code))) return;
    await revokeFamily(userId, grantId, helpers);
    logger.warn('oauth authorization code replayed; grant revoked', { oauthGrant: grantId });
  };

  const refreshMarker = async (token: string): Promise<string> =>
    `${REFRESH_MARKER_PREFIX}${await sha256Hex(token)}`;
  /** A marker outlives every refresh token it can describe (the absolute refresh lifetime). */
  const markerTtl = Math.max(refreshTtl, 60);
  /** Mark the refresh token of a successful token response as the device's one live refresh token. */
  const markIssued = async (response: Response): Promise<void> => {
    if (!response.ok) return;
    const issued = ((await response.clone().json()) as { readonly refresh_token?: unknown }).refresh_token;
    if (typeof issued === 'string' && looksLikeOAuthToken(issued)) {
      await deps.kv.put(await refreshMarker(issued), REFRESH_LIVE, { expirationTtl: markerTtl });
    }
  };

  /**
   * A refresh token without a live marker. `used`: it was rotated already. Otherwise it may be one that a concurrent
   * request is rotating right now (it is still the grant's current or previous token): both are reuse, and revoke the
   * device's whole token family (RFC 9700 §4.14.2). A token the grant never had (a forged secret with a known grant id)
   * revokes nothing.
   */
  const refreshReused = async (
    c: Context,
    token: string,
    used: boolean,
    helpers: OAuthHelpers,
  ): Promise<void> => {
    const m = PROVIDER_TOKEN_RE.exec(token);
    if (m === null) return;
    const [, userId, grantId] = m as unknown as [string, string, string];
    const grant = (await env.OAUTH_KV.get(`grant:${userId}:${grantId}`, { type: 'json' })) as {
      readonly refreshTokenId?: unknown;
      readonly previousRefreshTokenId?: unknown;
      readonly clientId?: unknown;
    } | null;
    if (grant === null) return;
    const hash = await sha256Hex(token);
    if (!used && grant.refreshTokenId !== hash && grant.previousRefreshTokenId !== hash) return;
    await revokeFamily(userId, grantId, helpers);
    logger.warn('oauth refresh token reused; device revoked', { oauthGrant: grantId });
    const requestId = c.get('requestId') as unknown;
    await deps.audit?.({
      actor: {
        requestId: typeof requestId === 'string' ? requestId : null,
        userId,
        clientId: typeof grant.clientId === 'string' ? grant.clientId.slice(0, 200) : null,
        tokenId: `oauth_${grantId}`,
      },
      action: 'oauth.token.reuse',
      targetType: 'oauth_device',
      targetId: `oauth_${grantId}`,
      status: 'denied',
      errorCode: 'refresh_token_reuse',
      details: { revoked: true, concurrent: !used },
    });
  };

  /**
   * After the provider answered a refresh whose marker we took: on success the presented token becomes `used` and the
   * new one `live`; otherwise the presented token is `live` again only if the provider did not rotate it (a refused
   * request: wrong client, scope or resource), else `used`.
   */
  const settleRefresh = async (token: string, marker: string, response: Response | undefined) => {
    if (response?.ok) {
      await deps.kv.put(marker, REFRESH_USED, { expirationTtl: markerTtl });
      await markIssued(response);
      return;
    }
    const m = PROVIDER_TOKEN_RE.exec(token) as RegExpExecArray;
    const grant = (await env.OAUTH_KV.get(`grant:${m[1]}:${m[2]}`, { type: 'json' })) as {
      readonly refreshTokenId?: unknown;
    } | null;
    const unchanged = grant !== null && grant.refreshTokenId === (await sha256Hex(token));
    await deps.kv.put(marker, unchanged ? REFRESH_LIVE : REFRESH_USED, { expirationTtl: markerTtl });
  };

  // ------------------------------------------------------------------------------------------------ devices (P5-05)

  interface StoredGrant {
    readonly id?: unknown;
    readonly clientId?: unknown;
    readonly metadata?: unknown;
    readonly createdAt?: unknown;
    readonly expiresAt?: unknown;
    readonly resource?: unknown;
    readonly authCodeWrappedKey?: unknown;
  }
  /** A user's provider grants (pending code exchanges included), at most {@link MAX_OAUTH_DEVICES_PER_USER}. */
  const userGrants = async (userId: string): Promise<{ id: string; grant: StoredGrant }[]> => {
    const prefix = `grant:${userId}:`;
    const out: { id: string; grant: StoredGrant }[] = [];
    let cursor: string | undefined;
    do {
      const page = await env.OAUTH_KV.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
      for (const k of page.keys) {
        const id = k.name.slice(prefix.length);
        if (!/^[A-Za-z0-9_-]{16}$/.test(id)) continue;
        const grant = (await env.OAUTH_KV.get(k.name, { type: 'json' })) as StoredGrant | null;
        if (grant !== null) out.push({ id, grant });
        if (out.length >= MAX_OAUTH_DEVICES_PER_USER) return out;
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor !== undefined);
    return out;
  };
  const toDevice = async (userId: string, id: string, g: StoredGrant): Promise<OAuthDevice> => {
    const clientId = typeof g.clientId === 'string' ? g.clientId : '';
    const metadataDocument = looksLikeClientIdUrl(clientId);
    const record =
      clientId === ''
        ? null
        : ((await env.OAUTH_KV.get(`client:${clientId}`, { type: 'json' })) as {
            readonly clientName?: unknown;
          } | null);
    const meta = (typeof g.metadata === 'object' && g.metadata !== null ? g.metadata : {}) as Record<
      string,
      unknown
    >;
    const resource = Array.isArray(g.resource) ? g.resource[0] : g.resource;
    const accessGrant = meta['grant'];
    let clientHost: string | null = null;
    if (metadataDocument) {
      try {
        clientHost = new URL(clientId).hostname;
      } catch {
        clientHost = null;
      }
    }
    return {
      id: `oauth_${id}`,
      userId,
      clientId,
      clientName:
        record !== null && typeof record.clientName === 'string' ? safeClientName(record.clientName) : null,
      clientKind: metadataDocument ? 'metadata_document' : 'dynamic',
      clientHost,
      label: deviceLabel(meta['label']),
      projectSlug: typeof resource === 'string' ? slugOf(resource) : null,
      grantId: typeof accessGrant === 'string' && ACCESS_GRANT_ID_RE.test(accessGrant) ? accessGrant : null,
      createdAt: typeof g.createdAt === 'number' ? g.createdAt * 1000 : 0,
      expiresAt: typeof g.expiresAt === 'number' ? g.expiresAt * 1000 : null,
    };
  };
  /** Revoke one provider grant (every token of it) and forget the user's remembered approval for that client. */
  /** Whether a remembered approval is for this client on this project (the device's "don't ask again"). */
  const approvalOf =
    (clientId: string, projectSlug: string | null) =>
    (stored: { readonly clientId?: string; readonly projectSlug: string } | null): boolean =>
      stored !== null &&
      clientId !== '' &&
      stored.clientId === clientId &&
      (projectSlug === null || stored.projectSlug === projectSlug);
  const revokeDevice = async (device: OAuthDevice): Promise<void> => {
    const providerGrant = (DEVICE_ID_RE.exec(device.id) as RegExpExecArray)[1] as string;
    await revokeFamily(device.userId, providerGrant, (await server([])).getOAuthApi(env));
    await forgetApprovals(deps.kv, device.userId, approvalOf(device.clientId, device.projectSlug));
  };
  /** The parts of a stored grant revoke-all filters on (no client lookup: cheap per grant). */
  const grantFacts = (g: StoredGrant) => {
    const meta = (typeof g.metadata === 'object' && g.metadata !== null ? g.metadata : {}) as Record<
      string,
      unknown
    >;
    const resource = Array.isArray(g.resource) ? g.resource[0] : g.resource;
    return {
      clientId: typeof g.clientId === 'string' ? g.clientId : '',
      grantId: typeof meta['grant'] === 'string' ? meta['grant'] : null,
      projectSlug: typeof resource === 'string' ? slugOf(resource) : null,
    };
  };
  const devices: OAuthDevices = Object.freeze({
    async list(userId: string) {
      const nowS = clock.now() / 1000;
      const out: OAuthDevice[] = [];
      for (const { id, grant } of await userGrants(userId)) {
        // A pending code exchange is not a device yet (its code expires within minutes); nor is an expired grant.
        if (typeof grant.authCodeWrappedKey === 'string') continue;
        if (typeof grant.expiresAt === 'number' && grant.expiresAt <= nowS) continue;
        out.push(await toDevice(userId, id, grant));
      }
      return out.sort((a, b) => b.createdAt - a.createdAt);
    },
    async revoke(userId: string, deviceId: string) {
      const m = DEVICE_ID_RE.exec(deviceId);
      if (m === null) return null;
      const grant = (await env.OAUTH_KV.get(`grant:${userId}:${m[1]}`, {
        type: 'json',
      })) as StoredGrant | null;
      if (grant === null) return null;
      const device = await toDevice(userId, m[1] as string, grant);
      await revokeDevice(device);
      logger.info('oauth device revoked', { oauthGrant: m[1] });
      return device;
    },
    async revokeAll(
      userId: string,
      filter: { readonly grantId?: string; readonly projectSlug?: string } = {},
    ) {
      const helpers = (await server([])).getOAuthApi(env);
      const all = filter.grantId === undefined && filter.projectSlug === undefined;
      const gone: ((stored: StoredApproval | null) => boolean)[] = [];
      let revoked = 0;
      for (const { id, grant } of await userGrants(userId)) {
        const facts = grantFacts(grant);
        if (filter.grantId !== undefined && facts.grantId !== filter.grantId) continue;
        if (filter.projectSlug !== undefined && facts.projectSlug !== filter.projectSlug) continue;
        await revokeFamily(userId, id, helpers);
        gone.push(approvalOf(facts.clientId, facts.projectSlug));
        revoked += 1;
      }
      // One pass over the user's remembered approvals: those of the revoked devices, those naming the access grant
      // (never usable again) and, for a disabled user, all of them.
      await forgetApprovals(
        deps.kv,
        userId,
        (stored) =>
          all ||
          gone.some((m) => m(stored)) ||
          (filter.grantId !== undefined && stored?.grantId === filter.grantId),
      );
      if (revoked > 0) logger.info('oauth devices revoked', { revoked });
      return revoked;
    },
  });

  const runtime: OAuthRuntime = {
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
      // CIMD is ours (the provider's own stays off): advertise it only when a guarded fetcher was given.
      meta['client_id_metadata_document_supported'] = cimd !== undefined;
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      return new Response(JSON.stringify(meta), { status: response.status, headers });
    },

    async register(c) {
      if (!registration) return jsonError(404, 'not_found', 'Client registration is disabled.');
      const body = await readBounded(c.req.raw, OAUTH_MAX_BODY_BYTES);
      if (body === null) return jsonError(413, 'invalid_request', 'Request body too large.');
      const mediaType = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        return jsonError(400, 'invalid_client_metadata', 'Send the client metadata as application/json.');
      }
      // Our policy first (redirect URIs, display name, host allow-list): nothing is stored for a refused request.
      const verdict = checkRegistration(body, redirectHosts);
      if (!verdict.ok) {
        logger.info('oauth registration refused', { reason: verdict.reason });
        return jsonError(400, verdict.error, 'The client metadata is not acceptable.');
      }
      // One cap for the whole deployment (T10): an atomic counter in storage, so isolates and processes share it.
      if (registrationLimit !== null) {
        const nowS = Math.floor(clock.now() / 1000);
        const window = Math.floor(nowS / registrationLimit.perSeconds);
        const count = await deps.kv.increment(`${REGISTRATION_COUNTER_PREFIX}${window}`, {
          expirationTtl: registrationLimit.perSeconds,
        });
        if (count > registrationLimit.requests) {
          logger.warn('oauth registration cap reached', { limit: registrationLimit.requests });
          const response = jsonError(
            429,
            'temporarily_unavailable',
            'Too many client registrations; retry later.',
          );
          response.headers.set('Retry-After', String((window + 1) * registrationLimit.perSeconds - nowS));
          return response;
        }
      }
      const response = await fetchProvider(await server([]), c, body);
      if (response.status !== 201) return response;
      // Unused registrations die young: until its first token exchange (which renews it, the provider's half-life rule)
      // a registration lives a day, so a flood of registrations nobody uses doesn't stay in storage for months.
      const created = (await response.clone().json()) as { readonly client_id?: unknown };
      if (typeof created.client_id === 'string') {
        const key = `client:${created.client_id}`;
        const record = (await env.OAUTH_KV.get(key, { type: 'json' })) as Record<string, unknown> | null;
        if (record !== null) {
          const nowS = Math.floor(clock.now() / 1000);
          await env.OAUTH_KV.put(
            key,
            JSON.stringify({ ...record, registrationExpiresAt: nowS + OAUTH_UNUSED_REGISTRATION_TTL_S }),
            { expirationTtl: OAUTH_UNUSED_REGISTRATION_TTL_S },
          );
        }
      }
      return response;
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
      // CIMD: a URL client id needs its (cached or fetched) document before the provider looks it up. Before the code
      // is consumed, so a fetch failure doesn't burn it.
      const clientId = form?.get('client_id') ?? null;
      const clientProblem = await resolveClient(clientId);
      if (clientProblem !== null) return refusedClient(clientId as string, clientProblem);
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
      if (grantType === 'refresh_token') {
        // Single use under concurrency (P5-05): of concurrent refreshes with one token at most one finds it `live`;
        // anything else is reuse and revokes the device's token family.
        const presented = form?.get('refresh_token') ?? '';
        if (!looksLikeOAuthToken(presented)) return jsonError(400, 'invalid_grant', 'Invalid refresh token');
        const marker = await refreshMarker(presented);
        const state = await deps.kv.take(marker);
        if (state !== REFRESH_LIVE) {
          if (state !== null) await deps.kv.put(marker, REFRESH_USED, { expirationTtl: markerTtl });
          await refreshReused(c, presented, state !== null, as.getOAuthApi(env));
          return jsonError(400, 'invalid_grant', 'Invalid refresh token');
        }
        let refreshed: Response | undefined;
        try {
          refreshed = await fetchProvider(as, c, body);
        } finally {
          await settleRefresh(presented, marker, refreshed);
        }
        if (refreshed.ok && (await revokedMeanwhile(presented, as.getOAuthApi(env)))) {
          return jsonError(400, 'invalid_grant', 'Invalid refresh token');
        }
        return refreshed;
      }
      // RFC 7009 revocation shares this endpoint (no grant_type).
      const revocation = form !== null && grantType === null && form.has('token');
      const revoked = revocation ? PROVIDER_TOKEN_RE.exec(form?.get('token') ?? '') : null;
      const grantKey = revoked === null ? null : `grant:${revoked[1]}:${revoked[2]}`;
      const existed = grantKey !== null && (await env.OAUTH_KV.get(grantKey)) !== null;
      const response = await fetchProvider(as, c, body);
      if (grantType === 'authorization_code' && response.ok) {
        if (await revokedMeanwhile(form?.get('code') ?? '', as.getOAuthApi(env))) {
          return jsonError(400, 'invalid_grant', 'Invalid authorization code');
        }
        await markIssued(response);
      }
      // RFC 7009 revocation shares this endpoint (no grant_type): drop cached decisions here at once, and when the
      // device is gone (a refresh token was revoked) leave a tombstone so a refresh in flight can't bring it back.
      if (revocation && response.ok) {
        onRevocation();
        if (existed && grantKey !== null && revoked !== null && (await env.OAUTH_KV.get(grantKey)) === null) {
          await deps.kv.put(tombstone(revoked[1] as string, revoked[2] as string), '1', {
            expirationTtl: Math.max(refreshTtl, accessTtl, 60),
          });
        }
      }
      return response;
    },

    async authorize(c) {
      const prepared = await runtime.prepare(c, new URL(c.req.url).searchParams);
      return prepared instanceof Response ? prepared : consent(c, prepared);
    },

    async prepare(_c, params) {
      // RFC 6749 §3.1: no parameter twice (what the consent step is shown must be what the provider acts on).
      if (repeated(params)) {
        return jsonError(400, 'invalid_request', 'Parameters must not be repeated.');
      }
      // RFC 8707: exactly one resource, one of ours. Refused before the client is known, so never redirected.
      const slug = targetSlug(params);
      if (slug === null) {
        return jsonError(400, 'invalid_target', 'resource must name one MCP endpoint of this server.');
      }
      const resource = resourceUrl(slug);
      // CIMD: fetch (or find cached) the client's document before the provider looks the client up. A failure is a
      // 400 page, never a redirect: no redirect URI has been validated yet.
      const requestedClient = params.get('client_id');
      const clientProblem = await resolveClient(requestedClient);
      if (clientProblem !== null) return refusedClient(requestedClient as string, clientProblem);
      const mod = await provider();
      const as = await server([resource]);
      const helpers = as.getOAuthApi(env);
      let authRequest: AuthRequest;
      try {
        // The provider reads the request URL only: hand it the authorization endpoint with exactly these parameters.
        authRequest = await helpers.parseAuthRequest(
          new Request(`${issuer}${OAUTH_AUTHORIZE_PATH}?${params.toString()}`),
        );
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
      const metadataDocument = looksLikeClientIdUrl(authRequest.clientId);
      const request: OAuthAuthorizationRequest = Object.freeze({
        clientId: authRequest.clientId,
        clientKind: metadataDocument ? 'metadata_document' : 'dynamic',
        clientHost: metadataDocument ? new URL(authRequest.clientId).hostname : null,
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
        approve: async ({
          userId,
          grantId,
          label,
        }: {
          readonly userId: string;
          readonly grantId: string;
          readonly label?: string | null;
        }) => {
          if (used) throw new Error('an authorization request is approved at most once');
          used = true;
          // The consent step may take a while (sign-in): a CIMD client's cached document may have expired since.
          const clientProblem = await resolveClient(authRequest.clientId);
          if (clientProblem !== null) return { ok: false, reason: 'client_refused' } as const;
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
          const storedLabel = deviceLabel(label);
          const { redirectTo } = await helpers.completeAuthorization({
            request: authRequest,
            userId,
            // T25: grant metadata is stored unencrypted: only the device label the user typed (checked text) and the
            // access grant id (P5-05: revoking that grant revokes this device too), never an email or other personal data.
            metadata: storedLabel === null ? { grant: grantId } : { label: storedLabel, grant: grantId },
            scope,
            props,
          });
          const code = new URL(redirectTo).searchParams.get('code');
          if (code === null) throw new Error('the provider returned no authorization code');
          await deps.kv.put(await codeMarker(code), '1', { expirationTtl: OAUTH_CODE_TTL_S });
          return { ok: true, redirectTo } as const;
        },
      });
      return api;
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

    devices,
  };
  return runtime;
}
