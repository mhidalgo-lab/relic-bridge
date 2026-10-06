// SPDX-License-Identifier: Apache-2.0
// The authorization matrix (P2-12): every route the HTTP app serves and every kind of caller. Data only; the tests in
// `routes.test.ts` cross them, and the guard test fails when the app gains a route that is not listed here.
//
// Adding a route: add it to MCP_ROUTES / ADMIN_ROUTES / PUBLIC_ROUTES (pattern exactly as Hono registers it, a sample
// path and a body valid enough to reach authentication). Adding a way to authenticate (OAuth, sessions): add the
// principals that misuse it, with the stable deny reason the audit row must carry.
import { generateTokenString, revokeSession, revokeUserSessions } from '@relic-bridge/auth';
import { expect } from 'vitest';
import { NR_KEY, T0 } from '../fixtures.ts';
import { ADMIN_TOKEN, type Harness, NR_KEY_ADMIN, PUBLIC_ORIGIN } from './harness.ts';

export interface RouteCase {
  readonly method: string;
  /** As Hono registers it (`/api/admin/v1/users/:id`). */
  readonly pattern: string;
  /** A concrete path for the request (`{slug}` is replaced for MCP routes). */
  readonly path: string;
  readonly body?: unknown;
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'authz', version: '0' } },
};

/** Self-service routes (P4-10): `/me/*`. */
export const isSelfService = (route: RouteCase): boolean => route.pattern.startsWith('/api/admin/v1/me/');

export const MCP_ROUTES: readonly RouteCase[] = [
  { method: 'POST', pattern: '/p/:slug/mcp', path: '/p/{slug}/mcp', body: INITIALIZE },
  { method: 'GET', pattern: '/p/:slug/mcp', path: '/p/{slug}/mcp' },
  { method: 'DELETE', pattern: '/p/:slug/mcp', path: '/p/{slug}/mcp' },
];

/** The pass-through route (P2-15): registered only when `passthrough` is configured, else 404. */
export const PASSTHROUGH_ROUTES: readonly RouteCase[] = [
  { method: 'POST', pattern: '/passthrough/mcp', path: '/passthrough/mcp', body: INITIALIZE },
  { method: 'GET', pattern: '/passthrough/mcp', path: '/passthrough/mcp' },
  { method: 'DELETE', pattern: '/passthrough/mcp', path: '/passthrough/mcp' },
];

const A = '/api/admin/v1';
/** Ids that don't exist: a control request with the admin token must not change anything worth scanning. */
export const ADMIN_ROUTES: readonly RouteCase[] = [
  { method: 'GET', pattern: `${A}/openapi.json`, path: `${A}/openapi.json` },
  { method: 'GET', pattern: `${A}/users`, path: `${A}/users` },
  { method: 'POST', pattern: `${A}/users`, path: `${A}/users`, body: { email: 'new@example.com' } },
  { method: 'GET', pattern: `${A}/users/:id`, path: `${A}/users/usr_none` },
  { method: 'PATCH', pattern: `${A}/users/:id`, path: `${A}/users/usr_none`, body: { disabled: true } },
  // P5-05: a user's OAuth devices (admins; owners' devices only by owners).
  { method: 'GET', pattern: `${A}/users/:id/oauth-devices`, path: `${A}/users/usr_none/oauth-devices` },
  {
    method: 'POST',
    pattern: `${A}/users/:id/oauth-devices/:deviceId/revoke`,
    path: `${A}/users/usr_none/oauth-devices/oauth_none/revoke`,
  },
  // Sessions (P4-02): sign a user out everywhere; who is calling.
  { method: 'POST', pattern: `${A}/users/:id/sessions/revoke`, path: `${A}/users/usr_none/sessions/revoke` },
  // Identity re-binding (P4-09): owner only; the control call on an unknown user changes nothing.
  {
    method: 'POST',
    pattern: `${A}/users/:id/unbind`,
    path: `${A}/users/usr_none/unbind`,
    body: { confirm: 'nobody@example.test' },
  },
  { method: 'GET', pattern: `${A}/session`, path: `${A}/session` },
  { method: 'GET', pattern: `${A}/credentials`, path: `${A}/credentials` },
  {
    method: 'POST',
    pattern: `${A}/credentials`,
    path: `${A}/credentials`,
    body: { label: 'k', region: 'US', apiKey: NR_KEY_ADMIN },
  },
  { method: 'GET', pattern: `${A}/credentials/:id`, path: `${A}/credentials/cred_none` },
  {
    method: 'PATCH',
    pattern: `${A}/credentials/:id`,
    path: `${A}/credentials/cred_none`,
    body: { label: 'x' },
  },
  { method: 'DELETE', pattern: `${A}/credentials/:id`, path: `${A}/credentials/cred_none` },
  {
    method: 'POST',
    pattern: `${A}/credentials/:id/rotate`,
    path: `${A}/credentials/cred_none/rotate`,
    body: { apiKey: NR_KEY_ADMIN },
  },
  {
    method: 'POST',
    pattern: `${A}/credentials/:id/revalidate`,
    path: `${A}/credentials/cred_none/revalidate`,
  },
  { method: 'GET', pattern: `${A}/projects`, path: `${A}/projects` },
  {
    method: 'POST',
    pattern: `${A}/projects`,
    path: `${A}/projects`,
    body: { slug: 'matrix-new', defaultAccountId: 1, allowedAccountIds: [1] },
  },
  { method: 'GET', pattern: `${A}/projects/:id`, path: `${A}/projects/prj_none` },
  { method: 'PATCH', pattern: `${A}/projects/:id`, path: `${A}/projects/prj_none`, body: { disabled: true } },
  { method: 'DELETE', pattern: `${A}/projects/:id`, path: `${A}/projects/prj_none` },
  { method: 'GET', pattern: `${A}/grants`, path: `${A}/grants` },
  {
    method: 'POST',
    pattern: `${A}/grants`,
    path: `${A}/grants`,
    body: { projectId: 'prj_none', label: 'bot' },
  },
  { method: 'GET', pattern: `${A}/grants/:id`, path: `${A}/grants/grt_none` },
  { method: 'POST', pattern: `${A}/grants/:id/revoke`, path: `${A}/grants/grt_none/revoke` },
  { method: 'DELETE', pattern: `${A}/grants/:id`, path: `${A}/grants/grt_none` },
  // P7-12: per-grant quota (admins and owners; an owner's grant only by owners) and the usage against it.
  {
    method: 'PUT',
    pattern: `${A}/grants/:id/quota`,
    path: `${A}/grants/grt_none/quota`,
    body: { quota: { day: { queries: 10 } } },
  },
  { method: 'GET', pattern: `${A}/usage/quotas`, path: `${A}/usage/quotas` },
  { method: 'GET', pattern: `${A}/tokens`, path: `${A}/tokens` },
  {
    method: 'POST',
    pattern: `${A}/tokens`,
    path: `${A}/tokens`,
    body: { grantId: 'grt_none', label: 'laptop' },
  },
  { method: 'GET', pattern: `${A}/tokens/:id`, path: `${A}/tokens/tok_none` },
  { method: 'POST', pattern: `${A}/tokens/:id/revoke`, path: `${A}/tokens/tok_none/revoke` },
  { method: 'GET', pattern: `${A}/audit`, path: `${A}/audit` },
  // P4-05: usage statistics (admins and owners only).
  { method: 'GET', pattern: `${A}/audit/stats`, path: `${A}/audit/stats` },
  // Master-key rotation (P3-11): every row is already current in the fixture, so the control call changes nothing.
  { method: 'POST', pattern: `${A}/keys/rotate`, path: `${A}/keys/rotate`, body: {} },
  // Config import/export (P7-06): owner only. Export without keys and a dry-run import of an empty bundle change nothing.
  { method: 'POST', pattern: `${A}/config/export`, path: `${A}/config/export`, body: {} },
  {
    method: 'POST',
    pattern: `${A}/config/import`,
    path: `${A}/config/import`,
    body: {
      bundle: {
        format: 'relic-bridge-config',
        version: 1,
        exportedAt: '2026-01-01T00:00:00.000Z',
        users: [],
        credentials: [],
        projects: [],
        grants: [],
        settings: {},
      },
    },
  },
  // Owner setup link (P4-01): the control call issues one (a single-use code in `kv`, nothing else changes).
  { method: 'POST', pattern: `${A}/setup-links`, path: `${A}/setup-links`, body: {} },
  // Member self-service (P4-10): a session user's own rows. The admin token is nobody (403 `no_user`); ids don't exist.
  { method: 'GET', pattern: `${A}/me/credentials`, path: `${A}/me/credentials` },
  {
    method: 'POST',
    pattern: `${A}/me/credentials`,
    path: `${A}/me/credentials`,
    body: { label: 'mine', region: 'US', apiKey: NR_KEY_ADMIN },
  },
  {
    method: 'PATCH',
    pattern: `${A}/me/credentials/:id`,
    path: `${A}/me/credentials/cred_none`,
    body: { label: 'x' },
  },
  { method: 'DELETE', pattern: `${A}/me/credentials/:id`, path: `${A}/me/credentials/cred_none` },
  {
    method: 'POST',
    pattern: `${A}/me/credentials/:id/rotate`,
    path: `${A}/me/credentials/cred_none/rotate`,
    body: { apiKey: NR_KEY_ADMIN },
  },
  {
    method: 'POST',
    pattern: `${A}/me/credentials/:id/revalidate`,
    path: `${A}/me/credentials/cred_none/revalidate`,
  },
  { method: 'GET', pattern: `${A}/me/grants`, path: `${A}/me/grants` },
  {
    method: 'PATCH',
    pattern: `${A}/me/grants/:id`,
    path: `${A}/me/grants/grt_none`,
    body: { credentialId: null },
  },
  { method: 'GET', pattern: `${A}/me/tokens`, path: `${A}/me/tokens` },
  {
    method: 'POST',
    pattern: `${A}/me/tokens`,
    path: `${A}/me/tokens`,
    body: { grantId: 'grt_none', label: 'laptop' },
  },
  { method: 'POST', pattern: `${A}/me/tokens/:id/revoke`, path: `${A}/me/tokens/tok_none/revoke` },
  // P5-05: OAuth devices (own; and per user for admins). Empty lists and 404s without OAuth.
  { method: 'GET', pattern: `${A}/me/oauth-devices`, path: `${A}/me/oauth-devices` },
  {
    method: 'POST',
    pattern: `${A}/me/oauth-devices/:id/revoke`,
    path: `${A}/me/oauth-devices/oauth_none/revoke`,
  },
  // P5-08: OAuth clients and the registration switch (owners only). Without OAuth: an empty list and 404s.
  { method: 'GET', pattern: `${A}/oauth/clients`, path: `${A}/oauth/clients` },
  {
    method: 'POST',
    pattern: `${A}/oauth/clients/remove`,
    path: `${A}/oauth/clients/remove`,
    body: { clientId: 'client_none' },
  },
  { method: 'GET', pattern: `${A}/oauth/registration`, path: `${A}/oauth/registration` },
  {
    method: 'POST',
    pattern: `${A}/oauth/registration`,
    path: `${A}/oauth/registration`,
    body: { enabled: false },
  },
  // Not a registered route: the admin catch-all (`ALL /api/admin/v1/*`) must authenticate before saying 404.
  { method: 'GET', pattern: `${A}/*`, path: `${A}/no-such-endpoint` },
];

/**
 * Sign-in routes (P4-01): reachable without credentials by design (a browser that is not signed in yet). They must
 * confer nothing on bearer tokens, cookies or query credentials: only a verified IdP answer or Access assertion counts,
 * and they only exist when sign-in is configured.
 */
export const IDENTITY_ROUTES: readonly RouteCase[] = [
  { method: 'GET', pattern: '/auth/login', path: '/auth/login' },
  { method: 'GET', pattern: '/auth/login/:provider', path: '/auth/login/github' },
  { method: 'GET', pattern: '/auth/callback/:provider', path: '/auth/callback/github' },
  { method: 'GET', pattern: '/auth/cf-access', path: '/auth/cf-access' },
  // Sign-out (P4-02): ends the session the cookie names, only with its CSRF token from our own origin.
  { method: 'POST', pattern: '/auth/logout', path: '/auth/logout' },
];

const ui = (method: string, pattern: string, path = pattern): RouteCase => ({ method, pattern, path });

/**
 * Admin UI pages (P4-03): exist when sign-in is configured. Only the admin session cookie authenticates them (bearer
 * tokens, the admin token, MCP tokens and query credentials are ignored: the answer is the sign-in redirect).
 */
export const UI_ROUTES: readonly RouteCase[] = [
  { method: 'GET', pattern: '/admin', path: '/admin' },
  // P4-04 screens (admin and owner). Ids that don't exist: a positive control must not change anything.
  ui('GET', '/admin/credentials'),
  ui('GET', '/admin/credentials/new'),
  ui('POST', '/admin/credentials'),
  ui('GET', '/admin/credentials/:id', '/admin/credentials/cred_none'),
  ui('POST', '/admin/credentials/:id/rename', '/admin/credentials/cred_none/rename'),
  ui('POST', '/admin/credentials/:id/revalidate', '/admin/credentials/cred_none/revalidate'),
  ui('GET', '/admin/credentials/:id/rotate', '/admin/credentials/cred_none/rotate'),
  ui('POST', '/admin/credentials/:id/rotate', '/admin/credentials/cred_none/rotate'),
  ui('POST', '/admin/credentials/:id/delete', '/admin/credentials/cred_none/delete'),
  ui('GET', '/admin/projects'),
  ui('GET', '/admin/projects/new'),
  ui('POST', '/admin/projects'),
  ui('GET', '/admin/projects/:id', '/admin/projects/prj_none'),
  ui('POST', '/admin/projects/:id', '/admin/projects/prj_none'),
  ui('POST', '/admin/projects/:id/disable', '/admin/projects/prj_none/disable'),
  ui('POST', '/admin/projects/:id/enable', '/admin/projects/prj_none/enable'),
  ui('POST', '/admin/projects/:id/delete', '/admin/projects/prj_none/delete'),
  ui('GET', '/admin/grants'),
  ui('GET', '/admin/grants/new'),
  ui('POST', '/admin/grants'),
  ui('GET', '/admin/grants/:id', '/admin/grants/grt_none'),
  ui('POST', '/admin/grants/:id/quota', '/admin/grants/grt_none/quota'),
  ui('POST', '/admin/grants/:id/revoke', '/admin/grants/grt_none/revoke'),
  ui('POST', '/admin/grants/:id/delete', '/admin/grants/grt_none/delete'),
  ui('GET', '/admin/tokens'),
  ui('GET', '/admin/tokens/new'),
  ui('POST', '/admin/tokens'),
  ui('POST', '/admin/tokens/:id/revoke', '/admin/tokens/tok_none/revoke'),
  // P4-06: client configuration snippets (admin and owner).
  ui('GET', '/admin/connect'),
  ui('GET', '/admin/users'),
  ui('GET', '/admin/users/new'),
  ui('POST', '/admin/users'),
  ui('GET', '/admin/users/:id', '/admin/users/usr_none'),
  ui('POST', '/admin/users/:id', '/admin/users/usr_none'),
  ui('POST', '/admin/users/:id/disable', '/admin/users/usr_none/disable'),
  ui('POST', '/admin/users/:id/enable', '/admin/users/usr_none/enable'),
  ui('POST', '/admin/users/:id/signout', '/admin/users/usr_none/signout'),
  ui('GET', '/admin/users/:id/unbind', '/admin/users/usr_none/unbind'),
  ui('POST', '/admin/users/:id/unbind', '/admin/users/usr_none/unbind'),
  // P5-05: disconnect a user's OAuth app (admin; an owner's only by owners, decided by the API).
  ui('POST', '/admin/users/:id/apps/:device/revoke', '/admin/users/usr_none/apps/oauth_none/revoke'),
  // P5-08: OAuth apps and the registration switch (owners only).
  ui('GET', '/admin/oauth-clients'),
  ui('POST', '/admin/oauth-clients/remove'),
  ui('POST', '/admin/oauth-clients/registration'),
  // P4-15: member self-service screens (every signed-in role; the /me API decides, ids of others are 404 pages).
  ui('GET', '/admin/me'),
  ui('GET', '/admin/me/keys/new'),
  ui('POST', '/admin/me/keys'),
  ui('GET', '/admin/me/keys/:id', '/admin/me/keys/cred_none'),
  ui('POST', '/admin/me/keys/:id/rename', '/admin/me/keys/cred_none/rename'),
  ui('POST', '/admin/me/keys/:id/revalidate', '/admin/me/keys/cred_none/revalidate'),
  ui('GET', '/admin/me/keys/:id/rotate', '/admin/me/keys/cred_none/rotate'),
  ui('POST', '/admin/me/keys/:id/rotate', '/admin/me/keys/cred_none/rotate'),
  ui('POST', '/admin/me/keys/:id/delete', '/admin/me/keys/cred_none/delete'),
  ui('GET', '/admin/me/grants/:id', '/admin/me/grants/grt_none'),
  ui('POST', '/admin/me/grants/:id', '/admin/me/grants/grt_none'),
  ui('GET', '/admin/me/tokens/new'),
  ui('POST', '/admin/me/tokens'),
  ui('POST', '/admin/me/tokens/:id/revoke', '/admin/me/tokens/tok_none/revoke'),
  // P5-05: disconnect one of my OAuth apps (any role; ids not in my own list are the 404 page).
  ui('POST', '/admin/me/apps/:id/revoke', '/admin/me/apps/oauth_none/revoke'),
  // P4-05: the audit viewer and CSV (any role; members see their own rows) and usage statistics (admin and owner).
  ui('GET', '/admin/audit'),
  ui('GET', '/admin/audit.csv'),
  ui('GET', '/admin/usage'),
  // Not a registered route: the signed-in 404 page of the UI catch-all (`ALL /admin/*`).
  { method: 'GET', pattern: '/admin/*', path: '/admin/no-such-page' },
];

/** Static UI assets (P4-03): public, hashed, immutable; unknown names are a 404 page. */
export const UI_ASSET_ROUTES: readonly RouteCase[] = [
  { method: 'GET', pattern: '/admin/assets/:file', path: '/admin/assets/no-such-asset.css' },
];

export const PUBLIC_ROUTES: readonly RouteCase[] = [
  { method: 'GET', pattern: '/health', path: '/health' },
  { method: 'GET', pattern: '/version', path: '/version' },
];

/**
 * The OAuth 2.1 endpoints (P5-01): registered only with the `oauth` option. Unauthenticated by design (the token and
 * registration bodies are their own credentials); `oauth-suite.ts` checks they answer alike whatever a caller presents.
 */
export const OAUTH_ROUTES: readonly RouteCase[] = [
  {
    method: 'GET',
    pattern: '/.well-known/oauth-authorization-server',
    path: '/.well-known/oauth-authorization-server',
  },
  // RFC 9728 per-project metadata (P5-02): built from the path, so it answers alike for any slug.
  {
    method: 'GET',
    pattern: '/.well-known/oauth-protected-resource/p/:slug/mcp',
    path: '/.well-known/oauth-protected-resource/p/prod/mcp',
  },
  { method: 'GET', pattern: '/oauth/authorize', path: '/oauth/authorize' },
  { method: 'POST', pattern: '/oauth/token', path: '/oauth/token', body: {} },
  { method: 'POST', pattern: '/oauth/register', path: '/oauth/register', body: {} },
];

/**
 * The built-in consent screen (P5-04): registered with `oauth` unless a custom consent step is given. Session pages:
 * only the admin session cookie counts (bearers, the admin token and query credentials are ignored), unsafe methods
 * need the session's CSRF token from our own origin. `consent.test.ts` crosses them with principals and defects.
 */
export const CONSENT_ROUTES: readonly RouteCase[] = [
  { method: 'POST', pattern: '/oauth/consent', path: '/oauth/consent' },
  { method: 'GET', pattern: '/oauth/approvals', path: '/oauth/approvals' },
  { method: 'POST', pattern: '/oauth/approvals/forget', path: '/oauth/approvals/forget' },
];

/**
 * `ALL` entries in Hono's route table (middleware and catch-alls), with why each is safe. A new one fails the guard.
 */
export const WILDCARD_ROUTES: Readonly<Record<string, string>> = {
  '/passthrough/mcp':
    'CORS middleware of the pass-through route (on when CORS origins are configured); the handlers are matrix rows',
  '/*': 'global middleware: request id, security headers, Host/Origin checks (no handler of its own)',
  [`${A}/*`]:
    'admin authentication middleware and the authenticated 404 catch-all (matrix row GET /no-such-endpoint)',
  '/auth/*': 'sign-in routes: the pre-authentication hook (per-IP limit) only, no handler of its own',
  '/admin/*':
    'admin UI catch-all: session first (sign-in redirect), then the signed-in 404 page (matrix row GET /admin/*)',
};

// ---------------------------------------------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------------------------------------------

/** What a caller presents. */
export interface Presented {
  readonly headers: Readonly<Record<string, string>>;
  /** MCP routes only: the project slug in the path. */
  readonly slug: string;
  /** Appended to the path (credentials in the query string). */
  readonly query?: string;
  /** Records the baseline created, for `broken` to break. */
  readonly ids?: Readonly<Record<string, string>>;
}

const id = (p: Presented, key: string): string => {
  const value = p.ids?.[key];
  if (value === undefined) throw new Error(`baseline has no ${key}`);
  return value;
};

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const mutate = (t: string): string => t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');

/**
 * An MCP caller: `valid` builds a working baseline (the positive control answers it), `broken` applies the one defect
 * under test to it. `reason` is the stable deny code the audit row carries (never shown to the client).
 */
export interface McpPrincipal {
  readonly name: string;
  readonly reason: string;
  valid(h: Harness): Promise<Presented>;
  broken(h: Harness, valid: Presented): Promise<Presented>;
}

/** A baseline on a fresh project of its own, so a defect can't disturb the other principals. */
async function tenant(h: Harness, slug: string): Promise<Presented> {
  const t = await h.addTenant(slug);
  return { headers: bearer(t.token.value), slug, ids: { projectId: t.projectId, grantId: t.grantId } };
}

const prod = async (h: Harness): Promise<Presented> => ({
  headers: bearer(h.world.tokens.prod),
  slug: 'prod',
});
const token = (p: Presented): string => (p.headers['authorization'] ?? '').replace(/^Bearer /, '');

export const MCP_PRINCIPALS: readonly McpPrincipal[] = [
  // --- an admin browser session is not an MCP credential (P4-02) ---
  {
    name: 'owner admin session cookie instead of a token',
    reason: 'missing_token',
    valid: prod,
    broken: async (h, p) => ({ ...p, headers: (await h.addSession({ role: 'owner' })).headers }),
  },
  // --- credentials missing or malformed (offline checks) ---
  {
    name: 'no credentials',
    reason: 'missing_token',
    valid: prod,
    broken: async (_h, p) => ({ ...p, headers: {} }),
  },
  {
    name: 'Basic scheme',
    reason: 'malformed_header',
    valid: prod,
    broken: async (_h, p) => ({ ...p, headers: { authorization: `Basic ${btoa(`u:${token(p)}`)}` } }),
  },
  {
    name: 'empty bearer',
    reason: 'malformed_header',
    valid: prod,
    broken: async (_h, p) => ({ ...p, headers: { authorization: 'Bearer ' } }),
  },
  {
    name: 'token without scheme',
    reason: 'malformed_header',
    valid: prod,
    broken: async (_h, p) => ({ ...p, headers: { authorization: token(p) } }),
  },
  {
    name: 'garbage token',
    reason: 'malformed',
    valid: prod,
    broken: async (_h, p) => ({ ...p, headers: bearer('not-a-token') }),
  },
  {
    name: 'bad checksum',
    reason: 'bad_checksum',
    valid: prod,
    broken: async (_h, p) => ({ ...p, headers: bearer(mutate(token(p))) }),
  },
  {
    name: 'well-formed unknown token',
    reason: 'unknown',
    valid: prod,
    broken: async (_h, p) => ({ ...p, headers: bearer(generateTokenString()) }),
  },
  {
    name: 'New Relic key as token',
    reason: 'malformed',
    valid: prod,
    broken: async (_h, p) => ({ ...p, headers: bearer(NR_KEY) }),
  },
  {
    name: 'admin token on MCP',
    reason: 'malformed',
    valid: prod,
    broken: async (_h, p) => ({ ...p, headers: bearer(ADMIN_TOKEN) }),
  },
  {
    name: 'token in a cookie',
    reason: 'missing_token',
    valid: prod,
    broken: async (_h, p) => ({ ...p, headers: { cookie: `token=${token(p)}; rb=${token(p)}` } }),
  },
  {
    name: 'token in the query string',
    reason: 'missing_token',
    valid: prod,
    broken: async (_h, p) => ({ ...p, headers: {}, query: `access_token=${token(p)}&token=${token(p)}` }),
  },
  {
    name: 'token in another header',
    reason: 'missing_token',
    valid: prod,
    broken: async (_h, p) => ({ ...p, headers: { 'x-api-key': token(p), 'api-key': token(p) } }),
  },
  // --- the token itself ---
  {
    name: 'expired token',
    reason: 'expired',
    valid: async (h) => {
      const t = await h.addToken(h.world.grantIds.prod, { ttl: 60_000 });
      return { headers: bearer(t.value), slug: 'prod' };
    },
    broken: async (h, p) => {
      h.world.clock.advance(60_000);
      return p;
    },
  },
  {
    name: 'revoked token',
    reason: 'revoked',
    valid: async (h) => {
      const t = await h.addToken(h.world.grantIds.prod);
      return { headers: bearer(t.value), slug: 'prod', ids: { tokenId: t.id } };
    },
    broken: async (h, p) => {
      await h.world.storage.accessTokens.revoke(id(p, 'tokenId'), T0);
      return p;
    },
  },
  // --- the project ---
  {
    name: 'token of another project',
    reason: 'grant_wrong_project',
    valid: async (h) => ({ headers: bearer(h.world.tokens.eu), slug: 'eu' }),
    broken: async (_h, p) => ({ ...p, slug: 'prod' }),
  },
  {
    name: 'unknown slug',
    reason: 'project_not_found',
    valid: prod,
    broken: async (_h, p) => ({ ...p, slug: 'no-such-project' }),
  },
  {
    name: 'malformed slug',
    reason: 'project_not_found',
    valid: prod,
    broken: async (_h, p) => ({ ...p, slug: 'Bad..Slug' }),
  },
  {
    name: 'disabled project',
    reason: 'project_disabled',
    valid: (h) => tenant(h, 'p-disabled'),
    broken: async (h, p) => {
      await h.world.storage.projects.update(id(p, 'projectId'), { disabledAt: T0 });
      return p;
    },
  },
  // --- the grant ---
  {
    name: 'revoked grant',
    reason: 'grant_revoked',
    valid: (h) => tenant(h, 'g-revoked'),
    broken: async (h, p) => {
      await h.world.storage.grants.update(id(p, 'grantId'), { revokedAt: T0 });
      return p;
    },
  },
  {
    name: 'expired grant',
    reason: 'grant_expired',
    valid: (h) => tenant(h, 'g-expired'),
    broken: async (h, p) => {
      await h.world.storage.grants.update(id(p, 'grantId'), { expiresAt: T0 - 1 });
      return p;
    },
  },
  {
    name: 'grant without a usable tool',
    reason: 'no_tools',
    valid: (h) => tenant(h, 'g-notools'),
    broken: async (h, p) => {
      await h.world.storage.projects.update(id(p, 'projectId'), { enabledTools: ['list_accounts'] });
      await h.world.storage.grants.update(id(p, 'grantId'), { tools: ['whoami'] });
      return p;
    },
  },
  {
    name: 'grant without a usable account',
    reason: 'no_accounts',
    valid: (h) => tenant(h, 'g-noaccounts'),
    broken: async (h, p) => {
      // Account 3 is reachable by the key but not allowed by the project.
      await h.world.storage.grants.update(id(p, 'grantId'), { accountIds: [3] });
      return p;
    },
  },
  {
    name: 'raw NRQL tools only, raw NRQL off',
    reason: 'no_tools',
    valid: (h) => tenant(h, 'g-rawoff'),
    broken: async (h, p) => {
      await h.world.storage.grants.update(id(p, 'grantId'), { tools: ['run_nrql', 'get_query_result'] });
      await h.world.storage.projects.update(id(p, 'projectId'), { limits: { rawNrql: false } });
      return p;
    },
  },
  // --- the user ---
  {
    name: 'disabled user',
    reason: 'user_disabled',
    valid: async (h) => {
      const userId = await h.addUser('disabled@example.com');
      const grantId = await h.addGrant(h.world.projectIds.prod, { userId });
      return { headers: bearer((await h.addToken(grantId)).value), slug: 'prod', ids: { userId } };
    },
    broken: async (h, p) => {
      await h.world.storage.users.update(id(p, 'userId'), { disabledAt: T0 });
      return p;
    },
  },
  // --- the credential ---
  ...(
    [
      ['revoked credential', 'credential_revoked', { revokedAt: T0 }],
      [
        'credential New Relic refused',
        'credential_invalid',
        {
          validation: {
            validationStatus: 'invalid',
            validationErrorCode: 'RB_AUTH_INVALID_KEY',
            validatedAt: T0,
          },
        },
      ],
      [
        'unvalidated credential',
        'credential_unvalidated',
        { validation: { validationStatus: 'unvalidated', validatedAt: T0, reachableAccountIds: null } },
      ],
    ] as const
  ).map(
    ([name, reason, patch]): McpPrincipal => ({
      name,
      reason,
      valid: async (h) => {
        const credentialId = await h.addCredential();
        const slug = `c-${reason.replaceAll('_', '-')}`;
        const projectId = await h.addProject(slug, { credentialId });
        const grantId = await h.addGrant(projectId);
        return { headers: bearer((await h.addToken(grantId)).value), slug, ids: { credentialId } };
      },
      broken: async (h, p) => {
        await h.world.storage.credentials.update(id(p, 'credentialId'), patch);
        return p;
      },
    }),
  ),
  {
    name: 'credential owner disabled',
    reason: 'credential_owner_disabled',
    valid: async (h) => {
      const ownerId = await h.addUser('owner@example.com');
      const credentialId = await h.addCredential({ ownerUserId: ownerId });
      const projectId = await h.addProject('c-owner', { credentialId });
      const grantId = await h.addGrant(projectId);
      return { headers: bearer((await h.addToken(grantId)).value), slug: 'c-owner', ids: { ownerId } };
    },
    broken: async (h, p) => {
      await h.world.storage.users.update(id(p, 'ownerId'), { disabledAt: T0 });
      return p;
    },
  },
  {
    name: "grant on someone else's personal key",
    reason: 'credential_not_permitted',
    valid: (h) => tenant(h, 'c-personal'),
    broken: async (h, p) => {
      const otherId = await h.addUser('other@example.com');
      const credentialId = await h.addCredential({ ownerUserId: otherId });
      await h.world.storage.grants.update(id(p, 'grantId'), { credentialId });
      return p;
    },
  },
];

/** An admin API caller and the deny reason its audit row carries. */
/**
 * A pass-through caller presenting something other than a usable New Relic User key. The positive control is the
 * same request with `X-NewRelic-Api-Key: NR_KEY`. `reachesNerdGraph`: the key is well-formed, so validating it costs
 * one NerdGraph call (bounded by the per-IP failure throttle).
 */
export interface PassthroughPrincipal {
  readonly name: string;
  readonly reason: string;
  readonly reachesNerdGraph?: boolean;
  present(h: Harness): Presented | Promise<Presented>;
}

const ptKey = (key: string): Record<string, string> => ({ 'x-newrelic-api-key': key });

export const PASSTHROUGH_PRINCIPALS: readonly PassthroughPrincipal[] = [
  { name: 'no key', reason: 'passthrough_missing_key', present: () => ({ headers: {}, slug: '' }) },
  {
    name: 'blank key header',
    reason: 'passthrough_missing_key',
    present: () => ({ headers: ptKey('   '), slug: '' }),
  },
  {
    name: 'device token as bearer (no key)',
    reason: 'passthrough_missing_key',
    present: (h) => ({ headers: bearer(h.world.tokens.prod), slug: '' }),
  },
  {
    name: 'admin token as bearer (no key)',
    reason: 'passthrough_missing_key',
    present: () => ({ headers: bearer(ADMIN_TOKEN), slug: '' }),
  },
  {
    name: 'NR key as bearer instead of the key header',
    reason: 'passthrough_missing_key',
    present: () => ({ headers: bearer(NR_KEY), slug: '' }),
  },
  {
    name: 'NR key in the query string',
    reason: 'passthrough_missing_key',
    present: () => ({ headers: {}, slug: '', query: `api_key=${encodeURIComponent(NR_KEY)}` }),
  },
  {
    name: 'NR key in a cookie',
    reason: 'passthrough_missing_key',
    present: () => ({ headers: { cookie: `x-newrelic-api-key=${NR_KEY}` }, slug: '' }),
  },
  {
    name: 'owner admin session cookie',
    reason: 'passthrough_missing_key',
    present: async (h) => ({ headers: (await h.addSession({ role: 'owner' })).headers, slug: '' }),
  },
  {
    name: 'device token in the key header',
    reason: 'passthrough_malformed_key',
    present: (h) => ({ headers: ptKey(h.world.tokens.prod), slug: '' }),
  },
  {
    name: 'not a User key (ingest key shape)',
    reason: 'passthrough_malformed_key',
    present: () => ({ headers: ptKey('NRII-FAKETESTINGESTKEY0123456789'), slug: '' }),
  },
  {
    name: 'User key with a trailing garbage character',
    reason: 'passthrough_malformed_key',
    present: () => ({ headers: ptKey(`${NR_KEY}!`), slug: '' }),
  },
  {
    name: 'well-formed key New Relic refuses',
    reason: 'passthrough_invalid_key',
    reachesNerdGraph: true,
    present: () => ({ headers: ptKey('NRAK-UNKNOWNTESTKEY0123456789ABC'), slug: '' }),
  },
];

export interface AdminPrincipal {
  readonly name: string;
  readonly reason: string;
  /** The reason on later requests when the first refusal ends the credential (a disabled user's session, P4-07). */
  readonly reasonAfterFirst?: string;
  present(
    h: Harness,
  ): Promise<{ readonly headers: Readonly<Record<string, string>>; readonly query?: string }>;
}

export const ADMIN_PRINCIPALS: readonly AdminPrincipal[] = [
  { name: 'no credentials', reason: 'admin_missing_token', present: async () => ({ headers: {} }) },
  {
    name: 'Basic scheme',
    reason: 'admin_malformed_header',
    present: async () => ({ headers: { authorization: `Basic ${btoa(`admin:${ADMIN_TOKEN}`)}` } }),
  },
  {
    name: 'token without scheme',
    reason: 'admin_malformed_header',
    present: async () => ({ headers: { authorization: ADMIN_TOKEN } }),
  },
  {
    name: 'wrong admin token',
    reason: 'admin_bad_token',
    present: async () => ({ headers: bearer(`${ADMIN_TOKEN}x`) }),
  },
  {
    name: 'truncated admin token',
    reason: 'admin_bad_token',
    present: async () => ({ headers: bearer(ADMIN_TOKEN.slice(0, -1)) }),
  },
  {
    name: 'valid MCP token',
    reason: 'admin_bad_token',
    present: async (h) => ({ headers: bearer(h.world.tokens.prod) }),
  },
  {
    name: 'limited MCP token',
    reason: 'admin_bad_token',
    present: async (h) => ({ headers: bearer(h.world.tokens.limited) }),
  },
  { name: 'New Relic key', reason: 'admin_bad_token', present: async () => ({ headers: bearer(NR_KEY) }) },
  {
    name: 'admin token in a cookie',
    reason: 'admin_missing_token',
    present: async () => ({ headers: { cookie: `rb_admin=${ADMIN_TOKEN}; token=${ADMIN_TOKEN}` } }),
  },
  {
    name: 'admin token in the query string',
    reason: 'admin_missing_token',
    present: async () => ({ headers: {}, query: `token=${ADMIN_TOKEN}&access_token=${ADMIN_TOKEN}` }),
  },
  // --- admin sessions (P4-02): every defect, each with a valid CSRF token and our own Origin ---
  {
    name: 'malformed session cookie',
    reason: 'session_malformed',
    present: async (h) => withCookie(await h.addSession(), 'rb_session=garbage'),
  },
  {
    name: 'session cookie named twice (cookie tossing)',
    reason: 'session_malformed',
    present: async (h) => {
      const s = await h.addSession();
      return withCookie(s, `${s.cookie}; ${s.cookie}`);
    },
  },
  {
    name: 'session cookie under the __Host- name on http',
    reason: 'admin_missing_token',
    present: async (h) => {
      const s = await h.addSession();
      return withCookie(s, `__Host-rb_session=${s.value}`);
    },
  },
  {
    name: 'unknown session (forged secret)',
    reason: 'session_unknown',
    present: async (h) => {
      const s = await h.addSession();
      return withCookie(s, `rb_session=${s.userId}.${'A'.repeat(43)}`);
    },
  },
  {
    name: "session secret under another user's id",
    reason: 'session_unknown',
    present: async (h) => {
      const s = await h.addSession();
      return withCookie(s, `rb_session=usr_a.${s.value.split('.')[1]}`);
    },
  },
  {
    name: 'logged-out session',
    reason: 'session_unknown',
    present: async (h) => {
      const s = await h.addSession();
      await revokeSession(h.world.storage.kv, s.value);
      return { headers: s.headers };
    },
  },
  {
    name: 'session revoked with all of its user’s sessions',
    reason: 'session_unknown',
    present: async (h) => {
      const s = await h.addSession();
      await revokeUserSessions(h.world.storage.kv, s.userId);
      return { headers: s.headers };
    },
  },
  {
    name: 'session past its absolute lifetime',
    reason: 'session_expired',
    present: async (h) => {
      const s = await h.addSession();
      // Kept active (well inside the idle timeout) until the 12 h lifetime is over.
      for (let i = 0; i < 24; i++) {
        h.world.clock.advance(29 * 60_000);
        expect((await h.send(sessionCheck(s.headers))).status).toBe(200);
      }
      h.world.clock.advance(29 * 60_000);
      return { headers: s.headers };
    },
  },
  {
    name: 'idle session',
    reason: 'session_idle',
    present: async (h) => {
      const s = await h.addSession();
      h.world.clock.advance(30 * 60_000);
      return { headers: s.headers };
    },
  },
  {
    name: 'session of a disabled user',
    reason: 'session_user_disabled',
    // The refusal deletes the session, so re-enabling the user does not revive it (P4-07).
    reasonAfterFirst: 'session_unknown',
    present: async (h) => {
      const s = await h.addSession();
      await h.world.storage.users.update(s.userId, { disabledAt: T0 });
      return { headers: s.headers };
    },
  },
  {
    name: 'owner session next to a wrong bearer token (cookies ignored)',
    reason: 'admin_bad_token',
    present: async (h) => ({ headers: { ...(await h.addSession()).headers, ...bearer(`${ADMIN_TOKEN}x`) } }),
  },
  {
    name: 'owner session next to a Basic header (cookies ignored)',
    reason: 'admin_malformed_header',
    present: async (h) => ({
      headers: { ...(await h.addSession()).headers, authorization: `Basic ${btoa('a:b')}` },
    }),
  },
];

const withCookie = (
  s: { readonly headers: Readonly<Record<string, string>> },
  cookie: string,
): { headers: Record<string, string> } => ({ headers: { ...s.headers, cookie } });

/** `GET /api/admin/v1/session` with these headers (keeps a session active in a principal's setup). */
export const sessionCheck = (headers: Readonly<Record<string, string>>): Request =>
  new Request(`${PUBLIC_ORIGIN}${A}/session`, { headers });

/** Build the request for a route and a caller. */
export function requestFor(
  route: RouteCase,
  presented: {
    readonly headers: Readonly<Record<string, string>>;
    readonly slug?: string;
    readonly query?: string;
  },
): Request {
  const path = route.path.replace('{slug}', presented.slug ?? 'prod');
  const url = `http://localhost${path}${presented.query ? `?${presented.query}` : ''}`;
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    ...presented.headers,
  };
  if (route.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(url, {
    method: route.method,
    headers,
    ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
  });
}
