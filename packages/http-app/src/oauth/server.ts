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
// - Refresh reuse interval (P5-09, ADR-0013): within `refreshReuseWindowSeconds` (default 30 s, 0 = strict) the token
//   that was just rotated, re-presented by the same client, gets the already issued successor pair again (sealed in
//   `kv` under a key derived from that token, `refresh-replay.ts`) instead of revoking the device; a request that
//   arrives while the rotation runs waits for it (bounded). Anything else is still reuse.
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
import { type Clock, type Logger, WRITE_TOOL_NAMES } from '@relic-bridge/core';
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
  MAX_CLIENT_ID_URL_CHARS,
  MAX_REDIRECT_URIS,
  readBoundedBytes,
  safeClientName,
} from './clients.ts';
import { type OAuthKvNamespace, oauthKvNamespace } from './kv-namespace.ts';
import {
  clientAuthenticates,
  openReplay,
  presentedClient,
  type ReplayPayload,
  type StoredClientAuth,
  sealReplay,
} from './refresh-replay.ts';
import { forgetApprovals, forgetClientApprovals, type StoredApproval } from './remembered.ts';

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
/**
 * The scope a token needs before any write tool is listed (P7-09, ADR-0015). Advertised only when the deployment turns
 * write tools on; granted only when the client asks for it and the user ticks the separate box on the consent screen.
 */
export const MCP_WRITE_SCOPE = 'mcp:write';
export const OAUTH_SCOPES: readonly string[] = Object.freeze([MCP_SCOPE, 'offline_access']);
/** {@link OAUTH_SCOPES} of a deployment with write tools on. */
export const OAUTH_WRITE_SCOPES: readonly string[] = Object.freeze([
  MCP_SCOPE,
  MCP_WRITE_SCOPE,
  'offline_access',
]);

export const DEFAULT_OAUTH_ACCESS_TTL_S = 3600;
export const DEFAULT_OAUTH_REFRESH_TTL_S: number = 30 * 86_400;
/**
 * Refresh token reuse interval (P5-09, ADR-0013): seconds during which the token that was just rotated, re-presented by
 * the same client, gets the same successor pair instead of revoking the device. 0 = strict single use (P5-05).
 */
export const DEFAULT_OAUTH_REFRESH_REUSE_WINDOW_S = 30;
export const MAX_OAUTH_REFRESH_REUSE_WINDOW_S = 120;
/**
 * Pauses (ms) of a refresh that found its token being rotated by a concurrent request, while it waits for that
 * rotation's result (about 3 s in all; real time, a few `kv` reads).
 */
const REPLAY_WAIT_STEPS_MS: readonly number[] = Object.freeze([
  20, 40, 80, 160, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250,
]);
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
  | { readonly ok: true; readonly redirectTo: string; readonly scope: readonly string[] }
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
    /**
     * The user ticked "allow changes" (P7-09). `mcp:write` is granted only with this, when the request asked for it and
     * the grant has write tools; anything else gets a read-only token. Never set for a remembered approval.
     */
    readonly write?: boolean;
  }): Promise<OAuthApproval>;
  /** The `access_denied` redirect (with `state` and `iss`). */
  deny(description?: string): string;
  /** The redirect for a `prompt=none` request that can't be answered silently (OIDC Core §3.1.2.6; P5-12). */
  refuseSilently(code: 'consent_required' | 'login_required' | 'invalid_request'): string;
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
  /**
   * Refresh token reuse interval in seconds, 0 (strict single use, P5-05) or 1-120. Default 30 (P5-09, ADR-0013): a
   * client that refreshes twice at once with one token gets the same new pair twice instead of losing the device.
   */
  readonly refreshReuseWindowSeconds?: number;
  /**
   * Most devices (live OAuth authorizations) one user holds, 1-{@link MAX_OAUTH_DEVICES_PER_USER} (P5-11). Default
   * {@link DEFAULT_OAUTH_DEVICES_PER_USER}. When a code redemption would pass it, the user's oldest devices are
   * replaced (revoked, audited `oauth.device.replace`), so the listing and "disconnect all" always see every device.
   */
  readonly maxDevicesPerUser?: number;
  /**
   * Work one client removal does per call (P5-11): grant rows scanned and grants revoked. Past either the removal
   * stops, reports `complete: false` and a retry resumes where it stopped. Defaults
   * {@link MAX_OAUTH_GRANTS_SCANNED} and {@link MAX_OAUTH_REVOKES_PER_REMOVAL}.
   */
  readonly clientRemovalBudget?: { readonly scan?: number; readonly revoke?: number };
  /** RFC 7591 dynamic client registration at `/oauth/register`. Default on. */
  readonly registration?: boolean;
  /**
   * Dynamic registrations allowed per window, shared by every isolate and process (a `kv` counter). Default 30 per
   * hour; `null` turns the cap off (the per-IP `oauth` rate limit still applies).
   */
  readonly registrationLimit?: { readonly requests: number; readonly perSeconds: number } | null;
  /**
   * Registrations one client address may complete per window (P5-10: one source must not use up the deployment-wide
   * cap). Default {@link DEFAULT_OAUTH_REGISTRATION_IP_LIMIT}; `null` turns it off. Needs `clientIp` to tell addresses apart.
   */
  readonly registrationIpLimit?: { readonly requests: number; readonly perSeconds: number } | null;
  /**
   * The caller's address bucket key (`resolveClientIp`); `null` when unknown (then one shared bucket is used). The
   * hosts pass the same function the rate limiter uses. Without it every caller shares one per-address bucket.
   */
  readonly clientIp?: (c: Context) => string | null;
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
/** RFC 7636 §4.1 `code-verifier = 43*128unreserved`. */
const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
/**
 * Revoked device tombstones, `oauth-revoked:<userId>:<grantId>`: written before a device is revoked, so a token
 * request the provider was answering at that moment (it reads the grant, then writes it back) can't bring the device
 * back: the token endpoint looks for the tombstone after the provider answered and revokes again.
 */
const TOMBSTONE_PREFIX = 'oauth-revoked:';
const REFRESH_USED = 'used';
/** Sealed successor of a just-rotated refresh token, `oauth-refresh-replay:<sha256(token)>` (P5-09, `refresh-replay.ts`). */
const REPLAY_PREFIX = 'oauth-refresh-replay:';
/** An OAuth device's public id: `oauth_` + the provider grant id (also the audit `tokenId`). */
const DEVICE_ID_RE = /^oauth_([A-Za-z0-9_-]{16})$/;
/** Access grant ids as stored in grant metadata (the admin API's id shape). */
const ACCESS_GRANT_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
/**
 * Grant rows read per user for the listing: the devices (capped at {@link DEFAULT_OAUTH_DEVICES_PER_USER}, P5-11) plus
 * headroom for pending code exchanges, which expire within minutes.
 */
export const MAX_OAUTH_DEVICES_PER_USER = 100;
/** Default cap on live devices per user, enforced when a code is redeemed (P5-11). */
export const DEFAULT_OAUTH_DEVICES_PER_USER = 50;
/** Grant rows "disconnect all" reads per pass; it repeats passes while it finds more. */
export const MAX_OAUTH_REVOKE_ALL_SCAN = 1000;
/** Grants one client-removal call revokes before it stops and asks for a retry (keeps a D1 invocation bounded). */
export const MAX_OAUTH_REVOKES_PER_REMOVAL = 100;
/** `oauth-client-removal:<sha256(client id)>`: the cursor a client removal stopped at, so a retry resumes (P5-11). */
const CLIENT_REMOVAL_PREFIX = 'oauth-client-removal:';
const CLIENT_REMOVAL_TTL_S = 7 * 86_400;
/** The runtime switch for dynamic client registration (settings table, owner-only through the admin API, P5-08). */
export const OAUTH_REGISTRATION_SETTING = 'oauth.registration';
/**
 * How long one isolate or process keeps the switch it read: a change made elsewhere takes effect within this long
 * (immediately on the process that made it). Documented in docs/dev/oauth.md.
 */
export const OAUTH_REGISTRATION_CACHE_MS = 5000;
/** Most clients the admin list reads, and most grants one client removal scans. */
export const MAX_OAUTH_CLIENTS_LISTED = 500;
export const MAX_OAUTH_GRANTS_SCANNED = 20_000;
/** Most client records the admin list reads before it sorts (newest first) and cuts to {@link MAX_OAUTH_CLIENTS_LISTED}. */
export const MAX_OAUTH_CLIENTS_SCANNED = 5000;
/** Dynamic registrations one client address may complete per window (P5-10, T10); the loopback/claude.ai cases need a few. */
export const DEFAULT_OAUTH_REGISTRATION_IP_LIMIT: { readonly requests: number; readonly perSeconds: number } =
  Object.freeze({ requests: 10, perSeconds: 3600 });
/** Metadata documents one client address may make the server fetch per window (cache misses only, P5-10, T11). */
export const OAUTH_CIMD_FETCHES_PER_IP: { readonly requests: number; readonly perSeconds: number } =
  Object.freeze({ requests: 20, perSeconds: 3600 });
/** Most metadata-document client records stored at once (each lives 5 min to 24 h); more are refused until some expire. */
export const MAX_OAUTH_CIMD_CLIENTS = 200;
/** Shared registration counter windows (`kv`, outside the provider's `oauth:` namespace). */
const REGISTRATION_COUNTER_PREFIX = 'oauth-dcr-count:';
const REGISTRATION_IP_COUNTER_PREFIX = 'oauth-dcr-ip:';
const CIMD_FETCH_COUNTER_PREFIX = 'oauth-cimd-ip:';

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
  readonly storage: Pick<Storage, 'projects' | 'grants' | 'users' | 'credentials' | 'settings'>;
  readonly catalog: readonly string[];
  readonly clock: Clock;
  readonly logger: Logger;
  readonly runInBackground: (c: Context, task: Promise<unknown>, what: string) => void;
  /** Used when `options.consent` is not given (the built-in screen). */
  readonly defaultConsent?: OAuthConsentHandler;
  /** `admin` audit rows (refresh reuse, refused issuance); never rejects. */
  readonly audit?: (event: AdminAuditEvent) => Promise<void>;
  /** Write tools are on (`RB_WRITE_TOOLS=on`, P7-09): `mcp:write` is advertised and may be granted. Default false. */
  readonly writeScope?: boolean;
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

/** One OAuth client (a stored client record) as the admin API shows it (P5-08). No secrets, no document body. */
export interface OAuthClient {
  /** The client id: a metadata document URL or a registered id. */
  readonly id: string;
  readonly kind: 'metadata_document' | 'dynamic';
  /** Untrusted text from the registration or document (checked when stored): escape before display. */
  readonly name: string | null;
  /** Metadata-document clients: the host of the client id, which vouches for it. Null for dynamic clients. */
  readonly host: string | null;
  /** The hosts of the redirect URIs. */
  readonly redirectHosts: readonly string[];
  /** Epoch ms; null when the record has no date. */
  readonly registeredAt: number | null;
  /** Epoch ms of the record's expiry (a document is fetched again after it); null when it has none. */
  readonly expiresAt: number | null;
}

/** What removing a client ended. */
export interface OAuthClientRemoval {
  readonly client: OAuthClient;
  /** Device authorizations (provider grants, every user) revoked with all their tokens. */
  readonly devicesRevoked: number;
  /** Remembered "don't ask again" approvals forgotten. */
  readonly approvalsForgotten: number;
  /**
   * False when this call stopped at its work budget (P5-11): the record is gone (so the client gets no new token or
   * authorization) and the same removal again continues where it stopped. Repeat until it completes.
   */
  readonly complete: boolean;
}

/** The state of dynamic client registration. */
export interface OAuthRegistrationState {
  /** What `/oauth/register` does now: deployment on and the switch not off. */
  readonly enabled: boolean;
  /** `RB_OAUTH_DCR` (default on): when off, the switch cannot turn registration on. */
  readonly deployment: boolean;
  /** The runtime switch (settings); on when never set. */
  readonly setting: boolean;
}

/** OAuth clients: list, remove, and the registration switch (admin API, owners only, P5-08). */
export interface OAuthClients {
  /** Newest first, at most {@link MAX_OAUTH_CLIENTS_LISTED}; `truncated` when there are more (or the scan was cut). */
  list(): Promise<{ readonly clients: readonly OAuthClient[]; readonly truncated: boolean }>;
  /**
   * Remove a client record and revoke every grant (all users, every token family) and remembered approval of it. Works
   * for an id that has no record any more but still has grants (an expired cached document). Null when there is
   * neither a record nor a grant.
   */
  remove(clientId: string): Promise<OAuthClientRemoval | null>;
  registration(): Promise<OAuthRegistrationState>;
  /** Turn dynamic registration on or off at runtime; other processes follow within {@link OAUTH_REGISTRATION_CACHE_MS}. */
  setRegistration(enabled: boolean): Promise<void>;
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
  /** OAuth clients and the registration switch (P5-08). */
  readonly clients: OAuthClients;
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
  const reuseWindow = checkInt(
    'oauth.refreshReuseWindowSeconds',
    options.refreshReuseWindowSeconds ?? DEFAULT_OAUTH_REFRESH_REUSE_WINDOW_S,
    1,
    MAX_OAUTH_REFRESH_REUSE_WINDOW_S,
    true,
  );
  const maxDevices = checkInt(
    'oauth.maxDevicesPerUser',
    options.maxDevicesPerUser ?? DEFAULT_OAUTH_DEVICES_PER_USER,
    1,
    MAX_OAUTH_DEVICES_PER_USER,
  );
  const removalScanBudget = checkInt(
    'oauth.clientRemovalBudget.scan',
    options.clientRemovalBudget?.scan ?? MAX_OAUTH_GRANTS_SCANNED,
    1,
    1_000_000,
  );
  const removalRevokeBudget = checkInt(
    'oauth.clientRemovalBudget.revoke',
    options.clientRemovalBudget?.revoke ?? MAX_OAUTH_REVOKES_PER_REMOVAL,
    1,
    100_000,
  );
  const deploymentRegistration = options.registration ?? true;
  const registrationLimit =
    options.registrationLimit === undefined ? DEFAULT_OAUTH_REGISTRATION_LIMIT : options.registrationLimit;
  if (registrationLimit !== null) {
    checkInt('oauth.registrationLimit.requests', registrationLimit.requests, 1, 100_000);
    checkInt('oauth.registrationLimit.perSeconds', registrationLimit.perSeconds, 60, 86_400);
  }
  const registrationIpLimit =
    options.registrationIpLimit === undefined
      ? DEFAULT_OAUTH_REGISTRATION_IP_LIMIT
      : options.registrationIpLimit;
  if (registrationIpLimit !== null) {
    checkInt('oauth.registrationIpLimit.requests', registrationIpLimit.requests, 1, 100_000);
    checkInt('oauth.registrationIpLimit.perSeconds', registrationIpLimit.perSeconds, 60, 86_400);
  }
  const callerKey = (c: Context): string => options.clientIp?.(c) ?? 'unknown';
  const redirectHosts = options.registrationRedirectHosts?.map((h) => {
    const host = h.trim().toLowerCase();
    if (!/^[a-z0-9.-]{1,253}$/.test(host) || !host.includes('.')) {
      throw new TypeError('oauth.registrationRedirectHosts must be host names');
    }
    return host;
  });
  const writeScope = deps.writeScope === true;
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

  /**
   * Whether `/oauth/register` works now: the deployment allows it and the runtime switch (settings) is not off. Read at
   * most once per {@link OAUTH_REGISTRATION_CACHE_MS} per process. An unreadable setting counts as off (fail closed).
   */
  let registrationCache: { readonly setting: boolean; readonly at: number } | undefined;
  const registrationSetting = async (): Promise<boolean> => {
    const now = clock.now();
    if (registrationCache !== undefined && now - registrationCache.at < OAUTH_REGISTRATION_CACHE_MS) {
      return registrationCache.setting;
    }
    let setting: boolean;
    try {
      setting = (await deps.storage.settings.get(OAUTH_REGISTRATION_SETTING)) !== false;
    } catch {
      logger.warn('oauth registration switch unreadable; registration refused');
      setting = false;
    }
    registrationCache = { setting, at: now };
    return setting;
  };
  const registrationOn = async (): Promise<boolean> =>
    deploymentRegistration && (await registrationSetting());

  let loaded: Promise<ProviderModule> | undefined;
  const provider = (): Promise<ProviderModule> => {
    loaded ??= import('@cloudflare/workers-oauth-provider');
    return loaded;
  };

  const servers = new Map<string, OAuthAuthorizationServer<ProviderEnv>>();
  const server = async (resources: readonly string[]): Promise<OAuthAuthorizationServer<ProviderEnv>> => {
    const list = resources.length === 0 ? [placeholderResource] : [...new Set(resources)].sort();
    const registration = await registrationOn();
    // The registration endpoint is part of the provider's configuration (and of the metadata): one server per state.
    const key = `${registration ? 'dcr' : 'nodcr'}\n${list.join('\n')}`;
    const cached = servers.get(key);
    if (cached) return cached;
    const mod = await provider();
    const built = new mod.OAuthAuthorizationServer<ProviderEnv>({
      issuer,
      resources: list,
      scopesSupported: [...(writeScope ? OAUTH_WRITE_SCOPES : OAUTH_SCOPES)],
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
  const resolveClient = async (
    clientId: string | null | undefined,
    caller: string,
  ): Promise<string | null> => {
    if (clientId === null || clientId === undefined || !looksLikeClientIdUrl(clientId)) return null;
    if (cimd === undefined) return 'cimd_disabled';
    const problem = clientIdUrlProblem(clientId, issuerHost);
    if (problem !== null) return problem;
    if ((await env.OAUTH_KV.get(`client:${clientId}`)) !== null) return null;
    // Anonymous callers can make us fetch (T11, T20): bound the stored document clients, then the fetches one address
    // may cause (counted before the fetch; a failure is not cached, so failures count too).
    const stored = await env.OAUTH_KV.list({ prefix: 'client:https://', limit: MAX_OAUTH_CIMD_CLIENTS });
    if (stored.keys.length >= MAX_OAUTH_CIMD_CLIENTS) {
      logger.warn('oauth metadata document client cap reached', { limit: MAX_OAUTH_CIMD_CLIENTS });
      return 'too_many_clients';
    }
    const budget = OAUTH_CIMD_FETCHES_PER_IP;
    const window = Math.floor(clock.now() / 1000 / budget.perSeconds);
    const fetches = await deps.kv.increment(`${CIMD_FETCH_COUNTER_PREFIX}${caller}:${window}`, {
      expirationTtl: budget.perSeconds,
    });
    if (fetches > budget.requests) return 'fetch_budget';
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
  /**
   * After a code was redeemed: the same app connecting again (same user, client and resource, and for a metadata
   * document client the same redirect URI, as the provider's own rule) replaces its earlier devices, tombstoned like
   * any revocation. Done at redemption, not issuance (review H1), so only the client that holds the code and its PKCE
   * verifier can end an earlier connection.
   */
  const replaceEarlierDevices = async (c: Context, code: string, helpers: OAuthHelpers): Promise<void> => {
    const m = PROVIDER_TOKEN_RE.exec(code);
    if (m === null) return;
    const [, userId, grantId] = m as unknown as [string, string, string];
    const current = (await env.OAUTH_KV.get(`grant:${userId}:${grantId}`, { type: 'json' })) as {
      readonly clientId?: unknown;
      readonly resource?: unknown;
      readonly redirectUri?: unknown;
      readonly createdAt?: unknown;
    } | null;
    if (current === null || typeof current.clientId !== 'string' || typeof current.resource !== 'string')
      return;
    const metadataDocument = looksLikeClientIdUrl(current.clientId);
    const requestId = c.get('requestId') as unknown;
    for (const { id, grant } of await userGrants(userId)) {
      const g = grant as StoredGrant & { readonly redirectUri?: unknown };
      if (id === grantId || g.clientId !== current.clientId || g.resource !== current.resource) continue;
      if (metadataDocument && g.redirectUri !== current.redirectUri) continue;
      // Only earlier authorizations: a newer one (another tab) is replaced when its own code is redeemed.
      if (typeof g.createdAt !== 'number' || typeof current.createdAt !== 'number') continue;
      if (g.createdAt > current.createdAt) continue;
      await revokeFamily(userId, id, helpers);
      logger.info('oauth device replaced by a new authorization of the same app', { oauthGrant: id });
      await auditReplace(requestId, userId, current.clientId, grantId, id, 'same_app');
    }
    await enforceDeviceCap(requestId, userId, current.clientId, grantId, helpers);
  };

  const auditReplace = async (
    requestId: unknown,
    userId: string,
    clientId: string,
    newGrantId: string,
    oldGrantId: string,
    reason: 'same_app' | 'device_limit',
  ): Promise<void> => {
    await deps.audit?.({
      actor: {
        requestId: typeof requestId === 'string' ? requestId : null,
        userId,
        clientId: clientId.slice(0, 200),
        tokenId: `oauth_${newGrantId}`,
      },
      action: 'oauth.device.replace',
      targetType: 'oauth_device',
      targetId: `oauth_${oldGrantId}`,
      status: 'ok',
      details: { replacedBy: `oauth_${newGrantId}`, reason },
    });
  };

  /**
   * P5-11: a user holds at most `maxDevices` live devices, so the listing and "disconnect all" see every one. When a
   * redemption passes the cap, the oldest other devices are replaced (revoked with a tombstone, audited), never the
   * one just issued. Pending code exchanges and expired grants are not devices.
   */
  const enforceDeviceCap = async (
    requestId: unknown,
    userId: string,
    clientId: string,
    currentId: string,
    helpers: OAuthHelpers,
  ): Promise<void> => {
    const nowS = clock.now() / 1000;
    const live = (await userGrants(userId)).filter(
      ({ id, grant }) =>
        id !== currentId &&
        typeof grant.authCodeWrappedKey !== 'string' &&
        !(typeof grant.expiresAt === 'number' && grant.expiresAt <= nowS),
    );
    const excess = live.length + 1 - maxDevices;
    if (excess <= 0) return;
    live.sort((a, b) => Number(a.grant.createdAt ?? 0) - Number(b.grant.createdAt ?? 0));
    for (const { id } of live.slice(0, excess)) {
      await revokeFamily(userId, id, helpers);
      logger.info('oauth device replaced: per-user device limit', { oauthGrant: id });
      await auditReplace(requestId, userId, clientId, currentId, id, 'device_limit');
    }
  };

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
    /** P5-09: why a reuse-interval replay was refused (audit detail), when one was attempted. */
    replayRefused: string | null = null,
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
      details: {
        revoked: true,
        concurrent: !used,
        ...(replayRefused === null ? {} : { replayRefused }),
      },
    });
  };

  /**
   * After the provider answered a refresh whose marker we took: on success the presented token becomes `used` and the
   * new one `live` (with a reuse interval, the sealed successor is written first, so a request that sees `used` and no
   * replay knows there is none); otherwise the presented token is `live` again only if the provider did not rotate it
   * (a refused request: wrong client, scope or resource), else `used`.
   */
  const settleRefresh = async (
    token: string,
    marker: string,
    response: Response | undefined,
    c: Context,
    form: URLSearchParams,
  ) => {
    if (response?.ok) {
      if (reuseWindow > 0) await keepForReplay(token, response, c, form);
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

  // ------------------------------------------------------------------------------ refresh reuse interval (P5-09)

  const replayAad = (userId: string, grantId: string, hash: string): string =>
    `relic-bridge:oauth-refresh-replay:v1:${userId}:${grantId}:${hash}`;

  /** Seal the successor pair of a successful rotation for the reuse interval (best effort: a failure is only logged). */
  const keepForReplay = async (token: string, response: Response, c: Context, form: URLSearchParams) => {
    try {
      const body = (await response.clone().json()) as Record<string, unknown>;
      const client = presentedClient(c.req.raw.headers, form);
      const successor = body['refresh_token'];
      const resource = form.get('resource');
      if (client === null || typeof successor !== 'string' || resource === null) return;
      const m = PROVIDER_TOKEN_RE.exec(token) as RegExpExecArray;
      const hash = await sha256Hex(token);
      const payload: ReplayPayload = {
        v: 1,
        issuedAt: Math.floor(clock.now() / 1000),
        clientId: client.clientId,
        resource,
        scope: form.get('scope'),
        successor: await sha256Hex(successor),
        response: body,
      };
      await deps.kv.put(
        `${REPLAY_PREFIX}${hash}`,
        await sealReplay(token, replayAad(m[1] as string, m[2] as string, hash), payload),
        { expirationTtl: reuseWindow },
      );
    } catch (error) {
      // Without it a concurrent duplicate is treated as reuse (the strict behaviour): never worse than P5-05.
      logger.warn('oauth refresh replay not stored', {
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  };

  type ReplayOutcome =
    | { readonly kind: 'replay'; readonly response: Response }
    /** The rotation that held the marker gave the token back (`live` again): this request rotates it now. */
    | { readonly kind: 'owner' }
    /** Reuse after all (`used`: the token was rotated; else it is still being rotated or was never the grant's). */
    | { readonly kind: 'reuse'; readonly used: boolean; readonly why: string | null };

  /**
   * The replay of the successor sealed for `token`, if this request may have it: the same client (and client
   * authentication), resource and scope as the rotation, inside the window, the successor still the grant's current
   * refresh token (an older generation is reuse) and the device not revoked. Otherwise the reason it is reuse.
   */
  const serveReplay = async (
    c: Context,
    form: URLSearchParams,
    token: string,
    userId: string,
    grantId: string,
    hash: string,
    sealed: string,
  ): Promise<ReplayOutcome> => {
    const reuse = (why: string): ReplayOutcome => ({ kind: 'reuse', used: true, why });
    const payload = await openReplay(token, replayAad(userId, grantId, hash), sealed);
    if (payload === null) return reuse('unreadable');
    const nowS = Math.floor(clock.now() / 1000);
    const elapsed = nowS - payload.issuedAt;
    if (elapsed < 0 || elapsed > reuseWindow) return reuse('outside_window');
    const client = presentedClient(c.req.raw.headers, form);
    if (client === null || client.clientId !== payload.clientId) return reuse('other_client');
    const record = (await env.OAUTH_KV.get(`client:${client.clientId}`, {
      type: 'json',
    })) as StoredClientAuth | null;
    if (!(await clientAuthenticates(client, record, sha256Hex))) return reuse('client_authentication');
    const resource = form.get('resource');
    if (resource === null || targetSlug(form) !== slugOf(payload.resource)) return reuse('other_resource');
    if (form.get('scope') !== payload.scope) return reuse('other_scope');
    const grant = (await env.OAUTH_KV.get(`grant:${userId}:${grantId}`, { type: 'json' })) as {
      readonly refreshTokenId?: unknown;
    } | null;
    if (grant === null || (await deps.kv.get(tombstone(userId, grantId))) !== null) return reuse('revoked');
    if (grant.refreshTokenId !== payload.successor) return reuse('older_generation');
    const expiresIn = payload.response['expires_in'];
    const body = {
      ...payload.response,
      ...(typeof expiresIn === 'number' ? { expires_in: Math.max(1, expiresIn - elapsed) } : {}),
    };
    logger.info('oauth refresh replayed within the reuse interval', { oauthGrant: grantId, elapsed });
    const requestId = c.get('requestId') as unknown;
    await deps.audit?.({
      actor: {
        requestId: typeof requestId === 'string' ? requestId : null,
        userId,
        clientId: payload.clientId.slice(0, 200),
        tokenId: `oauth_${grantId}`,
      },
      action: 'oauth.token.replay',
      targetType: 'oauth_device',
      targetId: `oauth_${grantId}`,
      status: 'ok',
      details: { elapsedSeconds: elapsed, windowSeconds: reuseWindow },
    });
    return {
      kind: 'replay',
      response: new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache' },
      }),
    };
  };

  /**
   * A refresh whose marker was not `live` (`first`: what `kv.take` returned, `used` or null), with a reuse interval:
   * replay the sealed successor if there is one for this request; if the token is being rotated right now (no marker,
   * still the grant's current or previous token), wait for that rotation, bounded; if the rotation gave the token back,
   * take it over. The marker taken here is put back as it was.
   */
  const awaitReplay = async (
    c: Context,
    form: URLSearchParams,
    token: string,
    marker: string,
    first: string | null,
  ): Promise<ReplayOutcome> => {
    const [, userId, grantId] = PROVIDER_TOKEN_RE.exec(token) as unknown as [string, string, string];
    const hash = await sha256Hex(token);
    const key = `${REPLAY_PREFIX}${hash}`;
    let used = first !== null;
    if (used) await deps.kv.put(marker, REFRESH_USED, { expirationTtl: markerTtl });
    for (let step = 0; ; step++) {
      const sealed = await deps.kv.get(key);
      if (sealed !== null) return serveReplay(c, form, token, userId, grantId, hash, sealed);
      if (used) return { kind: 'reuse', used: true, why: 'no_replay' };
      if (step === 0) {
        // Only a token the grant still names can be in rotation: anything else (forged, long gone) waits for nothing.
        const grant = (await env.OAUTH_KV.get(`grant:${userId}:${grantId}`, { type: 'json' })) as {
          readonly refreshTokenId?: unknown;
          readonly previousRefreshTokenId?: unknown;
        } | null;
        if (grant === null || (grant.refreshTokenId !== hash && grant.previousRefreshTokenId !== hash)) {
          return { kind: 'reuse', used: false, why: null };
        }
      }
      const pause = REPLAY_WAIT_STEPS_MS[step];
      if (pause === undefined) return { kind: 'reuse', used: false, why: 'rotation_timeout' };
      await new Promise((resolve) => setTimeout(resolve, pause));
      const state = await deps.kv.get(marker);
      if (state === REFRESH_USED) used = true;
      else if (state === REFRESH_LIVE && (await deps.kv.take(marker)) === REFRESH_LIVE)
        return { kind: 'owner' };
    }
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
  const userGrants = async (
    userId: string,
    max: number = MAX_OAUTH_DEVICES_PER_USER,
  ): Promise<{ id: string; grant: StoredGrant }[]> => {
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
        if (out.length >= max) return out;
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
      // P5-11: devices are capped per user, but a pass reads a bounded page: repeat while a full page came back and
      // something was revoked (revoked grants are gone, so each pass reaches new rows). Each revocation is immediate.
      for (let pass = 0; pass < 20; pass += 1) {
        const rows = await userGrants(userId, MAX_OAUTH_REVOKE_ALL_SCAN);
        let passRevoked = 0;
        for (const { id, grant } of rows) {
          const facts = grantFacts(grant);
          if (filter.grantId !== undefined && facts.grantId !== filter.grantId) continue;
          if (filter.projectSlug !== undefined && facts.projectSlug !== filter.projectSlug) continue;
          await revokeFamily(userId, id, helpers);
          gone.push(approvalOf(facts.clientId, facts.projectSlug));
          passRevoked += 1;
        }
        revoked += passRevoked;
        if (rows.length < MAX_OAUTH_REVOKE_ALL_SCAN || passRevoked === 0) break;
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

  // ------------------------------------------------------------------------------------------------ clients (P5-08)

  const CLIENT_PREFIX = 'client:';
  const GRANT_KEY_RE = /^grant:([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{16})$/;
  const redirectHostsOf = (uris: unknown): string[] => {
    if (!Array.isArray(uris)) return [];
    const hosts = new Set<string>();
    for (const uri of uris.slice(0, MAX_REDIRECT_URIS)) {
      try {
        hosts.add(new URL(String(uri)).hostname);
      } catch {
        // not a URL: not listed
      }
    }
    return [...hosts];
  };
  /** A stored client record as the admin API shows it; never the secret hash or the raw document. */
  const toClient = (clientId: string, record: Record<string, unknown>, expiration?: number): OAuthClient => {
    const metadataDocument = looksLikeClientIdUrl(clientId);
    let host: string | null = null;
    if (metadataDocument) {
      try {
        host = new URL(clientId).hostname;
      } catch {
        host = null;
      }
    }
    const expiresAtS =
      expiration ??
      (typeof record['registrationExpiresAt'] === 'number' ? record['registrationExpiresAt'] : null);
    return {
      id: clientId,
      kind: metadataDocument ? 'metadata_document' : 'dynamic',
      name: typeof record['clientName'] === 'string' ? safeClientName(record['clientName']) : null,
      host,
      redirectHosts: redirectHostsOf(record['redirectUris']),
      registeredAt: typeof record['registrationDate'] === 'number' ? record['registrationDate'] * 1000 : null,
      expiresAt: expiresAtS === null ? null : expiresAtS * 1000,
    };
  };
  const clients: OAuthClients = Object.freeze({
    async list() {
      // Scan (bounded), then sort newest first and cut: cutting in key order first could hide a real client behind a
      // flood of registrations (P5-10).
      const all: OAuthClient[] = [];
      let truncated = false;
      let cursor: string | undefined;
      scan: do {
        const page = await env.OAUTH_KV.list({
          prefix: CLIENT_PREFIX,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const k of page.keys) {
          if (all.length >= MAX_OAUTH_CLIENTS_SCANNED) {
            truncated = true;
            break scan;
          }
          const clientId = k.name.slice(CLIENT_PREFIX.length);
          const record = (await env.OAUTH_KV.get(k.name, { type: 'json' })) as Record<string, unknown> | null;
          if (record === null || typeof record !== 'object' || record['clientId'] !== clientId) continue;
          all.push(toClient(clientId, record, k.expiration));
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor !== undefined);
      all.sort((a, b) => (b.registeredAt ?? 0) - (a.registeredAt ?? 0));
      if (all.length > MAX_OAUTH_CLIENTS_LISTED) truncated = true;
      return { clients: all.slice(0, MAX_OAUTH_CLIENTS_LISTED), truncated };
    },
    async remove(clientId: string) {
      if (clientId === '' || clientId.length > MAX_CLIENT_ID_URL_CHARS) return null;
      const key = `${CLIENT_PREFIX}${clientId}`;
      const record = (await env.OAUTH_KV.get(key, { type: 'json' })) as Record<string, unknown> | null;
      // The record goes first: a registered client can't start another authorization or refresh meanwhile (a document
      // client may fetch its document again and start over, with consent). Then every device authorization of it.
      // P5-11: a marker holding the scan cursor is written before the record goes, so a call that stops at its work
      // budget (or is cut off) is resumed by the same removal again, even though the record is gone.
      const marker = `${CLIENT_REMOVAL_PREFIX}${await sha256Hex(clientId)}`;
      const saved = await deps.kv.get(marker);
      if (record !== null && saved === null) {
        await deps.kv.put(marker, '', { expirationTtl: CLIENT_REMOVAL_TTL_S });
      }
      if (record !== null) await env.OAUTH_KV.delete(key);
      const resumed = saved !== null;
      const helpers = (await server([])).getOAuthApi(env);
      let revoked = 0;
      let scanned = 0;
      let complete = true;
      let cursor: string | undefined = saved !== null && saved !== '' ? saved : undefined;
      scan: do {
        const page = await env.OAUTH_KV.list({
          prefix: 'grant:',
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const k of page.keys) {
          if (scanned >= removalScanBudget || revoked >= removalRevokeBudget) {
            complete = false;
            break scan;
          }
          scanned += 1;
          const m = GRANT_KEY_RE.exec(k.name);
          if (m === null) continue;
          const grant = (await env.OAUTH_KV.get(k.name, { type: 'json' })) as StoredGrant | null;
          if (grant === null || grant.clientId !== clientId) continue;
          // Pending code exchanges count too: revoking the grant makes the code useless.
          await revokeFamily(m[1] as string, m[2] as string, helpers);
          revoked += 1;
        }
        cursor = page.list_complete ? undefined : page.cursor;
        // Resume point: the start of the next page (rows already passed on this page are not rescanned).
        if (cursor !== undefined) await deps.kv.put(marker, cursor, { expirationTtl: CLIENT_REMOVAL_TTL_S });
      } while (cursor !== undefined);
      if (complete) await deps.kv.delete(marker);
      else logger.warn('oauth client removal stopped at its work budget; repeat it to finish', { revoked });
      const forgotten = await forgetClientApprovals(deps.kv, clientId);
      if (record === null && !resumed && revoked === 0 && forgotten === 0) return null;
      logger.info('oauth client removed', { devicesRevoked: revoked, approvalsForgotten: forgotten });
      return {
        client: toClient(clientId, record ?? {}),
        devicesRevoked: revoked,
        approvalsForgotten: forgotten,
        complete,
      };
    },
    async registration() {
      const setting = await registrationSetting();
      return { enabled: deploymentRegistration && setting, deployment: deploymentRegistration, setting };
    },
    async setRegistration(enabled: boolean) {
      await deps.storage.settings.set(OAUTH_REGISTRATION_SETTING, enabled);
      registrationCache = { setting: enabled, at: clock.now() };
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
        scopes_supported: writeScope ? [MCP_SCOPE, MCP_WRITE_SCOPE] : [MCP_SCOPE],
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
      if (!(await registrationOn())) return jsonError(404, 'not_found', 'Client registration is disabled.');
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
      // One source must not be able to use up the shared cap (T10): a per-address count of registrations the provider
      // accepted (counted below, after the 201), checked first. Reads, so a burst may overshoot by its concurrency;
      // the per-address request rule bounds that.
      const caller = callerKey(c);
      const ipWindow =
        registrationIpLimit === null ? 0 : Math.floor(clock.now() / 1000 / registrationIpLimit.perSeconds);
      const ipCounter = `${REGISTRATION_IP_COUNTER_PREFIX}${caller}:${ipWindow}`;
      if (registrationIpLimit !== null) {
        const done = Number.parseInt((await deps.kv.get(ipCounter)) ?? '0', 10) || 0;
        if (done >= registrationIpLimit.requests) {
          logger.warn('oauth registration per-address cap reached', { limit: registrationIpLimit.requests });
          const response = jsonError(
            429,
            'temporarily_unavailable',
            'Too many client registrations from this address; retry later.',
          );
          response.headers.set(
            'Retry-After',
            String((ipWindow + 1) * registrationIpLimit.perSeconds - Math.floor(clock.now() / 1000)),
          );
          return response;
        }
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
      if (registrationIpLimit !== null) {
        await deps.kv.increment(ipCounter, { expirationTtl: registrationIpLimit.perSeconds });
      }
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
      const clientProblem = await resolveClient(clientId, callerKey(c));
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
        // RFC 7636 §4.1: a verifier is 43-128 unreserved characters. Refused before the code is consumed, so a short,
        // guessable verifier (a client bug) never redeems a code (review L-PKCE).
        if (!PKCE_VERIFIER_RE.test(form?.get('code_verifier') ?? '')) {
          return jsonError(400, 'invalid_request', 'code_verifier must be 43-128 characters (RFC 7636).');
        }
        const code = form?.get('code') ?? '';
        // Single use, atomically: of concurrent exchanges at most one finds the marker (P4 review note, T9).
        const fresh = looksLikeOAuthToken(code) && (await deps.kv.take(await codeMarker(code))) !== null;
        if (!fresh) {
          if (looksLikeOAuthToken(code)) await revokeReplayed(code, as.getOAuthApi(env));
          return jsonError(400, 'invalid_grant', 'Invalid authorization code');
        }
      }
      if (grantType === 'refresh_token' && form !== null) {
        // Single use under concurrency (P5-05): of concurrent refreshes with one token at most one finds it `live`.
        // With a reuse interval (P5-09) the others get that rotation's result; anything else is reuse and revokes the
        // device's token family.
        const presented = form.get('refresh_token') ?? '';
        if (!looksLikeOAuthToken(presented)) return jsonError(400, 'invalid_grant', 'Invalid refresh token');
        const marker = await refreshMarker(presented);
        const helpers = as.getOAuthApi(env);
        let state = await deps.kv.take(marker);
        let replayRefused: string | null = null;
        if (state !== REFRESH_LIVE && reuseWindow > 0) {
          const outcome = await awaitReplay(c, form, presented, marker, state);
          if (outcome.kind === 'replay') return outcome.response;
          if (outcome.kind === 'owner') state = REFRESH_LIVE;
          else {
            replayRefused = outcome.why;
            state = outcome.used ? REFRESH_USED : null;
          }
        } else if (state !== REFRESH_LIVE && state !== null) {
          await deps.kv.put(marker, REFRESH_USED, { expirationTtl: markerTtl });
        }
        if (state !== REFRESH_LIVE) {
          await refreshReused(c, presented, state !== null, helpers, replayRefused);
          return jsonError(400, 'invalid_grant', 'Invalid refresh token');
        }
        let refreshed: Response | undefined;
        try {
          refreshed = await fetchProvider(as, c, body);
        } finally {
          await settleRefresh(presented, marker, refreshed, c, form);
        }
        if (refreshed.ok && (await revokedMeanwhile(presented, helpers))) {
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
        await replaceEarlierDevices(c, form?.get('code') ?? '', as.getOAuthApi(env));
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

    async prepare(c, params) {
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
      const caller = callerKey(c);
      const clientProblem = await resolveClient(requestedClient, caller);
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
      // `mcp:write` only when this deployment has write tools and the client asked for it (P7-09); the user still has
      // to tick its box, and `approve` drops it otherwise.
      const scope = [
        MCP_SCOPE,
        ...(writeScope && requested.includes(MCP_WRITE_SCOPE) ? [MCP_WRITE_SCOPE] : []),
        ...(requested.includes('offline_access') ? ['offline_access'] : []),
      ];
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
        // OIDC Core §3.1.2.6 codes (`prompt=none`) the provider's error type doesn't list: its redirect with `error`
        // swapped, so `state` and `iss` stay.
        refuseSilently: (code: 'consent_required' | 'login_required' | 'invalid_request') => {
          const target = new URL(mod.authorizationErrorRedirect(authRequest, 'access_denied'));
          target.searchParams.set('error', code);
          return target.href;
        },
        approve: async ({
          userId,
          grantId,
          label,
          write,
        }: {
          readonly userId: string;
          readonly grantId: string;
          readonly label?: string | null;
          readonly write?: boolean;
        }) => {
          if (used) throw new Error('an authorization request is approved at most once');
          used = true;
          // The consent step may take a while (sign-in): a CIMD client's cached document may have expired since.
          const clientProblem = await resolveClient(authRequest.clientId, caller);
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
          // Writes need all three: the client asked, the user ticked the box, the grant has write tools (P7-09).
          const writes =
            write === true &&
            scope.includes(MCP_WRITE_SCOPE) &&
            decision.access.tools.some((t) => WRITE_TOOL_NAMES.includes(t));
          const granted = Object.freeze(scope.filter((s) => s !== MCP_WRITE_SCOPE || writes));
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
            scope: [...granted],
            props,
            // Review H1: the provider's default revokes the user's other devices of this client and resource as soon
            // as a code is *issued*. With a remembered approval that is one cross-site GET: any page could disconnect
            // a live app, and the provider's revocation leaves no tombstone. Earlier devices are replaced only once
            // the new code is redeemed ({@link replaceEarlierDevices}).
            revokeExistingGrants: false,
          });
          const code = new URL(redirectTo).searchParams.get('code');
          if (code === null) throw new Error('the provider returned no authorization code');
          await deps.kv.put(await codeMarker(code), '1', { expirationTtl: OAUTH_CODE_TTL_S });
          return { ok: true, redirectTo, scope: granted } as const;
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
      // A token without `mcp:write` never sees a write tool, whatever the grant allows (P7-09, ADR-0015).
      let access = decision.access;
      if (!(writeScope && validated.scope.includes(MCP_WRITE_SCOPE))) {
        const tools = access.tools.filter((t) => !WRITE_TOOL_NAMES.includes(t));
        if (tools.length === 0) return { ok: false, stage: 'access', tokenId, reason: 'no_tools' };
        if (tools.length !== access.tools.length)
          access = Object.freeze({ ...access, tools: Object.freeze(tools) });
      }
      return {
        ok: true,
        tokenId,
        clientId: validated.clientId,
        tokenExpiresAt: validated.expiresAt * 1000,
        access,
        credential: decision.credential,
      };
    },

    devices,
    clients,
  };
  return runtime;
}
