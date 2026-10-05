# OAuth 2.1 authorization server (`packages/http-app/src/oauth`)

The OAuth server that lets MCP clients without static headers (claude.ai web, Claude mobile, Claude Desktop
connectors) reach `/p/{slug}/mcp`. Built on `@cloudflare/workers-oauth-provider` 1.2.1 (ADR-0009, spike P0-08), run
unmodified on Node and Workers, with its state in the storage `kv` table on both (ADR-0011).

Status: P5-01 (server and token check), P5-02 (per-slug Protected Resource Metadata, the `401` discovery
challenge, `resource` on token requests), P5-03 (client registration: CIMD and hardened DCR) and P5-04 (sign-in +
consent screen, remembered approvals, the `RB_OAUTH` host switch) and P5-05 (token lifecycle: lifetimes, refresh
rotation with reuse detection, access re-checked at issuance, revoke-all, OAuth devices in the admin API and UI). Not
yet: the admin client list and runtime DCR switch (P5-08). User guide: `docs/guide/oauth.md`.

## Topology

One origin. The **issuer** is the configured public URL (`identity.publicUrl`, `RB_PUBLIC_URL`), never the `Host`
header. Each project is one protected resource, `{issuer}/p/{slug}/mcp`, and a token is bound to exactly one of them
(RFC 8707).

| Route | Served by | Notes |
|---|---|---|
| `GET /.well-known/oauth-authorization-server` | provider | RFC 8414; `protected_resources` stripped (slugs are not public, T19) |
| `GET /oauth/authorize` | ours → provider → consent seam | see below |
| `POST /oauth/consent` | consent screen (P5-04) | the consent form; session + CSRF, then the request is validated again |
| `GET /oauth/approvals`, `POST /oauth/approvals/forget` | consent screen (P5-04) | remembered approvals of the signed-in user |
| `POST /oauth/token` | provider (after our code check) | code, refresh, RFC 7009 revocation |
| `POST /oauth/register` | ours → provider | RFC 7591 DCR, see [Client registration](#client-registration); `registration: false` turns it off |
| `GET /.well-known/oauth-protected-resource/p/{slug}/mcp` | ours | RFC 9728, see below |

The five protocol endpoints are unauthenticated; the consent routes take the admin session cookie only. All of them: `beforeAuth` runs with scope `oauth` (per-IP `oauth` rule, default 60 per 5 minutes, on
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
   - `approve({ userId, grantId, label? })` runs `resolveAccess` for this slug with that user as principal: another user's
     grant, a service grant, a grant of another project, a revoked/expired grant, a disabled user, an unknown project,
     an unusable credential and the owner-key boundary all refuse (`{ ok: false, reason }`) before any code exists. On
     success the provider mints the grant and code (props: `grantId`, `projectSlug`, `userId`, `clientId`; grant
     metadata `{ label?, grant }`: the device label when the user named it and the access grant id, P5-05, T25), we store the single-use marker and return the
     redirect. `client_refused`: a CIMD document that can no longer be fetched.
   - `deny()` is the `access_denied` redirect. `authRequest` and `helpers` expose the provider's own objects.
   - The default handler is the built-in consent screen below; `oauth.consent` replaces it (tests use a stand-in).

## Consent screen (P5-04)

`packages/http-app/src/oauth/consent.ts` (logic) and `packages/admin-ui/src/consent.tsx` (pages). Mounted with `oauth`
unless a custom `consent` is given; uses the admin UI's session wiring (`adminUiDeps`: session lookup with the failure
throttle, fetch metadata, CSRF).

**Flow.** Stateless between steps: the authorization request travels in URLs and is validated by the provider at every
step (`runtime.prepare(c, params)`), so what the page showed is what gets approved.

1. `GET /oauth/authorize?…` (validated) → fetch metadata: only same-origin requests and cross-site top-level document
   navigations (the client opening the page); frames, `fetch` and subresources are a `403` page.
2. No session → `303 /auth/login?next=/oauth/authorize?…` (the sign-in `next` cap is 2048 characters; a longer
   authorize URL is a `400` page). A broken session cookie is cleared and charged like on the admin pages.
3. Signed in and a **remembered approval** matches (same user, client id, redirect URI and resource; requested scopes a
   subset; `GET` only, never `HEAD`, not with `prompt=consent` or `prompt=login`) → `approve()` with the remembered grant → `303` to the client. If `approve()`
   refuses (grant revoked, key gone, document gone) the row is deleted, the refusal audited and the page shown.
4. Otherwise the **consent page** (`ConsentPage`), with the admin UI headers plus `form-action 'self' <redirect origin>`:
   browsers apply `form-action` to the redirect that answers the form post, so without it Chromium blocks the trip
   back to the client (found by the P5-04 browser test). An IPv6 loopback redirect (`http://[::1]:…`) can't be written
   as a CSP host source and gets the `http:` scheme source. `security.ts` keeps exactly these variants (`isUiCsp`).
5. `POST /oauth/consent?…` (the same query) → session (none: back to sign-in, nothing approved), `Origin` / fetch
   metadata (`checkFetchOrigin`), `application/x-www-form-urlencoded` ≤ 16 KiB, exactly one `_csrf` equal to the
   session's, then `prepare()` again (a tampered query is validated like a new request: unregistered redirect URI → 400,
   bad PKCE → error redirect). `decision=deny` → `api.deny()` (`access_denied` to the registered redirect URI with
   `state` and `iss`) and the remembered approval, if any, is deleted. `decision=approve` → the `grant` must be one of
   the user's own grants on the project that `resolveAccess` accepts **now** (others → `422` page, audited
   `grant_not_offered`, `approve()` never called), the optional device label must be plain text ≤ 60 characters, then
   `approve()` (which checks everything again) → `303` to the client. `remember=1` stores the approval.

**What the page shows (phishing review, T10).**

| Shown | Why |
|---|---|
| Client name as plain, escaped text ("An unnamed app" without one) | Registered names pass `safeClientName` (no control, bidi, zero-width or separator characters, ≤ 100) and Hono escapes them; never markup, never a link |
| CIMD: "identified by the website **`<host>`**" | The client id is an https URL on that host and its document was fetched from it; redirect URIs are held to that host (P5-03), so the host shown is also where codes go |
| DCR: **not verified** badge and "continue only if you started connecting this app yourself" | Anyone can register any name, including "Claude" |
| **Sends you back to `<redirect host>`** (monospace, as prominent as the name) | Where the code goes; a lookalike host is visible |
| Loopback warning for `localhost` / `127.0.0.0/8` / `[::1]` redirects | A code sent there reaches whatever program listens on this computer |
| Project (name and slug, the name only to users with access) and each offered grant's tools and accounts | The user sees exactly what the app will be able to read |
| No auto-approval of an unknown client | Only an explicit earlier approval with "don't ask again" ticked, for the same client id, redirect URI, resource and user |

Not shown: `logo_uri`, `client_uri`, `tos_uri`, `policy_uri` (unverified links and images a phisher would control).

**Remembered approvals.** `kv` rows `oauth-consent:<userId>:<base64url(sha256([clientId, redirectUri, resource]))>`, 30
days (`OAUTH_CONSENT_REMEMBER_TTL_S`), at most 50 per user (past that nothing more is remembered). The value holds the
grant id, scopes, label and display copies for the list page. `GET /oauth/approvals` lists the caller's rows (their
prefix only); `POST /oauth/approvals/forget` (`_csrf`, `id`) deletes one (`404` for an id that isn't theirs). Revoking
issued tokens per device is P5-05, which should also delete the device's remembered approval.

**Audit** (`admin` rows): `oauth.consent.approve` (`ok`, details `remembered: 'used' | 'saved' | false`; `denied` with
the resolver's reason or `grant_not_offered`), `oauth.consent.deny`, `oauth.consent.forget`. Target `oauth_client`
(client id, ≤ 200 characters); details: project, client kind and host, redirect host, scope. Never codes, tokens,
`state` or PKCE values.

**Host switch.** `oauthSettingsFromEnv` (`settings.ts`) reads `RB_OAUTH` (off by default; needs sign-in, else a boot
error), `RB_OAUTH_DCR`, `RB_OAUTH_DCR_LIMIT` (per hour or `off`), `RB_OAUTH_DCR_REDIRECT_HOSTS`. `serve` adds
`createCimdFetch()`; the Worker adds `strictlyPublicCimdFetch()` (null without the compatibility flag: CIMD off, a
warning at boot). A programmatic `createWorker({ oauth })` wins over the variables (tests).

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
- `grant_type=refresh_token`: single use, see [Token lifecycle](#token-lifecycle-p5-05).
- RFC 7009 revocation (`token`, no `grant_type`) is the provider's: the client authenticates as it does on token
  requests (public clients: `client_id`, which must exist, else `401 invalid_client`; confidential: its secret); the
  answer is an empty `200` for an unknown, malformed or other client's token (nothing revoked, nothing revealed); an
  access token is revoked alone, a refresh token revokes the whole device (provider grant). A successful revocation
  clears this process's access cache; other isolates follow within the cache TTL (≤ 60 s, T15).

## Token lifecycle (P5-05)

- **Lifetimes.** Access tokens: `accessTokenTtlSeconds` / `RB_OAUTH_ACCESS_TTL`, default 1 h on every plan (the
  "8 h on Free" preset of ADR-0009 was about the Workers KV write quota; the state is in D1 since ADR-0011). Refresh:
  `refreshTokenTtlSeconds` / `RB_OAUTH_REFRESH_TTL`, default 30 days, **absolute** — the provider sets the grant's
  `expiresAt` at the code exchange and refreshing never moves it (no idle TTL configured); an access token issued by a
  refresh is capped at the remaining refresh lifetime. Both are also capped at the access grant's own `expiresAt`.
- **Access re-checked at every issuance.** The provider's `tokenExchangeCallback` runs for the code exchange and every
  refresh with the decrypted props: they must match the token's user, client and resource, and `resolveAccess` must
  accept `{ grantId, userId }` for the slug. Otherwise it throws `invalid_grant`, on which the provider revokes the
  device's grant; audited `oauth.token.refused` (`errorCode` = the resolver's reason, `targetId` = `oauth_<grantId>`).
- **Refresh single use + reuse detection.** Every refresh token we hand out gets a marker
  `oauth-refresh:<sha256(token)>` = `live` (written after the provider answered the code exchange or refresh). A refresh
  request takes the marker with the atomic `kv.take` **before** the provider sees the token (after the `resource` and
  CIMD checks, so a request refused for those burns nothing):
  - `live` → the provider rotates; then the presented token's marker becomes `used` and the new token's `live`. If the
    provider refused without rotating (wrong client, scope or resource) the marker is `live` again; if it rotated or the
    grant is gone, `used`.
  - `used` (rotated earlier) or missing while the token is still the grant's current or previous refresh token (a
    concurrent request holds the marker) → first the **reuse interval** below (P5-09); if it does not apply →
    **reuse**: the device is revoked (every access and refresh token of the provider grant, RFC 9700 §4.14.2), audited
    `oauth.token.reuse` (`refresh_token_reuse`, `details.concurrent`, `details.replayRefused`), and the answer is
    `invalid_grant`. The provider's own "previous refresh token still works once" grace never applies.
  - missing and unknown to the grant (a forged secret with a known grant id) → `invalid_grant`, nothing revoked, no
    waiting.
  Of N concurrent refreshes with one token exactly one rotates. With the reuse interval every one of them gets that
  rotation's pair; in strict mode (`0`) the others are reuse and the device is revoked (both tested on memory, SQLite
  and D1).
- **Reuse interval (P5-09, ADR-0013).** `refreshReuseWindowSeconds` / `RB_OAUTH_REFRESH_REUSE_WINDOW`, default 30 s,
  0-120, `0`/`off` = strict. The SDK client does not coalesce refreshes (P5-06), so parallel requests over an expired
  token send the same refresh token several times. `refresh-replay.ts`:
  - After a successful rotation (before the marker becomes `used`) the token response is stored as
    `oauth-refresh-replay:<sha256(presented token)>` with the window as expiry: `v1.<iv>.<ciphertext>`, AES-256-GCM
    under HKDF-SHA-256(presented refresh token), AAD `relic-bridge:oauth-refresh-replay:v1:<user>:<grant>:<hash>`,
    together with the client id, the request's `resource` and `scope`, the rotation time and the successor's hash.
    Storing it is best effort (a failure is logged: the request then behaves as strict mode).
  - A refresh whose marker is `used` opens the sealed value and replays it (same body, `expires_in` reduced by the
    elapsed seconds; audited `oauth.token.replay`) only if: inside the window by the server clock; the same client id
    and the same client authentication (`none`, or the registered secret by its SHA-256 as the provider stores it, with
    the provider's basic/post leniency); the same `resource` slug and `scope` parameter; the grant exists, has no
    tombstone, and its **current** refresh token is still the successor (an older generation is reuse). Otherwise it
    is reuse with `details.replayRefused` = `outside_window`, `other_client`, `client_authentication`,
    `other_resource`, `other_scope`, `revoked`, `older_generation`, `unreadable` or `no_replay`.
  - A refresh that finds **no** marker while the grant names the token (current or previous) waits for the rotation
    in progress: it polls the replay row and the marker (pauses 20 ms … 250 ms, ≈ 3 s in all, real time); `used` → read
    the replay; `live` again (the rotation was refused without rotating) → `kv.take` it and rotate; time out →
    reuse (`rotation_timeout`). A token the grant never had does not wait.
  - Nothing new is minted for a replay: one rotation, one successor, never parallel families.
- **Tombstones.** Revoking a device (reuse, replayed code, admin) first writes `oauth-revoked:<userId>:<grantId>`. The
  provider reads a grant and writes it back during a code exchange or refresh, so a revocation landing in between could
  be undone; after any successful exchange or refresh the token endpoint looks for the tombstone and, if present,
  revokes again and answers `invalid_grant` instead of the tokens.
- **Devices.** A device is one provider grant (`oauth_<grantId>`, also the audit `tokenId`). Grant metadata holds the
  device label and the access grant id (`{ label?, grant }`, T25), so `runtime.devices` can list a user's devices
  (`grant:<userId>:` rows; pending code exchanges and expired grants left out; at most 100) and revoke one, or all of a
  user's devices for one access grant or project. Revoking also deletes the user's remembered approvals for that client
  and project (`forgetApprovals` in `remembered.ts`; approvals now store the `clientId`).
- **Revoke-all.** The admin API revokes the devices of a revoked or deleted grant, of a user it disables (re-enabling
  does not restore them) and, for every user with a grant on it, of a deleted project (`details.oauthDevicesRevoked` on
  the audit row). Best effort: a failure is logged and the next refresh is refused by the access check anyway.
- **Admin API.** `GET /me/oauth-devices`, `POST /me/oauth-devices/{id}/revoke` (any signed-in role, own devices only,
  not the admin token), `GET /users/{id}/oauth-devices`, `POST /users/{id}/oauth-devices/{deviceId}/revoke` (admins;
  an owner's devices only by owners). Audited `oauth_device.revoke`. Without OAuth the lists are empty and revokes 404.
  UI: "Apps connected with OAuth" on `/admin/me` (`POST /admin/me/apps/:id/revoke`) and on a user's page
  (`POST /admin/users/:id/apps/:device/revoke`), both behind a confirmation page.
- **When it takes effect.** Token issuance (code exchange, refresh) refuses a revoked device or unusable grant at once
  everywhere (storage is shared). An access token already issued is checked on every uncached MCP request (provider
  token row + `resolveAccess`): at once on the process that made the change (admin changes and RFC 7009 clear its access
  cache), within the access cache TTL (≤ 60 s) on other processes and isolates — the device-token guarantee (T15).

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
Key metadata is dropped. Remembered approvals (P5-04) are `oauth-consent:<userId>:<id>`; refresh markers (P5-05)
`oauth-refresh:<sha256(token)>` (`live` / `used`, for the refresh lifetime), sealed replays (P5-09)
`oauth-refresh-replay:<sha256(token)>` (for the reuse window only, never plain text) and device tombstones
`oauth-revoked:<userId>:<grantId>`. Props are encrypted by the provider with a key wrapped by the token itself; client
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
- (P5-04) `packages/http-app/test/authz/consent-suite.ts` — the consent screen through the app: sign-in redirect and
  `next`, bearer/admin/query credentials ignored, page content (escaped hostile name, unverified marking, redirect host,
  loopback warning, own grants only, CSP / XFO / no-store), fetch metadata, CIMD display, approve → token → MCP call,
  device label metadata, deny, tampered form targets, owner boundary and forged grants, no-access users, CSRF / origin
  defects, remembered approvals (used, HEAD, other user / resource / scope, forget, revoked grant), audit rows. On memory
  (`consent.test.ts`), SQLite (`apps/cli/test/consent-sqlite.test.ts`) and the Worker (D1). Pages: axe-core and escaping
  in `packages/admin-ui/test/consent.test.tsx`. Browser: `e2e/oauth.spec.ts` (Chromium, 1280 px and 320 px; fails on
  CSP violations, so a missing `form-action` source breaks it).
- (P5-05) `packages/http-app/test/authz/oauth-lifecycle-suite.ts` — default and absolute lifetimes, grant-expiry cap,
  rotation and reuse (family revoked, audited), refused refresh doesn't burn the token, 6 concurrent refreshes, forged
  refresh token, refusal at issuance (revoked grant, disabled user and project, revoked grant before the code exchange),
  RFC 7009 per client, the device API (own list and revoke, remembered approval forgotten, other members, CSRF, admin
  token on `/me`, admin vs owner devices) and revoke-all through the admin API. On memory (`oauth-lifecycle.test.ts`),
  SQLite (`apps/cli/test/oauth-lifecycle-sqlite.test.ts`) and the Worker (D1). UI: `ui-oauth-devices.test.ts`.
  (P5-09) The reuse interval in the same suite: 12 concurrent refreshes → one rotation and one pair for all, retry
  inside the window (same pair, shorter `expires_in`, no plain text in `kv`), outside the window, older generation,
  other client, other resource, revoked device, forged token (no wait); strict mode keeps the P5-05 race test.
  `packages/http-app/test/oauth-refresh-replay.test.ts` — sealing (wrong token/AAD, tampering) and client
  authentication.
- (P5-06) `packages/http-app/test/authz/client-conformance-suite.ts` — the official MCP SDK client (OAuth, discovery,
  Streamable HTTP) shaped like claude.ai / mobile / Desktop (CIMD, https callback), Claude Code (CIMD, loopback) and
  Cursor / VS Code / Inspector (DCR): discovery order, registration, PKCE, `resource` on every token request, `iss`,
  tool call, automatic refresh and rotation, parallel refresh (the reuse interval keeps the device; strict mode revokes
  it, P5-09),
  RFC 7009, behaviour after revocation, audience binding, scope tolerance. On memory (`client-conformance.test.ts`),
  SQLite (`apps/cli/test/client-conformance-sqlite.test.ts`) and the Worker (D1). Results: `docs/reference/client-compatibility.md`.
- `packages/http-app/test/oauth-kv.test.ts` — the KV adapter; `oauth-rate-limit.test.ts` — the `oauth` rule.
- The P2-12 route guard lists the OAuth routes (`OAUTH_ROUTES` and, P5-04, `CONSENT_ROUTES` in `test/authz/matrix.ts`).
