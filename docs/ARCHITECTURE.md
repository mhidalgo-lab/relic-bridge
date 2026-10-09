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
| `packages/admin-ui` | Admin panel UI (server-rendered Hono JSX + minimal static JS; see ADR-0004) | No inline scripts; strict CSP. |
| `apps/cli` | `relic-bridge` binary: `stdio` (default), `serve`, `init`, `doctor`, management commands | Node active LTS. |
| `apps/worker` | Cloudflare entry, bindings, wrangler config, deploy button | Workers runtime. |
| `apps/docs` | Documentation site (Phase 8) | Static. |

## 3. Deployment modes

| Mode | Storage | Client auth | Who it's for |
|---|---|---|---|
| **A. stdio, env vars** | none (env) | none (local process) | Fastest start: `npx relic-bridge` |
| **B. stdio, config file** | `yaml` (read-only; keys taken from env/keychain) | none | Several projects locally, no server |
| **C. Self-hosted HTTP** (`relic-bridge serve`, Docker) | `sqlite` | tokens → OAuth | Home server, VPS, company network |
| **D. Cloudflare Worker** | `d1` + KV (OAuth) | tokens → OAuth | Reachable from every device including phone; no server to run |
| **E. Pass-through** (optional flag on C/D) | none for credentials | client sends its NR key in a header | Shared public instance; the server stores no NR keys |

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
tools    = project.enabledTools ∩ grant.tools
accounts = credential.reachableAccounts ∩ project.allowedAccounts ∩ grant.accounts
key      = grant.credential ?? project.defaultCredential   (must exist, else 403)
```

- Tools a client may not use are **not listed** at all; the MCP server is built per request with only the allowed tools.
  Calls to them are rejected anyway, as defence in depth.
- Each device gets its own token or OAuth session, so losing a device means revoking one entry.
- **Bring-your-own-key** team pattern: each member's grant points at their own credential, which keeps NR RBAC
  and per-user concurrency (see RESEARCH §2).
- A token is bound to **one project** (its audience). Using it at another slug is rejected with 401.

### Data model (SQLite / D1)

| Table | Key columns |
|---|---|
| `users` | id, email, idp, idp_subject, role (`owner` \| `admin` \| `member`), disabled_at |
| `credentials` | id, owner_user_id, label, region, key_ciphertext, key_iv, key_version, nr_user_email, reachable_accounts (json), validated_at |
| `projects` | id, slug (unique), name, default_account_id, allowed_account_ids (json), enabled_tools (json), limits (json), default_credential_id |
| `grants` | id, project_id, user_id (nullable for service grants), credential_id (nullable → project default), tools (json), accounts (json), rate_limit (json), expires_at, revoked_at |
| `access_tokens` | id, grant_id, prefix, hash, label (device), created_at, expires_at, last_used_at, revoked_at |
| `oauth_*` | Managed by the OAuth server (KV on Workers; adapter on Node). Token props carry `grant_id` and audience. |
| `audit_log` | ts, user_id, grant_id, token_id/client_id, project_id, tool, nrql_redacted, accounts, status, duration_ms, inspected_count, error_code |
| `schema_migrations` | version, applied_at |

## 5. Request flow (remote MCP call)

1. `POST /p/{slug}/mcp` reaches the Hono app. Security headers, body-size limit, request id.
2. **Authenticate**: bearer token (hash lookup, constant-time compare) or OAuth access token (provider validation;
   audience must equal this slug's resource URL).
3. **Resolve grant**: effective tools, accounts and credential (isolate cache ≤ 60 s).
4. **Rate limit**: per grant/token (Workers Rate Limiting binding or in-memory on Node).
5. **Build MCP server**: `createMcpHandler(factory, { legacy: 'stateless' })`. The factory registers only allowed tools,
   with a `ToolContext { credential, accounts, budget, limiter, limits, logger }`.
6. **Tool execution** in core:
   - validate input (JSON Schema)
   - build NRQL with escaped values
   - apply query limits
   - NerdGraph call(s) with explicit timeout and backoff on 429
   - async polling within budget
7. **Shape output**: format, caps, truncation notice, "untrusted telemetry" envelope.
8. **Audit**: write a redacted record (async, `waitUntil` on Workers).

## 6. Cross-cutting concerns

- **Budget**: per-invocation counter of subrequests (D1/KV/fetch), configured by `RB_PLAN` (`free` = 50, `paid` = 1000)
  or explicit numbers. Tools declare an expected cost and check `budget.canSpend(n)`.
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
- **Observability**: structured JSON logs (redacted); optional OpenTelemetry export (Phase 7).
- **Configuration**: env vars with the `RB_` prefix plus the storage-backed settings. A config schema is validated at boot.

## 7. Tool catalogue (target)

| Group | Tools | Phase |
|---|---|---|
| Query | `run_nrql`, `get_query_result` | 1 |
| Discovery | `whoami`, `list_accounts`, `search_entities`, `get_entity`, `get_related_entities`, `list_entity_types`, `list_event_types`, `get_attributes`, `time_range` | 1 |
| Health | `get_golden_metrics` | 1 |
| Alerting | `list_alert_policies`, `list_alert_conditions`, `list_recent_issues`, `search_incidents`, `list_synthetic_monitors` | 6 |
| Incident response | `list_error_groups`, `list_change_events`, `analyze_deployment_impact` | 6 |
| Performance | `analyze_transactions`, `list_top_transactions`, `list_recent_logs`, `analyze_entity_logs`, `analyze_threads`, `list_gc_metrics`, `analyze_kafka_metrics` | 6 |
| Dashboards | `list_dashboards`, `get_dashboard` | 6 |
| Reports | `generate_alert_insights_report`, `generate_user_impact_report` | 6 |
| Write (opt-in) | `acknowledge_issue`, `close_issue`, `create_change_event`, `create_dashboard` | 7 |

Plus MCP **prompts** (investigation workflows) and **resources** (NRQL reference, per-project schema snapshot) in Phase 6,
and **MCP Apps** charts in Phase 7.

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
