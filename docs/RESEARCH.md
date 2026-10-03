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
| Subrequests / request | **50 external** + 1,000 to Cloudflare services | 10,000 (configurable up to 10 M via `limits.subrequests`) | **Changed 2026-02-11:** on Free, `fetch` to the Internet (every NerdGraph call and async poll) counts against the 50; D1, KV and other Cloudflare services count against a separate 1,000. Each redirect hop counts. The old assumption "D1 lookups eat the 50" no longer holds, so the access-resolve cost (one D1 batch call + a throttled write on a miss since P3-09) does not touch the NerdGraph budget. |
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

## 6b. npm publishing (P1-15)

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

