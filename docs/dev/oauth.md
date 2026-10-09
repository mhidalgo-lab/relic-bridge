# OAuth 2.1 authorization server (`packages/http-app/src/oauth`)

The OAuth server that lets MCP clients without static headers (claude.ai web, Claude mobile, Claude Desktop
connectors) reach `/p/{slug}/mcp`. Built on `@cloudflare/workers-oauth-provider` 1.2.1 (ADR-0009, spike P0-08), run
unmodified on Node and Workers, with its state in the storage `kv` table on both (ADR-0011).

Status: P5-01 (server and token check). Not yet: per-slug Protected Resource Metadata and the `401` discovery
challenge (P5-02), CIMD and DCR hardening (P5-03), sign-in + consent screen and the host switch (P5-04), plan TTL
presets and refresh reuse detection (P5-05). Until P5-04 the server is a constructor option only
(`createHttpApp({ oauth })`, `createWorker({ oauth })`): no deployment setting turns it on.

## Topology

One origin. The **issuer** is the configured public URL (`identity.publicUrl`, `RB_PUBLIC_URL`), never the `Host`
header. Each project is one protected resource, `{issuer}/p/{slug}/mcp`, and a token is bound to exactly one of them
(RFC 8707).

| Route | Served by | Notes |
|---|---|---|
| `GET /.well-known/oauth-authorization-server` | provider | RFC 8414; `protected_resources` stripped (slugs are not public, T19) |
| `GET /oauth/authorize` | ours → provider → consent seam | see below |
| `POST /oauth/token` | provider (after our code check) | code, refresh, RFC 7009 revocation |
| `POST /oauth/register` | provider | RFC 7591 DCR, public clients; `registration: false` turns it off |
| `/.well-known/oauth-protected-resource/p/{slug}/mcp` | — | P5-02 |

All four are unauthenticated: `beforeAuth` runs with scope `oauth` (per-IP `oauth` rule, default 60 per 5 minutes, on
top of the per-IP flood limit), declared bodies above 16 KiB are a 413 and streamed bodies are cut at 16 KiB. On
Workers the `oauth:` buckets are per isolate; the shared Rate Limiting binding still counts every request under `ip:`
(600/min). A registration cap shared across isolates is P5-03's.

## Authorization endpoint

1. Repeated parameters → 400 (RFC 6749 §3.1).
2. `resource`: exactly one, and exactly `{issuer}/p/{slug}/mcp` with a valid slug, else 400 `invalid_target` — before
   the client is known, so never a redirect. The project is **not** looked up here (no slug probing before sign-in).
3. The provider parses the request: client known, redirect URI registered (exact match; loopback ports are flexible
   per RFC 8252), response type. Errors with a validated redirect go back to the client with `state` and `iss`;
   others are a 400 JSON page.
4. PKCE `S256` is required for **every** client (the provider insists only for public ones).
5. The **consent handler** (`OAuthConsentHandler`) gets the validated request (`clientId`, `clientName` — untrusted
   text, `redirectUri`, `redirectHost`, `scope`, `resource`, `projectSlug`) and an API:
   - `approve({ userId, grantId })` runs `resolveAccess` for this slug with that user as principal: another user's
     grant, a service grant, a grant of another project, a revoked/expired grant, a disabled user, an unknown project,
     an unusable credential and the owner-key boundary all refuse (`{ ok: false, reason }`) before any code exists. On
     success the provider mints the grant and code (props: `grantId`, `projectSlug`, `userId`, `clientId`; empty grant
     metadata, T25), we store the single-use marker and return the redirect.
   - `deny()` is the `access_denied` redirect. `authRequest` and `helpers` expose the provider's own consent/upstream
     helpers (`beginConsent`, `approveConsent`, …) for P5-04, which must add sign-in, CSRF and the consent page.

## Token endpoint

- Body: `application/x-www-form-urlencoded` only (as the provider), repeated parameters refused.
- `grant_type=authorization_code`: the marker `oauth-code:<sha256(code)>` is consumed with the atomic `kv.take`
  **before** the provider sees the code. No marker → `invalid_grant`; if the code really was issued for its grant
  (`authCodeId` matches), that grant and its tokens are revoked. Of concurrent redemptions at most one succeeds, and a
  code tried once with a wrong verifier is burnt (an intercepted code is useless). A client retrying an exchange after
  a network error has to authorize again.
- The provider is built with every project's resource declared, so refresh tokens can't be retargeted
  (`invalid_target`) and a deleted project's grants stop refreshing.
- A successful RFC 7009 revocation clears this process's access cache; other isolates follow within the cache TTL
  (≤ 60 s, T15).

## MCP route

`/p/:slug/mcp` keeps one resource server and two credential types:

- `rb_…` → the P2-05 device-token path, unchanged.
- with OAuth on, a bearer shaped like a provider token (`userId:grantId:secret`, ≤ 200 characters) → the provider's
  `validateToken` for `{issuer}/p/{slug}/mcp` only (one `kv` read). The audience, `mcp:read` scope and props must
  match (`projectSlug` = slug, `userId` and `clientId` = the token's), then `resolveAccess({ grantId, userId })`
  decides exactly as for a device token. Everything after that is shared: access cache (capped at the token's
  expiry), `beforeMcp` rate limits, per-request tool scope, audit.
- anything else → `malformed` offline.

Every refusal is the same generic 401 (T19). Deny reasons for logs and audit: `oauth_invalid` (unknown, expired,
revoked or other-audience token), `oauth_mismatch` (props don't match), then the resolver's reasons. Audit rows carry
the OAuth `client_id`; `token_id` is `oauth_<provider grant id>` — stable per device authorization across refreshes,
so per-token rate limits and the audit follow the device.

## Storage

Provider keys are `kv` rows under `oauth:` (`client:…`, `grant:{userId}:{grantId}`, `token:…`), see
`kv-namespace.ts`; expiry is the provider's (`expiration` / `expirationTtl`) and the hourly purge reclaims expired rows.
Key metadata is dropped. Props are encrypted by the provider with a key wrapped by the token itself; client
registrations, grant scopes and user ids are not encrypted (T25: user ids are our opaque `usr_…` ids, never emails).

## Runtimes

- **Workers:** `cloudflare:workers` is real. CIMD stays off (P5-03 adds `global_fetch_strictly_public`).
- **Node:** the provider imports `WorkerEntrypoint` only for `instanceof` checks; the CLI bundle (`apps/cli/tsdown.config.ts`)
  and the Node test projects alias `cloudflare:workers` to `src/oauth/cloudflare-workers-shim.ts`, and the test
  projects inline the package (`server.deps.inline`) so the alias applies. The CLI bundle stays one file
  (`inlineDynamicImports`).
- The provider module is loaded lazily (dynamic `import()`) on the first OAuth request: it prints a CIMD warning at
  import and costs nothing for stdio or token-only servers.

## Tests

- `packages/http-app/test/authz/oauth-suite.ts` — the integration suite (ported from `spikes/oauth/scripts/e2e.ts`):
  metadata, DCR → PKCE → code → token → tool call, cross-slug 401, refresh can't retarget, revocation, expiry, code
  replay and concurrent redemption, PKCE plain/missing, resource checks, redirect URI checks, approval re-checks,
  per-request resolver checks (owner key, disabled user, revoked grant), off-switch, body limits.
  Runs on the HTTP app with memory storage (`oauth.test.ts`, http-app project), on SQLite (`apps/cli/test/oauth-sqlite.test.ts`)
  and on the Worker with local D1 (`pnpm test:workers`, via the authz host swap).
- `packages/http-app/test/oauth-kv.test.ts` — the KV adapter; `oauth-rate-limit.test.ts` — the `oauth` rule.
- The P2-12 route guard lists the OAuth routes (`OAUTH_ROUTES` in `test/authz/matrix.ts`).
