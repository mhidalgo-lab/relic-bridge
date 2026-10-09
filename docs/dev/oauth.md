# OAuth 2.1 authorization server (`packages/http-app/src/oauth`)

The OAuth server that lets MCP clients without static headers (claude.ai web, Claude mobile, Claude Desktop
connectors) reach `/p/{slug}/mcp`. Built on `@cloudflare/workers-oauth-provider` 1.2.1 (ADR-0009, spike P0-08), run
unmodified on Node and Workers, with its state in the storage `kv` table on both (ADR-0011).

Status: P5-01 (server and token check), P5-02 (per-slug Protected Resource Metadata, the `401` discovery
challenge, `resource` on token requests) and P5-03 (client registration: CIMD and hardened DCR). Not yet: sign-in +
consent screen and the host switch (P5-04), plan TTL presets and refresh reuse detection (P5-05), the admin client list
and DCR switch (P5-08). Until P5-04 the server is a constructor option only
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
| `POST /oauth/register` | ours → provider | RFC 7591 DCR, see [Client registration](#client-registration); `registration: false` turns it off |
| `GET /.well-known/oauth-protected-resource/p/{slug}/mcp` | ours | RFC 9728, see below |

All five are unauthenticated: `beforeAuth` runs with scope `oauth` (per-IP `oauth` rule, default 60 per 5 minutes, on
top of the per-IP flood limit), declared bodies above 16 KiB are a 413 and streamed bodies are cut at 16 KiB. On
Workers the `oauth:` buckets are per isolate; the shared Rate Limiting binding still counts every request under `ip:`
(600/min). Registrations also count against one deployment-wide cap kept in storage (P5-03).

## Discovery (MCP 2026-07-28, RFC 9728)

A client that only knows `https://bridge.example.com/p/{slug}/mcp` finds everything from there:

1. Its first request without a token gets the MCP route's `401`, with OAuth on:
   `WWW-Authenticate: Bearer realm="relic-bridge", resource_metadata="{issuer}/.well-known/oauth-protected-resource/p/{slug}/mcp", scope="mcp:read"`.
2. That URL (RFC 9728 path insertion, also the first URI the spec tells clients to try without a header) returns
   `{"resource": "{issuer}/p/{slug}/mcp", "authorization_servers": ["{issuer}"], "scopes_supported": ["mcp:read"],
   "bearer_methods_supported": ["header"]}`.
3. `{issuer}/.well-known/oauth-authorization-server` (RFC 8414) gives the endpoints, `S256`,
   `authorization_response_iss_parameter_supported: true`, `none` among the token endpoint auth methods and, when the
   host gave a CIMD fetcher, `client_id_metadata_document_supported: true` (Claude picks CIMD then). No OpenID Connect discovery document: clients try RFC 8414
   first.

Both the metadata and the challenge are **built from the request path only**:

- The project is never looked up. Known, unknown and disabled projects get the same metadata (with their own slug), and
  every denial on one URL — no token, a bad or revoked device token, an OAuth token for another slug, a disabled
  project — is the same byte-identical `401`. Two URLs' answers differ only in the slug the caller sent (T19).
- No `error="invalid_token"` (RFC 6750 §3.1): it would tell a missing token from a refused one. No `resource_name`
  (project names are not public). No `offline_access` in `scopes_supported` (spec: refresh tokens are not a resource
  requirement; it stays in the AS metadata).
- A slug that is not valid (`SLUG_RE`) has no metadata (404) and keeps the plain `Bearer realm="relic-bridge"`
  challenge; so does every server without OAuth. There is no root `/.well-known/oauth-protected-resource`: no MCP
  endpoint lives at the root.
- URLs use the issuer (`RB_PUBLIC_URL`), never the `Host` header. A client that reaches the server under another name
  (a `*.workers.dev` URL while `RB_PUBLIC_URL` is the custom domain) gets metadata whose `resource` does not match the
  URL it used, and RFC 9728 §3.3 tells it to stop: configure clients with the public URL.

## Client registration

Two ways for a client to get a `client_id`, both without an operator (P5-03, ADR-0012). Policy code:
`packages/http-app/src/oauth/clients.ts`.

### Client ID Metadata Documents (CIMD, preferred)

The `client_id` is an https URL serving a JSON document (draft-ietf-oauth-client-id-metadata-document, MCP 2026-07-28).
The provider's own CIMD is off; relic-bridge resolves the URL before the provider sees the request, at
`/oauth/authorize`, at `/oauth/token` (code, refresh, revocation) and again in `approve()`, and stores the validated
document as the provider's client record `oauth:client:<url>`.

- **On only with a guarded fetcher** — `oauth.clientMetadataDocuments.fetch`. Node: `createCimdFetch()`
  (`apps/cli/src/cimd-fetch.ts`, connect-time address check). Workers: `strictlyPublicCimdFetch()`
  (`apps/worker/src/cimd-fetch.ts`, needs the `global_fetch_strictly_public` flag in `wrangler.jsonc`, null without it).
  Hosts wire it with the `RB_OAUTH` switch (P5-04). Without a fetcher every https `client_id` is refused (400).
- **Before any fetch** the URL must be canonical (`new URL(id).href === id`: no dot segments, no uppercase host, no
  `:443`), https, with a path, no userinfo or fragment, port 443, a DNS name with a dot that is not internal
  (`localhost`, `.local`, `.internal`, `.arpa`, `.test`, …, no IP literal), not the issuer's own host, ≤ 512 characters.
- **Fetch**: GET, `Accept: application/json`, no redirects (any 3xx refuses), 5 s for the whole exchange, 200 only,
  `application/json` or `application/*+json`, ≤ 5 KiB declared or streamed, strict UTF-8 JSON.
- **Document**: an object whose `client_id` equals the URL exactly; `client_name` required (≤ 100 characters, no
  control, bidi, zero-width or separator characters); no `client_secret` / `client_secret_expires_at`;
  `token_endpoint_auth_method` absent or `none` (public clients; `private_key_jwt` is not supported); `grant_types`
  must include `authorization_code` (unknown ones dropped), `response_types` must include `code`; 1–10 `redirect_uris`.
- **Redirect URIs held to the document**: any with a fragment, `*`, userinfo, whitespace or an https IP literal
  (other than loopback) refuses the document; of the rest only `https` on the client id's own host and `http` on
  loopback (`localhost`, `127.0.0.0/8`, `[::1]`, any port per RFC 8252) are kept. None left → refused. The provider then
  matches the request's `redirect_uri` exactly against the kept list.
- **Cache**: the record lives for the document's `Cache-Control` lifetime (`s-maxage` / `max-age`) clamped to
  5 min – 24 h; 1 h without the header; 5 min for `no-store` / `no-cache` / `private` (it must survive one authorization).
  Errors are never cached. A changed document takes effect when the record expires.
- **Failures** (refused id, fetch error, invalid document) are a `400 invalid_client` JSON page, never a redirect and
  never a 500. The stable reason (`client_id_ip_literal`, `redirect`, `too_large`, `client_id_mismatch`,
  `no_usable_redirect_uri`, `cimd_disabled`, …) and the client id's host go to the log (`oauth client refused`).
- The consent seam sees `clientKind: 'metadata_document'` and `clientHost` (the client id's host, which the draft and
  the MCP spec say to display).

### Dynamic Client Registration (RFC 7591, compatibility)

On by default (`oauth.registration`, `false` turns it off). `POST /oauth/register` with `application/json`:

1. **Policy before anything is stored**: 1–10 `redirect_uris`, each ≤ 2,000 characters with no fragment, `*`, userinfo
   or whitespace; `https` on a DNS name (or a loopback IP) or `http` on loopback; private-use schemes
   (`cursor://…`) may be listed next to a usable one (the provider never sends codes to them); `client_name` under
   the CIMD rules. `oauth.registrationRedirectHosts` (optional) restricts https redirect hosts to a list (loopback
   always allowed). Refusals: `400 invalid_redirect_uri` / `invalid_client_metadata`, reason in the log.
2. **Deployment-wide cap**: an atomic fixed-window counter in storage (`kv.increment`, key
   `oauth-dcr-count:<window>`), shared by every isolate and process. Default 30 registrations per hour
   (`oauth.registrationLimit`, `null` = off); over it `429 temporarily_unavailable` with `Retry-After` to the end of
   the window. Every request that passed the policy counts.
3. The provider stores the client (`client_id`: 16 random characters, never a URL).
4. **Unused registrations die young**: the record is rewritten to expire in 24 h. The first successful token exchange
   renews it (the provider renews at half-life) to the registration TTL, `max(90 days, 2 × refresh TTL)`, so a client
   that keeps refreshing never loses its registration and a flood of registrations nobody completes is gone in a day.

The consent seam sees `clientKind: 'dynamic'`, `clientHost: null`: nothing about a dynamic client is verified (P5-04
must say so). Listing and removing clients is P5-08.

## Authorization endpoint

1. Repeated parameters → 400 (RFC 6749 §3.1).
2. `resource`: exactly one, and exactly `{issuer}/p/{slug}/mcp` with a valid slug, else 400 `invalid_target` — before
   the client is known, so never a redirect. Scheme and host compare case-insensitively (the MCP spec's "SHOULD accept
   uppercase"); the path is exact (`/P/x/mcp`, `/p/X/mcp` are refused). The project is **not** looked up here (no slug probing before sign-in).
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
- `grant_type=authorization_code` and `refresh_token`: exactly one `resource`, one of ours (same rule as the
  authorization endpoint), else 400 `invalid_target` (RFC 8707; MCP 2026-07-28 "MUST be included in both
  authorization requests and token requests"). Checked before the code marker is consumed, so a client that left it
  out can retry with the same code. The provider then requires it to be the grant's own resource (`invalid_target`
  otherwise — a code for slug A exchanged for slug B, after the marker was consumed, burns the code).
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

Every refusal is the same generic 401 (T19), with the discovery challenge above. Deny reasons for logs and audit: `oauth_invalid` (unknown, expired,
revoked or other-audience token), `oauth_mismatch` (props don't match), then the resolver's reasons. Audit rows carry
the OAuth `client_id`; `token_id` is `oauth_<provider grant id>` — stable per device authorization across refreshes,
so per-token rate limits and the audit follow the device.

## Storage

Provider keys are `kv` rows under `oauth:` (`client:…`, `grant:{userId}:{grantId}`, `token:…`), see
`kv-namespace.ts`; expiry is the provider's (`expiration` / `expirationTtl`) and the hourly purge reclaims expired rows.
Key metadata is dropped. Props are encrypted by the provider with a key wrapped by the token itself; client
registrations, grant scopes and user ids are not encrypted (T25: user ids are our opaque `usr_…` ids, never emails).
Client records are `oauth:client:<id>`: a random id for DCR clients, the document URL for CIMD clients (cached copies
with an expiry). Outside the provider's namespace: `oauth-code:<sha256(code)>` (single-use markers) and
`oauth-dcr-count:<window>` (the registration cap counter, `kv.increment`).

## Runtimes

- **Workers:** `cloudflare:workers` is real. `wrangler.jsonc` sets `global_fetch_strictly_public` (P5-03): the CIMD
  fetcher relies on it, and it applies to every outbound fetch (all of which go to public hosts).
- **Node:** the provider imports `WorkerEntrypoint` only for `instanceof` checks; the CLI bundle (`apps/cli/tsdown.config.ts`)
  and the Node test projects alias `cloudflare:workers` to `src/oauth/cloudflare-workers-shim.ts`, and the test
  projects inline the package (`server.deps.inline`) so the alias applies. The CLI bundle stays one file
  (`inlineDynamicImports`).
- The provider module is loaded lazily (dynamic `import()`) on the first OAuth request: it prints a CIMD warning at
  import when the Workers flag is absent (always on Node; harmless, its CIMD is off) and costs nothing for stdio or
  token-only servers.

## Tests

- `packages/http-app/test/authz/oauth-suite.ts` — the integration suite (ported from `spikes/oauth/scripts/e2e.ts`):
  metadata, DCR → PKCE → code → token → tool call, cross-slug 401, refresh can't retarget, revocation, expiry, code
  replay and concurrent redemption, PKCE plain/missing, resource checks, redirect URI checks, approval re-checks,
  per-request resolver checks (owner key, disabled user, revoked grant), off-switch, body limits; and (P5-02) PRM for
  known / unknown / disabled / invalid slugs, the challenge on every MCP method and denial kind, `resource` on token
  requests (missing, foreign, repeated, other slug; the code survives a missing one), case-folded scheme and host,
  cross-slug reuse with a grant on both projects, a disabled project, an OAuth token on every admin route and the UI.
  Runs on the HTTP app with memory storage (`oauth.test.ts`, http-app project), on SQLite (`apps/cli/test/oauth-sqlite.test.ts`)
  and on the Worker with local D1 (`pnpm test:workers`, via the authz host swap).
- (P5-03) CIMD with mocked documents shaped like Claude Code's and claude.ai's (authorize → token → MCP, loopback on
  any port, cache and re-fetch on refresh), malicious documents and refused client ids (nothing fetched), CIMD off,
  claude.ai's DCR request, DCR redirect policy and host allow-list, the shared cap across two app instances, unused
  registration expiry and renewal.
- `packages/http-app/test/oauth-clients.test.ts` — address classification, client id / redirect URI / document checks,
  fetch bounds; `apps/cli/test/cimd-fetch.test.ts` — the Node guard (injected DNS, a local server, no network);
  `apps/worker/test/cimd-fetch.test.ts` — the flag and `redirect: 'manual'`.
- `packages/http-app/test/oauth-kv.test.ts` — the KV adapter; `oauth-rate-limit.test.ts` — the `oauth` rule.
- The P2-12 route guard lists the OAuth routes (`OAUTH_ROUTES` in `test/authz/matrix.ts`).
