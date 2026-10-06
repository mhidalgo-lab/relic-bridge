# Architecture

> Status: **design draft** (2026-10-01). Decisions are recorded in [`adr/`](adr/); verified platform
> facts are in [`RESEARCH.md`](RESEARCH.md).

## 1. Goals and non-goals

**Goals**

1. Let AI coding agents query New Relic through NerdGraph using only a **User API key**, with no account-level MCP enablement.
2. Run **anywhere**:
   - local stdio (no account, no database)
   - self-hosted Node or Docker
   - a Cloudflare Worker reachable from every device (laptop, PC, W365, phone)
3. Serve **multiple projects** (NR account + region + key) from one deployment, each at its own URL.
4. A fine-grained **access model**: which NR key a client uses, which accounts and tools it may use, and limits.
5. Treat security as a feature: read-only by default, encrypted secrets, audit log, documented threat model.

**Non-goals (for 1.0)**

- Replacing New Relic's UI or official MCP server feature-for-feature on AI-generated insights. Combined reports are
  built by chaining queries and let the agent do the reasoning.
- Write/mutation operations by default. They're opt-in only, in Phase 7.
- Multi-tenant SaaS hosting for strangers. relic-bridge is software you self-host (personal or team).

## 2. Component overview

```
                 ┌─────────────── MCP clients ────────────────┐
                 │ Claude Code · Desktop · claude.ai · mobile │
                 │ Cursor · VS Code · MCP Inspector           │
                 └───────┬───────────────────────┬────────────┘
                     stdio│                  HTTPS│ /p/{slug}/mcp
                 ┌───────▼──────┐   ┌────────────▼────────────────────────────┐
                 │  apps/cli    │   │ packages/http-app  (Hono)               │
                 │  (stdio)     │   │  /p/:slug/mcp   /admin  /api/admin      │
                 │              │   │  /oauth/*  /.well-known/*  /health      │
                 └───────┬──────┘   └──────┬─────────────────┬────────────────┘
                         │                 │ authn/authz      │
                         │          ┌──────▼──────┐   ┌──────▼──────┐
                         │          │ packages/   │   │ packages/   │
                         │          │ auth        │   │ admin-ui    │
                         │          └──────┬──────┘   └─────────────┘
                 ┌───────▼─────────────────▼───────────────────────────┐
                 │ packages/core                                         │
                 │  tool registry · NerdGraph client · NRQL engine       │
                 │  query limits · output shaping · budget · limiter     │
                 └───────┬───────────────────────────────┬─────────────┘
                         │                               │
                 ┌───────▼──────────┐          ┌─────────▼───────────┐
                 │ packages/storage │          │ NerdGraph (US/EU)   │
                 │ yaml │ sqlite │ d1│          │ api.newrelic.com    │
                 └──────────────────┘          └─────────────────────┘
   Hosts:  apps/cli (Node, stdio + `serve`) · apps/worker (Cloudflare) · Docker image (Node)
```

### Packages

| Package | Responsibility | Runtime constraints |
|---|---|---|
| `packages/core` | Tool definitions, NerdGraph client, NRQL engine (sync/async), query limits, output shaping, subrequest budget, concurrency limiter, error model | **Web-standard APIs only** (`fetch`, WebCrypto, `URL`, streams). A lint rule bans `node:*` imports. |
| `packages/storage` | `Storage` interface, Drizzle schema, migrations; adapters: `yaml` (read-only, stdio), `sqlite` (Node), `d1` (Workers) | Adapters are the only runtime-specific code. |
| `packages/auth` | Token hashing and verification, grant resolution, identity providers (Google, GitHub, Cloudflare Access, generic OIDC), admin sessions, OAuth 2.1 server integration | WebCrypto only. |
| `packages/http-app` | Hono app: routing, middleware (security headers, auth, rate limit, audit), MCP handler per project, admin REST API | Runs under Workers and `@hono/node-server`. |
| `packages/admin-ui` | Admin panel UI (server-rendered Hono JSX + minimal static JS; see ADR-0004): layout, components, page/form kit, hashed assets; mounted at `/admin` by `http-app` | No inline scripts or styles; strict CSP; auto-escaping only. |
| `apps/cli` | `relic-bridge` binary: `stdio` (default), `serve`, `init`, `doctor`, management commands | Node active LTS. |
| `apps/worker` | Cloudflare entry, bindings, wrangler config, deploy button | Workers runtime. |
| `apps/docs` | Documentation site (Phase 8) | Static. |

## 3. Deployment modes

| Mode | Storage | Client auth | Who it's for |
|---|---|---|---|
| **A. stdio, env vars** | none (env) | none (local process) | Fastest start: `npx relic-bridge` |
| **B. stdio, config file** | `yaml` (read-only; keys taken from env/keychain) | none | Several projects locally, no server |
| **C. Self-hosted HTTP** (`relic-bridge serve`, Docker) | `sqlite` | tokens → OAuth | Home server, VPS, company network |
| **D. Cloudflare Worker** | `d1` (OAuth state too, ADR-0011) | tokens → OAuth | Reachable from every device including phone; no server to run |
| **E. Pass-through** (optional flag on C/D, off by default) | none for credentials | client sends its NR key in `X-NewRelic-Api-Key` on `/passthrough/mcp` (P2-15) | Shared instance; the server stores no NR keys |

Mode D is the main remote target. C and D share all code except the storage adapter and entry point.

## 4. Access model

```
User (identity via Google / GitHub / Cloudflare Access / OIDC)
 │ owns
 ▼
Credential  ── NR User key (encrypted) + region + label; validated → NR user email, reachable accounts
 │
 │ referenced by
 ▼
Project  ── slug (URL), name, default account, allowed accounts, enabled tools (upper limit),
 │           query limits, default credential (optional)
 │
 │ has many
 ▼
Grant  ── who (user or service) × which project × which credential × tool allowlist
 │         × account allowlist × rate limits × expiry
 │ authenticated by
 ▼
Access token (static bearer, per device)   or   OAuth client session (per device/app)
```

**Effective permissions for a request**

```
tools    = project.enabledTools ∩ grant.tools               (write tools: only when both name them explicitly and the key
                                                            is shared or the grant user's own; OAuth also needs mcp:write)
accounts = credential.reachableAccounts ∩ project.allowedAccounts ∩ grant.accounts
key      = grant.credential ?? project.defaultCredential   (must exist, else 403)
limits   = project.limits tightened by grant.limits        (min of numbers, rawNrql AND, allow ∩, deny ∪)
```

Implemented by the pure resolver in `packages/auth/src/access` (P2-04): anything missing, disabled, revoked, expired,
unvalidated or malformed denies, and a grant may only use the project's default credential, a shared (unowned) one or
its own user's. Details and examples: [access model guide](guide/access-model.md).

- Tools a client may not use are **not listed** at all; the MCP server is built per request with only the allowed tools.
  Calls to them are rejected anyway, as defence in depth.
- Each device gets its own token or OAuth session, so losing a device means revoking one entry. Static tokens
  (`packages/auth/src/tokens`, P2-05) are `rb_<env>_<43 base62, 256-bit>_<CRC-32 in 6 base62>`; the checksum is
  checked before any storage read, then the SHA-256 is looked up and compared in constant time, then revocation and
  expiry; `last_used_at` is written at most once per 5 minutes.
- **Bring-your-own-key** team pattern: each member's grant points at their own credential, which keeps NR RBAC
  and per-user concurrency (see RESEARCH §2).
- A token is bound to **one project** (its audience). Using it at another slug is rejected with 401.

### Data model (SQLite / D1)

Source of truth: `packages/storage/src/schema.ts` (Drizzle, SQLite dialect); migrations in `packages/storage/migrations`.
Times are epoch milliseconds, ids are caller-generated text, lists/objects are JSON text. See [`dev/storage.md`](dev/storage.md).

| Table | Key columns |
|---|---|
| `users` | id, email (lowercase, unique), display_name, idp + idp_subject (unique), role (`owner` \| `admin` \| `member`), created_at, updated_at, disabled_at |
| `credentials` | id, owner_user_id, label, region, key_ciphertext, key_iv, key_version, key_hint (last 4), validation_status (`unvalidated` \| `valid` \| `invalid`), validation_error_code, validated_at, nr_user_id, nr_user_email, reachable_account_ids (json), created_at, updated_at, revoked_at |
| `projects` | id, slug (unique), name, default_account_id, allowed_account_ids (json), enabled_tools (json, null = all), limits (json), default_credential_id, created_at, updated_at, disabled_at |
| `grants` | id, project_id, user_id (null for service grants, which need a label), label, credential_id (null → project default), tools (json, null = project's), account_ids (json, null = project's), limits (json, tightening), rate_limit (json), created_at, updated_at, expires_at, revoked_at |
| `access_tokens` | id, grant_id, prefix, token_hash (SHA-256 hex, unique), label (device), created_at, expires_at, last_used_at, revoked_at |
| `oauth_*` | No tables: the OAuth provider's clients, grants and tokens are `kv` rows under `oauth:` on every runtime (ADR-0011). Token props (encrypted by the provider) carry `grantId`, `projectSlug`, `userId`, `clientId`; the audience is the slug's resource URL. |
| `audit_log` | id, ts, kind (`tool_call` \| `auth` \| `admin`), action, status (`ok` \| `error` \| `denied`), request_id, user_id, grant_id, token_id, key_id (pass-through key fingerprint `pt_…`), client_id, project_id, account_ids, nrql (masked), duration_ms, inspected_count, error_code, target_type, target_id, details (json). No foreign keys. |
| `settings` | key, value (json), updated_at |
| `kv` | key, value, expires_at — Workers-KV-compatible store for the OAuth provider on Node and Workers (`oauth:…`, ADR-0011) and its single-use code markers (`oauth-code:<sha256(code)>`, consumed with `take`, P5-01), cached client metadata documents (`oauth:client:<url>`, P5-03) and the dynamic registration cap counter (`oauth-dcr-count:<window>`, atomic `increment`, P5-03); also sign-in transactions (`login:<sha256(state)>`) and setup links (`setup:<sha256(code)>`) on every runtime, consumed atomically with `take` (P4-01) |
| `schema_migrations` | version, name, checksum, applied_at (owned by the migration runner) |

Deleting a project removes its grants and their tokens; deleting a grant removes its tokens; a credential that a
project or grant still references can't be deleted (revoke it instead).

## 5. Request flow (remote MCP call)

Implemented by `createHttpApp` in `packages/http-app` (P2-06); `relic-bridge serve` hosts it on Node.

1. `POST /p/{slug}/mcp` reaches the Hono app: request id, security headers (on every response), `Host` / `Origin`
   allowlists (DNS rebinding, T24), CORS only when configured, declared body size ≤ 1 MiB.
   *Optional public discovery (P7-14, `RB_PUBLIC_TOOL_CATALOG=on`, off by default):* after the per-IP limit and
   before step 2, a POST with no `Authorization` header whose body asks only for `initialize`, `server/discover`,
   `ping` or `tools/list` is answered by a second MCP handler holding the static read-only catalog and no context, the
   same for every slug (no storage read); anything else continues to step 2 and gets the usual 401.
2. **Authenticate**: bearer token (format and checksum offline, then hash lookup, constant-time compare, revoked,
   expired) or, with OAuth on (P5-01), a provider-issued access token: validated for this slug's resource only
   (RFC 8707 audience), props cross-checked (slug, user, client), then its grant goes through the same `resolveAccess`
   as a device token's grant (see [`dev/oauth.md`](dev/oauth.md)). The token is checked before the slug is looked at.
3. **Resolve grant**: effective tools, accounts, limits and credential (`resolveAccess`; steps 2-3 together are
   `authenticateAccess`, one storage call on SQL storage — one D1 `batch()` on Workers, P3-09), cached per isolate for
   0-60 s (default 30 s), never past the token's or grant's expiry, keyed by token hash + slug, holding no plaintext
   key. Every denial in steps 2-3 is the same 401 (with OAuth on, its `WWW-Authenticate` names the slug's RFC 9728
   metadata, built from the path alone, P5-02); storage errors are 503.
4. **Rate limit** (P2-07, `createRateLimitHooks` over a pluggable `RateLimiter`; bounded in-memory token bucket on
   Node; on Workers `WorkersRateLimiter` = per-isolate bucket plus the Rate Limiting binding as shared backstop, the auth-failure throttle per isolate (P3-04); with `RB_SHARED_LIMITER` the `SharedLimiter` Durable Object counts `fail:`/`signin:`/`oauth:`/`write:` for the whole deployment and, with `on`, NerdGraph concurrency per credential (P7-10)). Before step 2 (`beforeAuth`): per-IP request limit (and,
   on the pass-through route only, the per-IP auth-failure throttle, before a key is sent to NerdGraph). On a failed
   authentication (`refuseAuthFailure`, P3-13) the failure is charged to the IP and, past the budget, answered 429
   instead of 401; a credential that verifies never reaches it, so valid tokens are not locked out.
   After step 3 (`beforeMcp`): per token and per grant (the grant's `rateLimit` wins). 429 + `Retry-After`.
   `subscriptions/listen` is flagged so it isn't counted as a tool call.
5. **Build MCP server**: one `createMcpHandler(factory, { legacy: 'stateless' })` per app; the per-request scope
   (granted tool definitions + `ToolContext { credential (decrypted for this request), accounts, budget, limiter,
   limits, connection, logger }`) travels in `authInfo.extra`. The factory registers only allowed tools and
   advertises `tools.listChanged: false`, so a `subscriptions/listen` is acknowledged and closed at once.
6. **Tool execution** in core:
   - validate input (JSON Schema)
   - build NRQL with escaped values
   - apply query limits
   - NerdGraph call(s) with explicit timeout and backoff on 429
   - async polling within budget
   - with the MCP Tasks extension (P7-13): a client that declared `io.modelcontextprotocol/tasks` on a 2026-07-28
     `tools/call` gets a task handle (`resultType: "task"`) for a slow `run_nrql` instead of the `queryId` text. The
     task is a sealed `kv` record (key = hash of the 256-bit id, AES-GCM under a key derived from the id, AAD = project,
     grant, token / OAuth device; 15 min TTL). `tasks/get` / `tasks/update` / `tasks/cancel` are answered by the route
     itself after steps 2-4 (the SDK has no Tasks runtime): each `tasks/get` does at most one NerdGraph poll, within
     that request's budget, limits and quota, and only once the task's poll interval has passed. Nothing runs after
     a response.
7. **Shape output**: format, caps, truncation notice, "untrusted telemetry" envelope. The whole exchange, including a
   streamed response, is bounded by a request deadline (180 s).
8. **Audit** (P2-08, `createAuditRecorder` hooks, each write run in the background, `waitUntil` on Workers): one row per
   tool call (`onToolCall`, fed by `buildMcpServer`'s observer), per refusal (`onAuthFailure`, `onRejected`) and per
   ungranted tool (`afterMcp`); admin actions call `recorder.admin(...)`. A failed write is logged, never surfaced.

### Admin API (P2-09)

`/api/admin/v1/*` (`packages/http-app/src/admin`, `@hono/zod-openapi`) is mounted by `createHttpApp` when an admin
token or sign-in is configured. Its own middleware runs after the shared request id, security headers and Host/Origin
checks: declared body size → `beforeAuth` hooks (per-IP limits) → principal: with an `Authorization` header the
bootstrap admin token only (digest compare; role `owner`; cookies ignored), otherwise the admin session cookie
(P4-02) — failures of either go to `onAuthFailure`, so they are throttled and audited like MCP failures → for
sessions: `Sec-Fetch-Site` / `Origin` = public URL / `X-CSRF-Token` on unsafe methods, then the route's least role
(`requiredRole`), `403 forbidden` audited as `admin.forbidden` → JSON content type and streamed body cap →
strict zod validation → handler. Handlers call the same domain services as the CLI (`createCredential`,
`rotateCredentialKey`, `revalidateCredential`, `createProject`, `updateProject`, `createGrant`, `issueAccessToken`,
`revokeAccessToken`), write one `admin` audit row per change (in the background) and clear the access cache. The
OpenAPI 3.1 document is generated from the route schemas and served at `/api/admin/v1/openapi.json`;
`docs/reference/admin-api.md` is generated from it.

### Admin sessions (P4-02)

`packages/auth/src/identity/session.ts` keeps sessions in storage `kv`: `sess:<userId>:<sha256(secret)>` (user,
provider, created/absolute expiry, CSRF token) and `sess-seen:<userId>:<hash>` (last activity, touched at most once a
minute, so a touch racing a logout can only recreate a worthless row). The cookie (`__Host-rb_session`, `rb_session`
on http loopback; HttpOnly, Secure, SameSite=Lax, Path=/) carries `<userId>.<secret>`; revoke-all lists the user's
prefix. `packages/http-app/src/session.ts` (`createSessionManager`, built by `createHttpApp` when sign-in is on) is the
default `onLogin` (end the browser's previous session, create one, 303 to `next`), authenticates cookie requests (session
row + user record, ≤ 5 s per-isolate user cache cleared by admin changes; role read per request), and serves
`POST /auth/logout`. Role changes and disables end the user's sessions (`session.revoke_all`). Guide:
[admin access](guide/admin-access.md).

### Admin UI (P4-03)

`packages/admin-ui` (web-standard, Hono JSX) renders the panel. `createAdminUi(deps)` is a Hono sub-app that
`createHttpApp` mounts at `/admin` when sign-in is configured. The deps (`AdminUiDeps`) come from the P4-02 session
manager, so `admin-ui` does not depend on `http-app`. Pages: `kit.page` (fetch metadata: same-origin, `none` or a
cross-site top-level navigation only → per-IP hook (`admin_session` scope) → session → role) and forms: `kit.form`
(Origin / fetch metadata → urlencoded, 16 KiB → `_csrf` token → role). Data and changes go through `kit.callAdmin`, which
runs the request against the app itself (`app.fetch` with the same env and execution context): it carries the session
cookie, the CSRF token, the public origin and the client-address headers, so the admin API's validation, roles and
audit apply unchanged. Unsafe calls need the request's `VerifiedForm`. Rendering is synchronous JSX to a string with
auto-escaping only (`scripts/check-ui-escaping.ts`). One stylesheet and one script are compiled into the bundle
(`assets.generated.ts`, content-hashed names, SRI). They are served from `/admin/assets/*` with `immutable` caching, the
same way on Node and Workers. The security middleware keeps the page CSP (`UI_CSP`) and the asset cache header when a
response carries exactly those values, and replaces anything else. The sign-in pages (`/auth/*`) render with the same
layout and CSP. Conventions: [`dev/admin-ui.md`](dev/admin-ui.md).

### Admin sign-in (P4-01)

`packages/auth/src/identity` (web-standard, `jose` on WebCrypto) defines `IdentityProvider`: **redirect** providers
(generic OIDC by discovery, Google = OIDC preset with the `hd` check, GitHub = OAuth app + REST API) and the **header**
provider (Cloudflare Access, `Cf-Access-Jwt-Assertion` verified against the team JWKS and AUD). Each yields a
`VerifiedIdentity { idp, subject, email (verified, lowercase), displayName, orgs? }` or a stable `IdentityError` code.
`identitySettingsFromEnv` reads the `RB_*` variables for both `serve` and the Worker.

`packages/http-app/src/identity.ts` mounts `/auth/*` only when providers are configured:
`GET /auth/login` (chooser) → `GET /auth/login/:provider` (transaction in storage `kv` keyed by SHA-256(state): PKCE
verifier, nonce, provider, target path, setup-link hash, SHA-256 of the browser binding cookie; 10 min TTL; 302 to the
IdP) → `GET /auth/callback/:provider` (transaction consumed once with `kv.take`; binding cookie and provider must match;
code exchanged; ID token verified) or `GET /auth/cf-access` → setup link consumed (if any) → `resolveLoginUser`
(existing binding → bind an unbound user by verified email → allowlist + auto-provisioning; email never moves an
account between identities; deny by default) → audit `login.ok` / `login.denied` → `onLogin(c, CompletedLogin)`, the
seam `createHttpApp` fills with the admin session (P4-02). `POST /api/admin/v1/setup-links` (admin token) issues the single-use owner
bootstrap link. Guide: [identity providers](guide/identity-providers.md).

### Management CLI (P2-10)

`apps/cli/src/manage` implements `init`, `admin-token`, `user|credential|project|grant|token` and `audit tail` once,
against an `AdminClient` (`call(method, path, {query, body})`). Two transports: `remoteClient` (`fetch` to
`/api/admin/v1`, https only, `redirect: 'error'`) and `openLocalClient`, which mounts `createAdminApi` in-process over
`openSqliteStorage` with a per-process random bearer, so local and remote share validation, rule refusals, masking and
audit (local rows carry `via: cli` and the OS user). Secrets are read only from a hidden prompt, stdin, a file or an
environment variable (`secrets.ts`); the node-only terminal pieces live in `host.ts` behind the `ManageHost` interface.

## 6. Cross-cutting concerns

- **Budget**: per-invocation counter of NerdGraph calls (external `fetch`; D1/KV have their own larger Workers allowance),
  configured by `RB_PLAN` (`free` = 45, `paid` = 1000) or `RB_CALL_BUDGET`. Tools declare an expected cost and check
  `budget.canSpend(n)`; a tool whose cost exceeds the budget is not registered.
  Cost rule (P6-20): every NRQL counts as 2 requests (`NRQL_COST`: async submit + one poll, or the async attempt + the sync
  fallback), an entity name adds up to 4 (`RESOLVE_COST`), retries are not counted (they follow a failure and each attempt
  spends a unit, so the budget still caps them). Composites plan in these units and degrade to a partial result;
  `tool-costs.test.ts` forces the worst case on every tool and asserts requests ≤ declared cost. `RB_MAX_RESPONSE_BYTES` is a platform ceiling over each project's `maxResponseBytes`.
- **Query cache** (P7-02, [guide](guide/query-cache.md)): NRQL results are reused for a short TTL (moving windows 30 s,
  settled fixed windows 10 min) from a bounded in-memory LRU (stdio, `serve`, Worker isolates) and, on Workers with
  `RB_QUERY_CACHE=on`, the per-colo Cache API (encrypted bodies). Entry ids are HMACs over the connection scope,
  credential, key hash, accounts, query limits and normalized NRQL (THREAT_MODEL T16); lookups happen after account and
  limit checks. The cache is owned by the runtime and passed in `ToolContext.queryCache`.
- **Concurrency**: per-credential semaphore (default 5) inside an invocation and process; ≤ 6 on Workers. Optional
  Durable Object global limiter (Phase 7).
- **Query limits** (per project, can be tightened per grant):
  - max `LIMIT`; inject a `LIMIT` when missing
  - max time window
  - event-type allow/deny lists
  - raw NRQL on/off
  - max response bytes
- **Output contract**: every tool returns a short human summary plus a structured result (`structuredContent` with an
  output schema where useful), plus `meta` (accounts, NRQL actually run, inspected count, truncated flag, NR UI link
  when available) under `_meta["relic-bridge/result"]`. Data is capped and wrapped in an untrusted-data envelope
  (`packages/core/src/output`, [output formats guide](guide/output-formats.md)).
- **Errors**: stable error codes (`RB_AUTH_*`, `RB_LIMIT_*`, `RB_NERDGRAPH_*`, `RB_BUDGET_EXHAUSTED`, …), mapped to
  MCP tool errors with actionable messages for the agent. Secrets are never echoed.
- **Observability**: structured JSON logs (redacted); optional OTLP/HTTP self-monitoring export, off by default (P7-08, `docs/guide/observability.md`).
- **Configuration**: env vars with the `RB_` prefix plus the storage-backed settings. A config schema is validated at boot.

## 7. Tool catalogue (target)

| Group | Tools | Phase |
|---|---|---|
| Query | `run_nrql`, `get_query_result` | 1 |
| Discovery | `whoami`, `list_accounts`, `search_entities`, `resolve_entity`, `get_entity`, `get_related_entities`, `list_entity_types`, `decode_entity_guid`, `list_event_types`, `get_attributes`, `time_range` | 1 |
| Health | `get_golden_metrics` | 1 |
| Alerting | `list_alert_policies` (done), `list_alert_conditions` (done), `list_recent_issues` (done), `search_incidents` (done), `list_synthetic_monitors` (done) | 6 |
| Incident response | `list_error_groups` (done), `list_change_events` (done), `analyze_deployment_impact` (done) | 6 |
| Performance | `analyze_transactions` (done), `list_top_transactions` (done), `list_recent_logs` (done), `analyze_entity_logs` (done), `analyze_threads` (done), `list_gc_metrics` (done), `analyze_kafka_metrics` (done) | 6 |
| Dashboards | `list_dashboards` (done), `get_dashboard` (done) | 6 |
| Reports | `generate_alert_insights_report` (done), `generate_user_impact_report` (done) | 6 |
| Investigations | `trace_error` (done), `dependency_health` (done), `entity_health` (done) | 6 |
| Write (opt-in) | `acknowledge_issue`, `close_issue`, `create_change_event`, `create_dashboard` | 7 |

Plus MCP **prompts** (seven investigation workflows, P6-11, `packages/core/src/prompts.ts`, reference in `docs/reference/prompts.md`; registered by `buildMcpServer` only when a tool they use is in the connection's allowed list) and **resources** (P6-12, `packages/core/src/resources.ts`, reference in `docs/reference/resources.md`: a static NRQL cheat sheet and per-account event-type and attribute snapshots, served by the `list_event_types` / `get_attributes` handlers so account checks, limits, cache and audit are the tools' own; registered only when that tool is allowed),
and **MCP Apps** charts (P7-04, `packages/core/src/apps`, [guide](guide/charts.md)): one `ui://relic-bridge/nrql-chart`
resource (`text/html;profile=mcp-app`, offered with `run_nrql` to clients that declare MCP Apps, P7-16; `RB_MCP_APPS=off` removes it) linked from `run_nrql` / `get_query_result` by
`_meta.ui.resourceUri`. The view is a dependency-free page (`packages/core/assets/chart-app.*`, embedded at build time by
`scripts/gen-app-assets.ts`) that draws the tool's `structuredContent` as SVG inside the host's sandboxed iframe; tool
results themselves are unchanged, so other clients fall back to the text table.

## 8. Repository layout (target)

```
relic-bridge/
  apps/{cli,worker,docs}/
  packages/{core,storage,auth,http-app,admin-ui}/
  docs/{ARCHITECTURE,RESEARCH,ROADMAP,THREAT_MODEL}.md
  docs/adr/NNNN-*.md
  docs/tasks/phase-N-*/PN-NN-*.md
  scripts/            task tooling, release helpers
  AGENTS.md  CLAUDE.md  README.md  LICENSE  NOTICE  SECURITY.md  CONTRIBUTING.md
```
