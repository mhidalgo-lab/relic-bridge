# Research notes

Facts verified while planning (2026-10-01). Each one affects a design decision. The P0 spikes
must re-check every item marked **verify** against the real platforms before Phase 1 depends on it.

## 1. Cloudflare Workers platform limits

Sources: <https://developers.cloudflare.com/workers/platform/limits/>,
<https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/>,
<https://developers.cloudflare.com/workers/platform/pricing/> (checked 2026-10-03, P3-03).

| Limit | Free | Paid | Impact on relic-bridge |
|---|---|---|---|
| Requests / day | 100,000 | unlimited | Far above personal or small-team MCP usage. |
| CPU time / request | **10 ms** | 30 s default, 5 min max | **Main risk.** Network waits do *not* count, but JSON parsing of large NRQL results, crypto, and output shaping do. |
| Subrequests / request | **50 external** + 1,000 to Cloudflare services | 10,000 (configurable up to 10 M via `limits.subrequests`) | **Changed 2026-02-11:** on Free, `fetch` to the Internet (every NerdGraph call and async poll) counts against the 50; D1, KV and other Cloudflare services count against a separate 1,000. Each redirect hop counts. **Conflicting sources (checked 2026-10-05):** the [Workers limits page](https://developers.cloudflare.com/workers/platform/limits/#subrequests) lists 1,000 "subrequests to internal services" on Free, but the [D1 limits page](https://developers.cloudflare.com/d1/platform/limits/) (updated 2026-04-21) still says "Queries per Worker invocation: 50 (Free) / 1,000 (Paid)". Until a measurement on a real Free Worker settles it, **relic-bridge budgets D1 against the stricter 50 per invocation** (rotation `batchSize` clamp, purge batches, constant-cost session revocation); the 1,000 only means a miscount can't break NerdGraph calls. The old assumption "D1 lookups eat the 50" no longer holds for NerdGraph, so the access-resolve cost (one D1 batch call + a throttled write on a miss since P3-09) does not touch the NerdGraph budget. |
| D1 rows (Free) | 5 M read / 100 k written per day | 25 B / 50 M per month included | Enforced since 2026-09-01: queries fail with a "free tier daily row read/write limit" error until 00:00 UTC. Matters for audit writes and cache misses on a busy Free deployment. |
| Concurrent connections waiting for headers | 6 | 6 | Parallel NerdGraph fan-out from one invocation is capped at 6. |
| Wall-clock duration (HTTP) | no limit while the client is connected | same | Async NRQL polling is fine while the MCP client keeps the connection open. |
| Memory | 128 MB | 128 MB | Cap result sizes; never buffer unbounded responses. |

**Conclusions**

- The free plan works for personal use **if** the code stays CPU-frugal:
  - tokens are high-entropy random values, so they're hashed with a single SHA-256; never PBKDF2 or bcrypt on the hot path
  - AES-GCM uses a raw imported key
  - response bytes are capped before parsing
- Every request carries a **NerdGraph call budget** (`RB_PLAN=free` = 45, `paid` = 1000; overridable with `RB_CALL_BUDGET`).
  It counts external `fetch` calls only (see the table), and Free keeps 5 below the platform's 50 for redirects. Tools
  declare their expected cost; tools that cost more than the budget are not offered (and `whoami` says why), and combined
  report tools degrade gracefully (partial report plus a note) instead of failing.
- Auth and config lookups are cached in isolate memory with a short TTL (≤ 60 s) to save subrequests.
  This bounds how long a revocation takes to apply (documented trade-off; the TTL is configurable, and 0 disables the cache).
- Docs will recommend Workers Paid for heavy use or shared teams. Spike **P0-06** measures real CPU numbers.

### Measured (spike P0-06, local)

See ADR-0010 for the local and **production** CPU tables and presets. Production p50: 2.8 ms (10 KB), 3.7 ms (100 KB),
10.2 ms (1 MB), 45.8 ms (5 MB). Cold first call: 17–35 ms. **Workers Free plan (confirmed):** no request was killed even at
61 ms CPU, so Free tolerated overruns here. The 512 KiB cap stays as the safe design point. Per-request CPU is visible in
Workers Logs (`$workers.cpuTimeMs`).
Per-request CPU comes from the dashboard or GraphQL Analytics (`workersInvocationsAdaptive`). `wrangler tail` only
reports `outcome: "exceededCpu"`.

## 2. NerdGraph limits

Sources: <https://docs.newrelic.com/docs/apis/nerdgraph/nerdgraph-usage-limits/>,
<https://docs.newrelic.com/docs/nrql/using-nrql/rate-limits-nrql-queries/>,
<https://docs.newrelic.com/docs/apis/nerdgraph/examples/async-queries-nrql-tutorial/>

| Limit | Value | Impact |
|---|---|---|
| Concurrent requests | **25 per New Relic *user*** (not per key); more may be allowed but only 25 are guaranteed | Several keys of the same NR user share the budget. Several devices of one person: fine. A team sharing **one** key: everyone shares 25. |
| Request rate | not limited (only concurrency) | — |
| Over-limit response | HTTP **429**; succeeds again once in-flight requests finish | Retry with exponential backoff plus jitter. |
| NRQL queries | 3,000 per account per minute | Per-grant rate limits keep one runaway agent from using up the account. |
| Recommended concurrent NRQL | ≤ 5 long-running/complex queries | Default concurrency cap of 5 NRQL per credential. |
| NRQL duration | 1 min (Original Data) / 10 min (Data Plus) | Long queries must use `async: true` + `queryProgress` polling. |
| NerdGraph default timeout | 5 s (configurable via `timeout`) | Always pass an explicit timeout. |

### Measured (spike P0-09, 2026-10-02, maintainer's US accounts; see `spikes/nerdgraph/RESULTS.md` §B)

- Light queries take ~230–470 ms. Selecting every NRQL result field (`eventDefinitions`, `suggestedQueries`, chart URLs) pushed
  it to ~3.6 s, so **select only the needed fields**.
- A burst of 30 parallel light queries all returned 200 in 0.3–1.7 s (queued, no 429). The 429 body is still unobserved.
- Cost signals live in `rawResponse.performanceStats { inspectedCount matchCount omittedCount wallClockTime }` and
  `rawResponse.queryUsage { billableMetric scannedEvents ccu }`. Surface them in tool `meta`.
  `rawResponse` is a JSON scalar that **repeats the whole result** (facets, totals), so selecting it roughly doubles the
  payload. P1-03 selects it only on request (`stats: true`, via `@include(if: $stats)`).
- **NRQL parsing, measured** (`spikes/nerdgraph/nrql-safety.ts`, 2026-10-03, US account):
  - **Escaping:** `\'` and `\\` are escapes in NRQL string literals. `\'` can't end a literal, and relic-bridge's
    escaping round-trips quotes, backslashes, `"`, `--`, `//` and `/*`. `''`, double-quoted strings and raw newlines in
    literals are syntax errors.
  - **Comments:** `//`, `--` and `/* */` are comments, and `count(*)--1` is `count(*)` plus a comment. So `//` can hide
    a clause, which is why relic-bridge strips comments before sending.
  - **Time:** bare epochs are read as seconds or milliseconds. Zone-less quoted dates are UTC, and `WITH TIMEZONE`
    shifts them (Tokyo: −9 h). `1 month` = 30 days. `SINCE last month` runs until now. Repeated SINCE, UNTIL and LIMIT
    are syntax errors, and so are `1e3` and `5e0`.
  - **LIMIT:** a raw query without LIMIT returns **10** rows by default, not 100. OFFSET works before or after LIMIT.
  - **Event types:** names are case-sensitive, and a backtick name with a trailing space is a different, empty type.
- Schema (P0-09 introspection): `Actor.nrql(accounts, async, …)` accepts `async`, but progress can only be polled with
  `Account.nrqlQueryProgress(queryId)`. There's no actor-level poll, so **cross-account queries run sync only** in P1-03.
- Optional fields fail **independently** (GraphQL partial errors alongside `data`). The client must accept `data` + `errors`
  and map field-level errors.
- Wrong region: **HTTP 403** `not authorized for account region`. Invalid, ingest-style and empty keys: **HTTP 401**
  `authentication required` (indistinguishable, so check the `NRAK-` prefix client-side). Bad NRQL: 200 + `INVALID_INPUT`
  (`NRDB:1102004`). Unauthorized account: 200 + `ACCESS_DENIED`. An unknown event type is not an error: rely on
  `metadata.messages` ("No events found …").

**Conclusions**

- **Recommended team pattern: each member connects their *own* NR key** (a credential bound to their grant).
  This keeps New Relic's own RBAC, gives each person their own 25-concurrency budget, and makes NR-side
  audit logs match the real person. One shared key per project remains supported for personal use.
- Concurrency control has layers:
  1. per-invocation cap (≤ 5, and ≤ 6 because of Workers)
  2. 429 backoff
  3. an optional Durable Object semaphore per credential (Phase 7) for shared keys on Workers
- Async NRQL follows the stateless "explicit handle" pattern of the 2026-07-28 MCP spec. If a query isn't done
  within the tool's poll budget, the tool returns a `queryId` and the agent calls `get_query_result` later.

## 3. MCP client authentication: the phone requirement

Sources: <https://claude.com/docs/connectors/building/authentication>,
<https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp>,
<https://github.com/anthropics/claude-ai-mcp/issues/112>

- claude.ai (web), Claude Desktop connectors and **Claude mobile** share one connector system. It supports
  **OAuth 2.0 with DCR** and **OAuth 2.0 with Client ID Metadata Documents (CIMD)**. Static request headers are
  only in beta for some organisations.
- Claude Code (CLI) supports `--header "Authorization: Bearer …"` and OAuth.
- Cloudflare `global_fetch_strictly_public` (compatibility flag): the global `fetch` routes "as if made on the public
  Internet": requests to the Worker's own zone go through Cloudflare's front door (security settings, Workers routes)
  instead of straight to the zone's origin server. A Worker's `fetch` has no route into private networks (no
  VPC/Tunnel binding is configured) and a Worker cannot resolve DNS itself, so on Workers the CIMD SSRF guard is this
  flag + the platform's egress + our client-id checks (no IP literals, internal names or ports) + no redirects (P5-03).
  The docs say nothing explicit about hostnames that resolve to private addresses; not verified on a deployment.
  Source: <https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public>.
- **Conclusion: static bearer tokens cover the MacBook, PC and W365 machine (Claude Code / IDEs) from
  Phase 2. The phone needs OAuth 2.1 (Phase 5).** Both DCR (still used by many clients) and CIMD (the
  spec's preferred method) must be supported.

## 4. MCP spec 2026-07-28 and TypeScript SDK v2

- Observed (P0-07, deployed): Claude Code 2.1.287 speaks 2026-07-28, sends `mcp-method` / `mcp-name` headers, and opens a
  long-lived `subscriptions/listen` POST. GitHub Copilot Desktop also connected (bearer and OAuth). claude.ai / Claude mobile
  custom connectors weren't available on the maintainer's account, so those clients are untested (P5-06).

Sources: <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery>,
<https://workos.com/blog/mcp-2026-spec-agent-authentication>, <https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions>

- Protocol-level sessions are removed: no `initialize` handshake and no `Mcp-Session-Id`, and `server/discover` replaces
  up-front negotiation. Version and capabilities travel in `_meta` on every request. This fits Workers well:
  no Durable Objects or sticky sessions needed.
- New `Mcp-Method` / `Mcp-Name` headers allow routing and rate limiting by header.
- Auth: the server is an OAuth 2.1 resource server and MUST publish Protected Resource Metadata (RFC 9728). Clients
  send Resource Indicators (RFC 8707), and the server MUST reject tokens not issued for itself. CIMD is preferred and
  DCR is deprecated but kept for compatibility. Clients validate the issuer (RFC 9207).
- **Read in the 2026-07-28 authorization pages (P5-02, 2026-10-05):** servers MUST implement RFC 9728 and either the
  `resource_metadata` parameter on `401` or a well-known URI; clients use the header when present, else try
  `/.well-known/oauth-protected-resource/{path}` (path insertion) then the root. PRM MUST list at least one
  `authorization_servers`. Servers SHOULD send `scope` in the challenge and SHOULD NOT put `offline_access` in the
  challenge or PRM `scopes_supported`. Clients MUST send `resource` (canonical server URI) in authorization **and**
  token requests; servers SHOULD accept uppercase scheme/host. AS metadata via RFC 8414 or OIDC discovery (clients
  must try both, RFC 8414 first). `403 insufficient_scope` with `scope` + `resource_metadata` for step-up.
  Sources: <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>,
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery>.
- **Read in the 2026-07-28 client registration and security pages (P5-03, 2026-10-05):** clients use pre-registration,
  then CIMD when the AS metadata has `client_id_metadata_document_supported`, then DCR (`registration_endpoint`),
  then ask the user. CIMD documents MUST contain `client_id`, `client_name`, `redirect_uris`; the AS MUST check
  `client_id` equals the URL exactly, MUST validate redirect URIs against the document, SHOULD cache respecting HTTP
  cache headers, SHOULD consider SSRF; SHOULD warn for localhost-only redirect URIs and MUST display the redirect URI
  host. DCR is deprecated (kept for compatibility); clients MUST send `application_type` (`native` for loopback). Draft
  (`draft-ietf-oauth-client-id-metadata-document-00`): client id URL https with a path, no dot segments, fragment or
  userinfo (ports allowed, query discouraged); no `client_secret*` and no shared-secret auth methods; recommended max
  5 KB; MUST NOT cache errors or invalid documents; the AS MAY bound cache lifetimes, MAY restrict redirect URIs relative
  to the client id, SHOULD avoid private/loopback addresses, SHOULD show the client id host.
  Sources: <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration>,
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations>,
  <https://www.ietf.org/archive/id/draft-ietf-oauth-client-id-metadata-document-00.html>.
- Extensions framework: **MCP Apps** (interactive HTML UIs) and **Tasks** (long-running operations) ship as
  extensions. Logging and sampling were removed from core.
- Tool input schemas support full JSON Schema 2020-12.
- **SDK v2** (`@modelcontextprotocol/server`, 2.1.x) supports both protocol eras:
  - `createMcpHandler(factory, { legacy: 'stateless' })` builds a fresh server per request and serves both 2025-era
    and 2026-07-28 clients over Streamable HTTP
  - `serveStdio(() => buildServer())` does the same over stdio
  - 2026-07-28 output is opt-in, so dual-era serving must be configured explicitly
- **Verified (P0-07, local):** SDK 2.2.0's handler runs unchanged under Hono on Node and workerd, plus stdio, for both eras
  (see ADR-0005). Real clients (Claude Desktop, claude.ai, mobile, Cursor, VS Code) are still pending deployment approval (P5-06).
- **SDK 2.2.0 details used by P2-06** (read from the package source, 2026-10-03):
  - `createMcpHandler` serves `subscriptions/listen` itself: it acknowledges with the *honoured* subset of the requested
    filter, where `toolsListChanged` is honoured only if the server advertises `tools.listChanged: true`. With nothing
    honoured, it writes the ack plus the empty (graceful) listen result and closes the stream at once. `McpServer`
    advertises `listChanged: true` by default unless the constructor's `capabilities` already set it.
  - Modern-era requests must carry `Mcp-Method` (and `Mcp-Name` for named methods) matching the body, or the handler
    rejects them, so these headers are trustworthy for routing and rate-limit keys once the handler accepts the request.
    **Not for legacy (2025-era) requests** (verified in P2-12 from the 2.2.0 source and a probe): the classifier
    cross-checks the headers only for modern requests and notifications, so a legacy `tools/call` can carry any
    `Mcp-Method` / `Mcp-Name` values. Anything that keys on them (rate limiting, audit) must read the body instead.
  - The 2025-era stateless path still accepts **JSON-RPC batches** (an array body; batching was removed from MCP in
    2025-06-18) and runs every call in it within one HTTP request (P2-12 probe: three `tools/call` in one POST, three
    NerdGraph calls). relic-bridge refuses batches before the handler.
  - 2025-era (stateless) `tools/call` answers with an SSE response whose headers arrive before the tool finishes; a
    request deadline must bound the body, not only the time to headers.
  - `maxRequestBodySize` (default 4 MiB) bounds bodies read by the handler, checking `Content-Length` first;
    `validateHostHeader` / `validateOriginHeader` are port-agnostic hostname allowlists (missing `Origin` passes, `null`
    is refused).
  - `@hono/node-server` 2.1.3 builds the request URL from the `Host` header; a `Request` built in-process carries no
    `Host` header (it is a forbidden header for `fetch`), so the app falls back to the URL's host.

## 5. Cloudflare OAuth tooling

Sources: <https://github.com/cloudflare/workers-oauth-provider>, issues #264, #333, #355

- `@cloudflare/workers-oauth-provider` implements the authorization-server side: client registration (DCR), token
  issuance and validation, and wrapping API handlers. Tokens and grants are stored in KV.
- CIMD is supported for public clients (`token_endpoint_auth_method: "none"`); `private_key_jwt` is not yet.
- **Verified (P0-08, local):** v1.2.1 natively supports per-path PRM, `resource_metadata` hints, single-audience tokens,
  DCR, CIMD, PKCE S256, `iss`, refresh rotation and revocation, and runs on Node unmodified with a SQLite KV adapter. See ADR-0009.
  Claude hosted apps redirect to `https://claude.ai/api/mcp/auth_callback`; Claude Code uses loopback redirects. Claude
  picks CIMD when metadata advertises it with `none` auth. Real-client run pending (`spikes/oauth/deploy-and-test.md`).
- **Read in the 1.2.1 source (P5-01, 2026-10-05):**
  - The code exchange is read-check-write on the grant record (`authCodeWrappedKey` deleted after use), not atomic: two
    concurrent redemptions can both pass on a store without atomic take (Workers KV). relic-bridge adds a single-use
    marker consumed with `kv.take` (ADR-0011).
  - A replay detected by the provider (`authCodeWrappedKey` gone) revokes the grant; `authCodeId` (SHA-256 of the code)
    stays on the grant after the exchange.
  - Access tokens, refresh tokens and codes are all `userId:grantId:secret` (grant id 16, secret 32 characters of
    `[A-Za-z0-9_-]`); validation is one KV read of `token:{userId}:{grantId}:{sha256(token)}` plus an `expiresAt` check
    against `Date.now()`. `audienceMatches` allows path-prefix matches; `validateToken(resource, …)` itself requires the
    exact registered resource.
  - Authorization-server metadata includes `protected_resources` (every declared resource) when resources are
    declared: relic-bridge strips it (project slugs are not public, T19).
  - The token endpoint accepts only `application/x-www-form-urlencoded` (media type compared after `split(';')`).
  - PKCE: the provider requires it only for public clients (`token_endpoint_auth_method: none`) and accepts
    `S256` only (`code_challenge_methods_supported: ["S256"]`); relic-bridge requires S256 for every client.
  - The module prints a `console.warn` at import time when `global_fetch_strictly_public` is off (CIMD disabled), so it
    is imported lazily. `parseAuthRequest()` checks the request URL against the issuer's authorize endpoint, so the
    request is re-addressed to the issuer origin first (works behind a TLS-terminating proxy).
  - `completeAuthorization()` revokes the user's earlier grants for the same client and resource by default.
  - Token endpoint `resource` is optional in the provider: omitted → the grant's resource; given → it must match the
    grant's (`invalid_target`). The provider folds scheme/host case when matching resources and returns the configured
    (canonical) resource from `parseAuthRequest`. relic-bridge requires `resource` on code and refresh grants (P5-02).
  - (P5-03) CIMD in the provider: enabled only with `Cloudflare.compatibilityFlags.global_fetch_strictly_public`;
    fetches with the global `fetch` without `redirect` (redirects followed), 10 s, 5 KiB, caches in the Cache API
    (`caches`, skipped on Node) for the document's `max-age` capped at 7 days; with CIMD off it reads a URL client id
    from KV like any stored client (`client:<url>`), which relic-bridge uses to hand it validated documents (ADR-0012).
    Grant replacement for URL client ids is keyed by redirect URI as well (any flag). DCR: `client_id` is 16 random
    characters; listed redirect URIs may use private-use schemes as long as one is https or loopback http;
    `clientRegistrationTTL` (default 90 days) expires registrations, renewed at half-life after a successful token
    response; `clientRegistrationCallback` can refuse a registration. Confidential DCR clients are accepted
    (`client_secret_basic` / `_post`).
  - The provider's own PRM handler and `OAuthResourceServer` challenge (`resource_metadata`, `insufficient_scope`)
    exist but are bound to declared resources; relic-bridge builds PRM and the challenge itself from the path, so no
    project list is needed per request and unknown slugs answer like known ones.
- Originally to verify (P0-08):
  1. whether the library can run on Node with a KV-compatible adapter backed by SQLite (otherwise use a Node-native
     authorization server such as `oidc-provider`, behind the same interface)
  2. per-slug resources: a token for `/p/a/mcp` must be rejected at `/p/b/mcp`
  3. path-based Protected Resource Metadata (`/.well-known/oauth-protected-resource/p/{slug}/mcp`)

## 6. New Relic endpoints

- US: `https://api.newrelic.com/graphql`
- EU: `https://api.eu.newrelic.com/graphql`
- **JP: `https://api.jp.newrelic.com/graphql`** (documented; found in P0-09)
- FedRAMP: **no NerdGraph endpoint documented** (the FedRAMP page lists only ingest endpoints), so it isn't supported unless a user confirms one.
- Async NRQL is documented together with Data Plus (10-minute max duration). Whether it works on Original Data accounts
  is still to be measured live (P0-09). `auto` mode must fall back to sync with the maximum timeout.
- `aiIssues` requires the header `nerd-graph-unsafe-experimental-opt-in: AiIssues` (per docs). Treat it as an unstable API and
  send the header only for those documents.
- Errors Inbox (`errorsInbox.errorGroups`) has no public NerdGraph tutorial, so its shape comes from introspection (P0-09 probe).
- Entity search: single-quoted strings, max 200 per page with `nextCursor`. **Measured (P0-09): `\'` escapes a quote**
  (`name = 'it\'s'` is valid; `''` and unbalanced quotes → `INVALID_INPUT`). Rule: backslash-escape `\` and `'`.
- Entity schema (introspected, P0-09): `Entity.relatedEntities(cursor, filter: EntityRelationshipEdgeFilter { direction:
  INBOUND|OUTBOUND|BOTH, entityDomainTypes { include, exclude: [DomainTypeInput { domain, type }] }, relationshipTypes },
  limit)` → `results: [EntityRelationshipEdge { type, source/target: EntityRelationshipVertex { guid accountId entity } }]`;
  `EntitySearch.types { domain type entityType count }`; `EntitySearchOptions { limit, tagFilter, caseSensitiveTagMatching }`.
  GUIDs are base64 of `accountId|DOMAIN|TYPE|domainId`. Not yet verified live: `accountId IN (…)` in a search filter,
  `options.limit` semantics (P1-08 pending decision).
- `aiIssues` worked **with and without** the opt-in header (P0-09). Send it anyway, as documented.
- `Actor.accounts(scope: RegionScope)`: account listing takes a region scope. Pass it explicitly when validating keys.
- `embeddedChartUrl` creates a **shareable public chart URL**, and **selecting `staticChartUrl` generates a token-signed public
  snapshot image URL** (observed in P0-09). Neither is ever selected by default (privacy, THREAT_MODEL T26).
- Full docs-verified table: `spikes/nerdgraph/RESULTS.md` §A.
- Auth header: `API-Key: NRAK-…` (User key). License and ingest keys are rejected by design.
- Useful queries:
  - `actor.user` / `actor.accounts`: validate a key and list the accounts it can reach
  - `actor.account(id).nrql(query, timeout, async)` and cross-account `actor.nrql(accounts: […])`
  - `actor.entitySearch(query: "…")`, `actor.entity(guid)`, `relatedEntities`
  - `entity.goldenMetrics { metrics { title query } }`: returns NRQL to run
  - `account.aiIssues`, `account.alerts.policiesSearch` / `nrqlConditionsSearch`, `actor.errorsInbox`
- Alerts (P6-01, from the P0-09 introspection): `AlertsAccountStitchedFields.policiesSearch(cursor, searchCriteria:
  AlertsPoliciesSearchCriteriaInput { ids, name, nameLike })` → `{ nextCursor totalCount policies { id name accountId
  incidentPreference entityGuid } }` (live-verified, sanitized fixture `alerts_policies.json`). `nrqlConditionsSearch(cursor,
  searchCriteria { name, nameLike, policyId: ID, query, queryLike, termsOperator })` → `nrqlConditions` of the interface
  `AlertsNrqlCondition` (id, name, policyId, entityGuid, enabled, type STATIC|BASELINE|OUTLIER, description, runbookUrl,
  `nrql { query dataAccountId }`, `terms { priority operator threshold thresholdDuration thresholdOccurrences }`, `signal`,
  `violationTimeLimitSeconds`). **Introspected only, not yet live-verified:** `nrqlConditionsSearch` results, `queryLike`
  semantics, and the page size of both searches (no `limit` argument exists; NerdGraph chooses).
- AI issues (P6-02, P0-09 introspection + the `ai_issues_experimental_header` probe, which returned empty lists):
  `account.aiIssues.issues(cursor, filter: AiIssuesFilterIssues { states, priority, entityGuids, policyIds, isAcknowledged,
  contains, ... }, timeWindow: TimeWindowInput { startTime, endTime } epoch ms)` → `{ nextCursor issues { issueId title[]
  state priority createdAt ... accountIds[] entityGuids[] entityNames[] policyName[] ... } }`; `incidents(...)` with
  `AiIssuesFilterIncidents { states, priority, entityGuids, entityTypes, ids }` (no text filter). Issue states: CREATED,
  ACTIVATED, DEACTIVATED, CLOSED; incident states: CREATED, CLOSED; priority: CRITICAL, HIGH, MEDIUM, LOW. `AiIssuesIssue`
  lists (`title`, `entityGuids`, ...) are arrays; on `AiIssuesIIncident` introspection shows `accountIds`, `entityGuids`,
  `entityNames`, `entityTypes` as plain scalars, so the tool accepts both a list and a comma-separated string.
  **Not live-verified with rows:** the real shape of those incident fields, the meaning of `timeWindow` (creation vs update
  time), and the page size (no `limit` argument).

## 6b. npm publishing (P1-15)

- Errors Inbox (P6-03, P0-09 introspection + the `errors_inbox` probe, which returned an empty list): `actor.errorsInbox.
  errorGroups(cursor, entityGuids: [EntityGuid!], filter: ErrorsInboxErrorGroupSearchFilterInput { accountIds, ids, states
  UNRESOLVED|RESOLVED|IGNORED, isAssigned, assignment, applicationVersions }, query: String, sortBy: [{ field:
  OCCURRENCES|LAST_OCCURRENCE_IN_WINDOW|FIRST_SEEN, direction: DESC }], timeWindow)` → `{ nextCursor totalCount results {
  id name message state issueType source isCustom entityGuid firstSeenAt lastSeenAt regressedAt eventsQuery url occurrences {
  totalCount expectedCount firstSeenAt lastSeenAt } } }`. **Introspected only, not yet live-verified:** row shapes with real
  groups, what `query` matches, whether `occurrences` honours `timeWindow`, and page size (no `limit`). `direction` has only
  `DESC`. `assignment.email` is PII and not selected.
- Change tracking (P6-04, P0-09 introspection only, no live probe; not verified against a real account):
  `actor.changeTracking.changeTrackingSearch(filter: { accountIds: [Int!], limit, query, timeWindow { startTime endTime } })` →
  `{ changeEvents: [ChangeTrackingEvent] }` (interface: changeTrackingId, category, type, categoryAndType, timestamp,
  description, shortDescription, user, groupId, entity: EntityOutline; `ChangeTrackingDeploymentEvent` adds version, commit,
  changelog, deepLink; `ChangeTrackingFeatureFlagEvent` adds featureFlagId). Per entity: `entity(guid).deploymentSearch(filter:
  ChangeTrackingSearchFilter { limit, query, timeWindow })` → `{ results: [ChangeTrackingDeployment { deploymentId
  deploymentType version commit changelog deepLink description user groupId entityGuid timestamp }] }`. Neither has a cursor;
  the `limit` maximum and the syntax of `query` are unknown (`query` is not used). **Unverified:** that `Transaction` carries
  `entityGuid` for every APM agent, and the result shape of `percentile(duration, 95) AS p95Duration` (read as a number or the
  first numeric member of an object).
- APM transactions (P6-05, NRQL over `Transaction`, not verified against a real account): per-application filter
  `WHERE entityGuid = '<guid>'`, per-transaction `FACET name`, failures `error IS true`, `transactionType` `'Web'` or `'Other'`
  (background), durations in seconds. `percentile(duration, 50)`, `(…, 95)` and `(…, 99)` are selected separately with aliases and
  read as a number or the first numeric member of an object. **Unverified:** facet rows carrying the facet value in `facet`
  (an array when several facets), that `ORDER BY <aggregate> DESC` after `FACET` honours non-selected-alias expressions (the
  tool re-sorts client-side anyway), and `LIKE` being case-insensitive (the tool's description says so; check live).
- Logs (P6-06, NRQL over `Log`, not verified against a real account): the entity filter is the `entity.guid` attribute
  (sent backtick-quoted), the text is `message`, the severity `level`, newest first with `ORDER BY timestamp DESC`; `level`
  values vary by forwarder (`ERROR`, `error`, `Error`, `WARNING`...), so the level filter matches a fixed list of case
  variants (NRQL string equality is case-sensitive). Time series use `TIMESERIES <n> seconds` and rows carry
  `beginTimeSeconds` / `endTimeSeconds`; level counts use `FACET level`. **Unverified:** `entity.guid` being set on every
  log source, the exact `level` spellings, `LIKE` case sensitivity (the tool says "case as typed"), `TIMESERIES` in seconds
  being accepted, and the 2000-row LIMIT ceiling for non-aggregate queries (the tool samples 1000).
- JVM and Kafka (P6-07, not verified against a real account): Java agent timeslices are read from `Metric` with
  `average/max/sum/count(newrelic.timeslice.value)` faceted by `metricTimesliceName` and filtered by `entity.guid` and name prefixes
  (`Threads/SummaryState/<STATE>/Count`, `JmxBuiltIn/Threads/`, `CPU/`, `Memory/`, `GC/`, `JmxBuiltIn/GC/`, `Memory/Heap/`). Kafka uses the
  `nri-kafka` event types: `KafkaOffsetSample` (`consumer.lag`, `consumerGroup`, `topic`, `partition`), `KafkaTopicSample`
  (`topic.bytesInPerSec`, `topic.bytesOutPerSec`, `topic.messagesInPerSec`), `KafkaBrokerSample` (`broker.bytesInPerSecond`,
  `broker.bytesOutPerSecond`, `broker.messagesInPerSecond`, facet `entityName`), cluster filter `clusterName`. **Unverified:** every
  name above (a wrong one yields null aggregates, which the tools report as "no data"), timeslice units, `entity.guid` on `Metric`, and
  Kafka via OpenTelemetry or cloud integrations (MSK/Confluent), which use other event/metric names and are not read.
- Synthetic monitors (P6-08, not verified against a real account): monitors come from `entitySearch` with `domain = 'SYNTH' AND
  type = 'MONITOR'` and the inline fragment `... on SyntheticMonitorEntityOutline { monitorId monitorType monitoredUrl period status }`
  (`monitorType` SIMPLE/BROWSER/SCRIPT_API/SCRIPT_BROWSER/STEP_MONITOR, `status` ENABLED/MUTED/DISABLED, `period` in minutes). Results
  are read from `SyntheticCheck` (`entityGuid`, `location`, `result` = SUCCESS/FAILED, `duration` in ms, `error` for failures,
  `timestamp`) faceted by `entityGuid, location`. `monitorType`/`status` are filtered client-side because their entity-search field
  names are not confirmed. **Unverified:** every field above, `entityGuid` on `SyntheticCheck`, `error` holding the failure message,
  and the units of `period`. The monitor script, secure credentials and headers are deliberately never selected.
- **Trusted publishing** (OIDC from GitHub Actions, no long-lived npm token) needs npm CLI ≥ 11.5.1 and Node ≥ 22.14
  (Node 24 bundles npm 11), job permission `id-token: write`, and a GitHub-hosted runner. Each package has at most one
  trusted publisher (workflow file + optional environment); `npm trust github <pkg> --file release.yml --env release`
  configures it from the CLI. npm's own example disables the package-manager cache in release jobs
  (`package-manager-cache: false`). Source: docs.npmjs.com/trusted-publishers, /generating-provenance-statements.
- `npm publish --provenance --access public` on a tarball packed by `pnpm pack` (pnpm resolves `workspace:` ranges
  and adds the root `LICENSE`; it does not add `NOTICE` or `README.md`, so `apps/cli` carries copies, checked against
  the root by `scripts/check-package.ts`). `pnpm pack` tarballs have fixed mtimes (1985-10-26), so they are
  reproducible for a given build.
- `pnpm sbom --sbom-format cyclonedx` (pnpm 12) writes a CycloneDX 1.7 SBOM per workspace package.
- `actions/attest` v4 (successor of `attest-build-provenance`) needs `id-token: write`, `attestations: write` and
  `artifact-metadata: write`; in **private** repositories attestations need GitHub Enterprise, so release from a public
  repo.
- npm staged publishing (`npm stage publish`, `--allow-stage-publish` on the trusted publisher) lets CI upload a
  version that a maintainer then approves with 2FA; an alternative to environment approval (pending decision P1-15).
- The name `relic-bridge` is owned by the maintainer (0.0.0 placeholder, 2026-10-03; P0-01).

## 7. Existing community projects (prior art)

[cloudbring/newrelic-mcp](https://github.com/cloudbring/newrelic-mcp),
[alanhoff/newrelic-mcp](https://github.com/alanhoff/newrelic-mcp),
[ulucaydin/mcp-server-newrelic](https://github.com/ulucaydin/mcp-server-newrelic),
[thrashy/mcp-newrelic](https://github.com/thrashy/mcp-newrelic),
[piekstra/newrelic-mcp-server](https://github.com/piekstra/newrelic-mcp-server),
[adjohn/newrelic-mcp-app](https://github.com/adjohn/newrelic-mcp-app),
[xelber/newrelic-mcp](https://github.com/xelber/newrelic-mcp).

These are all single-user, local, one key from an environment variable. relic-bridge's differentiators: multiple projects
and credentials, a hosted Worker *or* local deployment, an access model with per-tool grants, OAuth for mobile/web
clients, an admin panel, an audit log, and security as a documented feature. Task **P0-11** reviews their tool designs
and known issues before Phase 1.

## 8. Drizzle ORM and drizzle-kit (P2-01, checked 2026-10-03)

- npm `latest`: `drizzle-orm` 0.45.3 and `drizzle-kit` 0.31.11 (both 2026-09-21). The 1.0 line is still a release
  candidate (`rc` tag 1.0.0-rc.4, nightly `rc5` builds); 1.0 adds a `node:sqlite` driver and changes the migration
  folder layout (no `_journal.json`). We pin the stable 0.x line.
- `sqliteTable(name, columns, (t) => [index(), uniqueIndex(), check()])` is the current extra-config form; `check()`
  renders as table-qualified `CHECK("table"."col" …)`, which SQLite accepts (verified with `node:sqlite`).
- `drizzle-kit generate` writes `migrations/NNNN_tag.sql` with `--> statement-breakpoint` separators plus
  `meta/_journal.json` and snapshots. D1 runs the same SQL.
- `drizzle-kit` 0.31 still depends on the deprecated `@esbuild-kit/*` loader, which pulls esbuild 0.18
  (GHSA-67mh-4wv8-2f99, dev-server only). Overridden to esbuild 0.25.12 in `pnpm-workspace.yaml`; generation works.
- Sources: npm registry metadata; orm.drizzle.team docs (SQLite column types, indexes & constraints).

## 9. WebCrypto AES-GCM and HKDF (P2-03, checked 2026-10-03)

- `crypto.subtle` AES-GCM: `encrypt({ name: 'AES-GCM', iv, additionalData, tagLength: 128 })` returns
  `ciphertext || tag` in one buffer; `decrypt` takes the same layout and rejects with `OperationError` on any
  authentication failure (no partial plaintext). Same API and behaviour on Node 24 and Workers.
- A 96-bit IV is the recommended size (NIST SP 800-38D §8.2); with random IVs the limit is 2^32 encryptions per key,
  far above the number of stored NR keys (each write and rotation is one encryption).
- HKDF: import the master key as `'HKDF'` (non-extractable, `deriveKey`/`deriveBits` only); `deriveKey` straight into
  a non-extractable AES-GCM key; `deriveBits(…, 256)` for the key check value. Different `info` labels give
  independent outputs (RFC 5869).
- `Uint8Array.fromBase64` is not in Node 24 (only newer releases), so base64 uses `atob`/`btoa`.
- Under `@types/node`, `CryptoKey` is a value, not a global type; use
  `Awaited<ReturnType<typeof crypto.subtle.importKey>>` in code type-checked under both libs.
- Known answers: NIST GCM test cases 13, 14, 16 (McGrew & Viega, *The Galois/Counter Mode of Operation*); our own
  format vectors were cross-checked with OpenSSL through `node:crypto` (`hkdfSync`, `aes-256-gcm`).
- Sources: W3C Web Cryptography API; MDN SubtleCrypto (encrypt, deriveKey, deriveBits); NIST SP 800-38D; RFC 5869.

## 10. `@hono/zod-openapi` (P2-09, checked 2026-10-03)

- `@hono/zod-openapi` 1.6.3 (npm `latest`, 2026-09-04) peers on `zod ^4` and `hono >=4.10`; it wraps
  `@hono/zod-validator` 0.9 and `@asteasolutions/zod-to-openapi` 9.1 (all MIT). `import { z } from '@hono/zod-openapi'`
  adds `.openapi()` to zod 4 schemas; `getOpenAPI31Document()` emits OpenAPI 3.1 (`type: ['string', 'null']` for
  nullable fields). Web-standard: runs on Node and Workers.
- Validation failures go to the app's `defaultHook` (or a per-route hook); throwing from it reaches `onError`. Malformed
  JSON is Hono's own `HTTPException(400)`; a JSON body whose `Content-Type` isn't JSON is not validated as JSON, so the
  admin API checks the content type itself (`415`).
- Query parameters reach the validator as strings (arrays when repeated); `z.coerce.number()` turns `limit=` into `0`.
- A sub-app's `onError` applies to its routes when mounted with `app.route()`; the parent's `notFound` applies to
  unmatched paths, so the admin API ends with its own catch-all for its error shape.
- With `isolatedDeclarations` (tsdown's fast DTS path) every exported value needs an explicit type, so the zod schemas
  are not re-exported from the package entry; only constants and functions with declared types are.
- Sources: package README and type definitions in `node_modules/@hono/zod-openapi`; Hono docs (validation, `route()`).

## Docker image facts (P2-11, verified 2026-10-03)

- `gcr.io/distroless/nodejs24-debian13:nonroot` (uid 65532) ships Node 24 at `/nodejs/bin/node` with `node:sqlite`; no shell,
  so the `HEALTHCHECK` is a Node one-liner. `node:24-trixie-slim` provides corepack for the pnpm version in `packageManager`.
- The production dependencies of `relic-bridge` are pure JavaScript, so the build stage runs on the builder's
  architecture (`FROM --platform=$BUILDPLATFORM`) and the arm64 image needs no QEMU.
- `pnpm deploy --legacy` (no `inject-workspace-packages`) produces the production tree; the workspace packages are bundled
  into `dist/index.mjs`, so only 6 third-party packages are copied into the image.
- Events created with `GITHUB_TOKEN` (the GitHub Release made by `release.yml`) do not start other workflows, so the
  image workflow listens to `workflow_run` of `Release` and re-checks that `v<version>` is a published release at that
  commit.
- Ubuntu runners include Skopeo 1.13 and Docker Buildx; `skopeo copy --all --preserve-digests` pushes a multi-arch OCI
  archive without changing its digest, which lets the build job (no credentials) and the publish job (no project code)
  be separate.
- Docker/Compose bind-mounted and file-based secrets keep the host owner and mode (`uid`/`mode` are Swarm-only);
  Kubernetes secret volumes are root-owned and become group-readable with `fsGroup`.
- A loopback `Host` is refused by the server unless listed in `RB_ALLOWED_HOSTS`, so the health check treats a
  `403 forbidden_host` answer as alive.

## 11. Workers runtime and tooling facts (P3-01, verified 2026-10-03)

Sources: <https://developers.cloudflare.com/workers/wrangler/configuration/>,
<https://developers.cloudflare.com/workers/testing/vitest-integration/>,
<https://developers.cloudflare.com/workers/observability/errors/>,
<https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/>,
<https://developers.cloudflare.com/changelog/post/2026-03-24-secrets-config-property/>. Checked locally with wrangler
4.144.0 / workerd 1.20260926.1.

- **Vitest integration renamed**: `@cloudflare/vitest-pool-workers` is now `@cloudflare/vitest-plugin` (1.x, Vitest
  ≥ 4.1), configured with the `cloudflareTest({ wrangler: { configPath }, miniflare })` Vite plugin;
  `defineWorkersConfig` and `cloudflare:test`'s `SELF`/`env` are deprecated in favour of `exports`/`env` from
  `cloudflare:workers`. Projects with different pools coexist in one root `vitest.config.ts`.
- **V8 coverage cannot attach to workerd** (`node:inspector` `Session` not implemented): `pnpm test:coverage` excludes
  the `worker` project (`--project=!worker`), and CI runs it separately (`pnpm test:workers`).
- **Main module exports**: workerd treats every named export of the `main` module as an entrypoint and refuses to start
  when one is not a handler (`Incorrect type for map entry …`). The entry file exports the default handler only.
- **Cross-request I/O**: I/O started by one request belongs to that request; awaiting it from another request is unsafe
  (a cancelled originator leaves waiters hanging, or throws "Cannot perform I/O on behalf of a different request").
  The Worker therefore never shares an in-flight boot between requests (each cold request boots; the first finished
  runtime is kept). Caching non-I/O results (keyring, Hono app, in-memory buckets) and binding objects is fine.
- **`env` identity**: the same `env` object is passed to every request of an isolate (observed under `wrangler dev`),
  so a per-isolate cache can key on it.
- **Automatic provisioning** (wrangler ≥ 4.45, open beta): D1/KV/R2 bindings without ids work in `wrangler dev`
  (local resources) and are created on the first `wrangler deploy`, which writes the ids back into the config file.
  The committed `apps/worker/wrangler.jsonc` therefore has no ids.
- **`secrets.required`** declares secret names: `wrangler deploy` fails when one is not set; `wrangler dev` then loads
  only those names from `.dev.vars`/`.env` and warns about missing ones (the Vitest integration prints the same warning;
  tests pass secrets through `miniflare.bindings`).
- **Rate Limiting binding** config: `"ratelimits": [{ "name", "namespace_id", "simple": { "limit", "period": 10 | 60 } }]`
  (GA since 2025-09); it works locally under `wrangler dev`. Semantics are per-location and eventually consistent (P3-04).
- **Bundle size**: `wrangler deploy --dry-run --outdir dist` (no account needed) bundles the Worker: 1.75 MiB raw,
  **339 KiB gzip** at P3-01, well under the Free plan's 3 MiB compressed limit. `pnpm build` runs this for `apps/worker`.
- No `nodejs_compat` flag is needed: every package is web-standard (ADR-0004).

## 11b. Measuring Worker CPU in CI (P3-10, 2026-10-03)

- In the **local** workerd that `@cloudflare/vitest-plugin` starts, `performance.now()`/`Date.now()` advance during CPU
  work (a 3e7-iteration busy loop read ~51 ms). Production workerd freezes timers until I/O (Spectre mitigation), so
  this only works locally. The clock ticks in whole milliseconds: per-iteration readings are quantised, so the
  benchmark compares a trimmed mean (fastest 90%) and times sub-millisecond work in batches.
- `console.log` output from tests inside this pool does not reach the terminal; results travel in `task.meta`, read from
  Vitest's JSON reporter (`--reporter=json`, `meta` per assertion).
- Numbers (`pnpm bench:cpu`, WSL2 dev machine, warm isolate, local D1 simulator; trimmed mean, ms): calibration job
  3.6; `crypto.decrypt` 0.013; `token.verify.d1` 4.1; `access.resolve.miss.d1` 4.7; `initialize` 4.5; `tools/list`
  cache hit 6.7 / miss 13.0; `whoami` 5.7; `run_nrql` 10 KB 7.3, 100 KB 9.4, ~500 KB 15.3; fresh Worker boot + first
  request 35.6. They run about 2-3x the production figures of P0-06 (2.8 ms p50 for 10 KB) because the wall time includes
  the local D1 simulator's latency and a slower machine. Only the **ratio to the baseline** is meaningful; the absolute
  values are not a prediction for Workers Free.
- What the numbers say: the D1 round trip is most of a miss (hit 6.7 vs miss 13.0 ms for `tools/list`); decrypting the
  stored key is negligible; the large-result cost scales with payload (about +6 ms from 100 KB to 500 KB).

## 12. Cloudflare D1 facts (P3-02, verified 2026-10-03)

Sources: <https://developers.cloudflare.com/d1/worker-api/d1-database/>,
<https://developers.cloudflare.com/d1/reference/migrations/>, <https://developers.cloudflare.com/d1/sql-api/foreign-keys/>.
Checked locally with wrangler 4.144.0 / `@cloudflare/vitest-plugin` 1.3.3 (Miniflare's D1); not yet against a remote
database.

- **No interactive transactions.** `batch()` sends several statements in one call and runs them as one SQL transaction
  (a failing statement rolls the whole batch back); otherwise D1 auto-commits each statement. Atomic
  read-decide-write therefore needs a single conditional statement.
- **Results:** `meta.changes` counts rows written; `RETURNING` works (`INSERT/UPDATE … RETURNING *` via `.all()`).
  BLOBs bind from `ArrayBuffer`/typed arrays and come back as byte arrays (`toBytes` normalises them).
- **Errors** read `D1_ERROR: UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT (extended: …)`, with the plain
  SQLite message as `cause`; the constraint names match SQLite's, so one mapping serves both adapters.
- **Foreign keys are always enforced** (`PRAGMA foreign_keys` reads 1); D1 offers `PRAGMA defer_foreign_keys = true`
  for migrations that must violate them temporarily. SQLite ignores `PRAGMA foreign_keys` inside a transaction, so the
  D1 migration driver skips those statements (drizzle-kit emits them around table rebuilds).
- **Read retries:** D1 retries read-only queries (`SELECT`/`EXPLAIN`/`WITH`) up to twice on retryable errors; writes are
  not retried (changelog 2025-09-11).
- **`wrangler d1 migrations`** tracks applied files in its own `d1_migrations` table (`migrations_dir`,
  `migrations_pattern` for drizzle's nested layout since 2026-06). relic-bridge does not use it: the Worker runs the
  embedded migrations itself (ADR-0006 update P3-02).
- **Test isolation:** in `@cloudflare/vitest-plugin` 1.3.3 the local D1 database is shared by the tests of a file;
  tests that need an empty database drop the tables first (`wipeD1`).

## 13. Workers Rate Limiting binding (P3-04, checked 2026-10-03)

- GA since 2025-09-19 (`ratelimits` in Wrangler config; the `unsafe` binding still works). Config per binding:
  `namespace_id` (string) and `simple: { limit, period }` with `period` 10 or 60 seconds only.
- API: `await env.X.limit({ key })` returns `{ success: boolean }`. No `peek`, no cost, no remaining count, no
  per-call limit: the limit is fixed by the binding's configuration.
- Counted per Cloudflare location and eventually consistent (permissive by design), so it is a backstop, not an exact
  limiter. Not verified here: whether calls count as subrequests (assumed not).
- Local: the workers vitest pool and `wrangler dev` simulate the binding; unit tests use a fake with the same shape.

## 14. Deploy button and provisioning (P3-05, checked 2026-10-03)

- **Deploy to Cloudflare button:** `https://deploy.workers.cloudflare.com/?url=<repo URL>` (a `/tree/<branch>/<dir>` URL
  selects a subdirectory). Cloudflare clones into the user's GitHub/GitLab, provisions KV/D1/R2/etc. bindings declared
  without ids, prompts for secrets named in `.dev.vars.example` / `.env.example`, and builds with Workers Builds.
  Not verified here: monorepo behaviour (our config aliases `../../packages/*`, so the build needs the whole clone) and
  the default build command; no account was used.
- **Automatic provisioning** (Wrangler >= 4.45, now in the config reference): bindings without ids are created on
  `wrangler deploy` with the Worker name as prefix, and ids are written back **into the config file used**. The setup
  script therefore deploys a git-ignored copy. Dashboard/Git deploys keep ids only in the dashboard.
- **`secrets.required`** (2026-03-24): `wrangler deploy` and `versions upload` fail if a required secret isn't set on the
  Worker, so the setup script sets secrets before the first deploy. `wrangler secret bulk` (stdin JSON when no file is
  given) sets several at once without argv exposure. Whether `secret bulk` creates a not-yet-deployed Worker is not
  verified (pending decision).
- `wrangler deploy --var NAME:value` overrides a `vars` entry at deploy time; `wrangler secret list --format json` lists
  secret names only. A missing Worker is assumed to answer with API code 10007 (not verified).
- **Changing several secrets atomically** (P3-11, checked 2026-10-03): `wrangler secret put` creates and deploys a new
  version per call, so two calls deploy an intermediate version. `wrangler secret bulk` (JSON on stdin) creates, updates
  or (wrangler >= 4.97, `null` values) deletes up to 100 secrets in one request and one version; secrets not named are
  kept ([secret bulk](https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret-bulk),
  [bulk secrets API](https://developers.cloudflare.com/changelog/post/2026-06-03-bulk-secrets-api/)). The master-key
  rotation runbook sets `RB_MASTER_KEY` and `RB_MASTER_KEY_PREVIOUS` this way.

## 15. WAF rate-limiting rules as an admin-API backstop (P3-13, checked 2026-10-03)

- Rate limiting rules are zone rules (dashboard: Security > Security rules > Create rule > Rate limiting rules). Free
  plan: 1 rule, counting characteristic preset to IP, 10 s period, action Block, 10 s mitigation; Pro 2 rules, Business 5.
  Counting only failed responses (`http.response.code in {401 403}` under "Increment counter when") is Business and up.
  Source: https://developers.cloudflare.com/waf/rate-limiting-rules/ (availability table) and
  https://developers.cloudflare.com/use-cases/solutions/stop-account-takeover-attacks/.


## 16. Identity providers for admin sign-in (P4-01, checked 2026-10-03)

- **GitHub** supports PKCE (S256 only) for OAuth apps and GitHub Apps since 2025-07-14; not required, but used when
  `code_challenge` is sent. GitHub does not distinguish public and confidential clients.
  Source: https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/.
  Token endpoint `POST https://github.com/login/oauth/access_token` answers OAuth errors with **HTTP 200** and an
  `error` field (`Accept: application/json`). `GET /user/emails` (scope `user:email`) returns `primary` and `verified`
  per address; `GET /user/memberships/orgs/{org}` (scope `read:org`) returns `state: active | pending`, 404 when not a
  member. Organization OAuth app access restrictions can hide memberships until an org owner approves the app.
- **Google** OIDC: discovery at `https://accounts.google.com/.well-known/openid-configuration`; ID token `iss` is
  `https://accounts.google.com` **or** `accounts.google.com` (both documented); `hd` request parameter is only a hint,
  the `hd` claim must be checked. Supports PKCE S256, `client_secret_basic` and `client_secret_post`.
  Source: https://developers.google.com/identity/openid-connect/openid-connect.
- **Cloudflare Access**: the application token is in the `Cf-Access-Jwt-Assertion` header (also the `CF_Authorization`
  cookie, which we ignore); keys at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, RS256, `iss` = team
  domain, `aud` = array containing the application's AUD tag; service-token JWTs carry `common_name` and an empty
  `sub`, no `email`. Source: https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/.
- **jose 6.2.12** (`panva/jose`, zero dependencies, WebCrypto; runs on Node and workerd): `createRemoteJWKSet` caches
  10 min by default, refetches for an unmatched `kid` only after `cooldownDuration` (30 s) and accepts a `[customFetch]`
  (used to inject the mock IdP); `jwtVerify` never accepts `alg: none`, and an `algorithms` allowlist excludes HMAC
  (key confusion). Already in the lockfile through `@modelcontextprotocol/client`, published 2026-09-05 (beyond the
  3-day `minimumReleaseAge`).
- **RFC 9207** (`iss` in the authorization response) is advertised by `authorization_response_iss_parameter_supported`;
  when advertised it must be present, when present it must equal the issuer.

## 17. Browser session cookies and CSRF signals (P4-02, from documentation 2026-10-03, not re-measured)

- **`__Host-` prefix** (RFC 6265bis §4.1.3.2): the browser accepts the cookie only with `Secure`, `Path=/` and no
  `Domain`, from a secure origin, so a sibling subdomain can neither set nor overwrite it (cookie tossing). Browsers
  refuse it over plain http, hence `rb_session` on http loopback (`parsePublicUrl` allows http only for loopback).
  Source: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie#cookie_prefixes.
- **SameSite**: `Lax` cookies are sent on top-level `GET` navigations from other sites and withheld on cross-site
  subresources, `fetch`, and `POST` forms; `Strict` cookies are withheld on any request whose navigation chain started
  on another site, including the redirect chain IdP → `/auth/callback` → `/admin`, so the first admin page after an
  IdP sign-in would arrive without the session. Source: RFC 6265bis §5.2 ("same-site" requests and redirects),
  https://web.dev/articles/samesite-cookies-explained.
- **Fetch metadata**: `Sec-Fetch-Site` is `same-origin`, `same-site`, `cross-site` or `none` (user-initiated: typed
  URL, bookmark), sent by Chromium, Firefox and Safari (16.4+) on every request. Source:
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Sec-Fetch-Site and https://web.dev/articles/fetch-metadata.
- **`Origin`** is sent on every `POST`/`PUT`/`PATCH`/`DELETE` by current browsers, same-origin ones included (Fetch
  standard, "append a request `Origin` header"); `GET`/`HEAD` same-origin requests may omit it. OWASP's CSRF cheat
  sheet recommends a synchronizer token plus Origin/fetch-metadata verification as defence in depth.
  Source: https://fetch.spec.whatwg.org/#origin-header,
  https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html.
- Session guidance (idle 15-30 min, absolute 4-8 h for high-value apps; rotate the id at login; server-side
  invalidation on logout): https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html. We default
  to 30 min / 12 h (a personal admin used from a phone) and let `RB_SESSION_*` tighten it.

## 18. Server-rendered admin UI: Hono JSX, CSP and fetch metadata (P4-03, from documentation 2026-10-03)

- **Hono JSX** (hono 4.13): `jsx: react-jsx` + `jsxImportSource: hono/jsx` (or the per-file pragma
  `/** @jsxImportSource hono/jsx */`, which esbuild/wrangler, rolldown/tsdown and Vitest all honour). Children and
  attribute values are escaped; `raw()` / the `html` helper and `dangerouslySetInnerHTML` are the only ways around it.
  A rendered element's `toString()` is a string when no component is async. `app.route()` keeps a sub-app's
  `onError` for its routes. Source: https://hono.dev/docs/guides/jsx, https://hono.dev/docs/helpers/html.
- **CSP**: `default-src 'none'` plus `script-src 'self'` / `style-src 'self'` covers pages with no inline code (no nonce
  needed). `form-action 'self'` also applies to redirects after a form post in Chromium, so sign-out may redirect only
  within the origin. `frame-ancestors 'none'` supersedes `X-Frame-Options` (kept for old browsers).
  `require-trusted-types-for 'script'` makes string-to-HTML sinks throw (Chromium; others ignore it). Source:
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy,
  https://w3c.github.io/trusted-types/dist/spec/.
- **SRI** on same-origin `<script>`/`<link>` needs no `crossorigin` attribute. Source:
  https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity.
- **Resource isolation with fetch metadata**: allow `Sec-Fetch-Site` `same-origin` / `same-site`* / `none`, plus
  cross-site requests with `Sec-Fetch-Mode: navigate` and a `GET` method and a `Sec-Fetch-Dest` other than
  `object`/`embed`; refuse the rest. We are stricter: `same-site` is refused (subdomains are not trusted) and a
  navigation must be `Sec-Fetch-Dest: document` (frames are refused here too, besides `frame-ancestors`). Source:
  https://web.dev/articles/fetch-metadata.
- **`__Host-` cookies need `Path=/`**: the flash cookie (`__Host-rb_flash`) is therefore site-wide, short-lived
  (60 s) and carries only a message code. Source: RFC 6265bis §4.1.3.2.
- **axe-core in jsdom**: rules run on the DOM. `color-contrast` needs layout and is reported "incomplete" in jsdom, so
  token contrast is computed from the stylesheet (WCAG 2.x relative luminance) instead. Source:
  https://github.com/dequelabs/axe-core/blob/develop/doc/API.md.

## 19. Revoking GitHub OAuth user tokens (P4-13, checked 2026-10-04)

Source: <https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-token>

- `DELETE https://api.github.com/applications/{client_id}/token` with JSON body `{"access_token": "<token>"}`.
  Authentication is HTTP Basic with the OAuth app's client id and client secret (not the user token).
  `204 No Content` on success; `404` when the token is unknown or already revoked; `422` on validation failure or when
  the endpoint is being spammed. Revoking the token ends that one token only; the user's app authorization stays.
- relic-bridge treats `204` and `404` as done, anything else (and network errors or timeouts) as a failed, logged
  best-effort revocation.

## 20. OAuth consent page in the browser (P5-04, measured 2026-10-05 with Playwright's Chromium)

- **`form-action` and the redirect after a consent post.** With the admin UI policy (`form-action 'self'`), posting the
  consent form to our origin and answering `303 Location: http://127.0.0.1:<port>/callback?code=…` is blocked by
  Chromium (the navigation never reaches the client; `e2e/oauth.spec.ts` times out waiting for the callback). Adding
  the redirect URI's origin to `form-action` fixes it. CSP3 host sources have no syntax for IPv6 literals, so an
  `http://[::1]` redirect needs the `http:` scheme source. Source: https://www.w3.org/TR/CSP3/#directive-form-action
  (the check applies to "navigations … including redirects" in Chromium; measured, not assumed).
- **The provider's consent helpers** (`beginConsent` / `approveConsent` / `isConsentRemembered` in
  `@cloudflare/workers-oauth-provider` 1.2.1): a 10-minute encrypted transaction in KV bound to the browser by a
  `__Host-` cookie per transaction, and remembered consent in an HMAC-signed `__Host-…approvals` cookie keyed by client,
  redirect URI, resource and an optional subject. `__Host-` cookies need `Secure`, which an `http://localhost`
  development instance can't rely on, and the remembered-consent cookie stores scopes only (not which relic-bridge grant
  was chosen) and can't be revoked server-side; relic-bridge keeps the request in the URL (re-validated each step) and
  remembered approvals in its own `kv` rows instead. Source: `node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js`
  (`src/oauth-consent.ts` region).

## 21. Refresh token reuse intervals (P5-09, checked 2026-10-05)

- **Okta** "grace period for token rotation": after a refresh token is rotated, the previous one stays valid for the
  configured time so clients can still get the new token; default **30 s**, settable 0-60 s.
  <https://developer.okta.com/docs/guides/refresh-tokens/main/>
- **Auth0** "refresh token reuse interval": accounts for network lag; up to 2,592,000 s (30 days). During the window
  breach detection does not apply and a **new** rotating refresh token is issued; only the previous token may be reused,
  exchanging the second-to-last one triggers breach detection.
  <https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-rotation>,
  <https://support.auth0.com/center/s/article/Refresh-token-leeway>
- Same symptom in another MCP server: FastMCP's OAuth proxy rotated refresh tokens with no grace period and lost
  sessions under concurrent `/token` requests (<https://github.com/PrefectHQ/fastmcp/issues/4901>).
- relic-bridge (ADR-0013) is narrower than both: the replay returns the **same** successor pair (no new token per
  reuse), only while that successor is still current, only for the same client, ≤ 120 s.
