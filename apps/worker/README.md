# @relic-bridge/worker

The Cloudflare Worker host for relic-bridge: the same HTTP app as `relic-bridge serve` (`@relic-bridge/http-app`),
with Workers bindings. Private package; it is deployed with Wrangler, not published to npm.

> **Status (Phase 3, in review; not released).** The Worker serves MCP, the admin API and `/health` on D1, with plan
> presets, rate limiting, the audit purge cron and a setup script. Deploy with `pnpm cf:setup` (see the
> [deployment guide](../../docs/guide/cloudflare-deploy.md); costs and limits: [Cloudflare limits](../../docs/guide/cloudflare-limits.md)).

## Bindings

| Binding | Kind | Purpose |
|---|---|---|
| `DB` | D1 | Storage (projects, grants, tokens, encrypted credentials, audit log). |
| `OAUTH_KV` | KV | Reserved, unused: OAuth provider state lives in D1 (ADR-0011). |
| `RATE_LIMITER` | Rate Limiting | Shared coarse rate-limit ceiling (P3-04); exact rules stay per isolate. |
| `RB_MASTER_KEY` | secret, required | Encrypts stored New Relic keys (`relic-bridge keys generate`). Back it up. |
| `RB_MASTER_KEY_PREVIOUS` | secret, optional | The previous master key while rotating ([runbook](../../docs/guide/cloudflare-deploy.md#rotate-the-master-key)). |
| `RB_FINGERPRINT_SECRET` | secret, optional | Required only with `RB_PASSTHROUGH=on` (`pnpm cf:setup --passthrough` generates it). |
| `RB_ADMIN_TOKEN` | secret | Enables the admin API (`/api/admin/v1`); 32-512 printable characters. |
| `RB_GOOGLE_CLIENT_SECRET`, `RB_GITHUB_CLIENT_SECRET`, `RB_OIDC_CLIENT_SECRET` | secret, optional | OAuth client secrets of the [sign-in providers](../../docs/guide/identity-providers.md) you enable. |

Secrets go through `wrangler secret put` (or `.dev.vars` locally), never `vars` and never D1. `wrangler.jsonc` holds no
account or resource ids: local dev uses local resources, and Wrangler's automatic provisioning creates D1/KV on the
first deploy.

## Settings (`vars`)

| Variable | Default | Meaning |
|---|---|---|
| `RB_PLAN` | `free` | Preset for the limits below: `free` (45 calls, 512 KiB, 5 in flight) or `paid` (1000 calls, 8 MiB, 5 in flight). See [Cloudflare limits](../../docs/guide/cloudflare-limits.md). |
| `RB_CALL_BUDGET` | per plan | NerdGraph calls per MCP request, 1-10000. Tools costing more are not offered. |
| `RB_MAX_RESPONSE_BYTES` | per plan | Ceiling for a NerdGraph response body (1 KiB-64 MiB); a project's own limit still applies, the smaller wins. |
| `RB_CONCURRENCY` | per plan | NerdGraph calls in flight per credential, 1-6 (Workers allows 6 simultaneous connections). |
| `RB_ALLOWED_HOSTS` | any | Comma-separated `Host` allowlist. Cloudflare only routes your hostnames to the Worker, so the DNS-rebinding check `serve` needs is off by default; set it to pin your hostnames. |
| `RB_ALLOWED_ORIGINS` | loopback | Hostnames browsers may send in `Origin`. |
| `RB_CORS_ORIGINS` | off | Full origins allowed by CORS. |
| `RB_ACCESS_CACHE_TTL` | `30` | Seconds a resolved token/grant stays cached per isolate (0-60, 0 disables). |
| `RB_QUERY_CACHE` | `memory` (free), `on` (paid) | NRQL query cache (P7-02): `on` = isolate memory plus the data center's Cache API (bodies encrypted with a master-key-derived key; each lookup or write counts as a subrequest and is skipped once half the request budget is spent), `memory` = isolate memory only, `off`. |
| `RB_QUERY_CACHE_TTL` | `30` | Seconds a result over a moving window is reused (0-300). |
| `RB_AUDIT`, `RB_AUDIT_NRQL`, `RB_AUDIT_CLIENT_IP` | `on`, `mask`, `on` | As for `serve`. Audit rows are written with `ctx.waitUntil`. |
| `RB_AUDIT_RETENTION_DAYS` | `90` | Days to keep audit rows (`0` = forever). An hourly cron trigger (`triggers.crons`) deletes older rows, in batches of 500 (up to 10,000 per run); a larger backlog is finished by the next run. |
| `RB_RATE_LIMIT` | `on` | `off` disables rate limiting (isolate buckets and the `RATE_LIMITER` binding). The binding's own limit (default 600 per 60 s per key) is set in `wrangler.jsonc`. |
| `RB_PASSTHROUGH` | `off` | `on` enables `/passthrough/mcp`; it needs `RB_FINGERPRINT_SECRET` and the `RATE_LIMITER` binding, otherwise the boot fails (503). |
| `RB_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. Logs go to Workers Logs, redacted. |
| `RB_PUBLIC_URL`, `RB_GOOGLE_CLIENT_ID`, `RB_GOOGLE_HOSTED_DOMAIN`, `RB_GITHUB_CLIENT_ID`, `RB_OIDC_*`, `RB_CF_ACCESS_TEAM`, `RB_CF_ACCESS_AUD`, `RB_LOGIN_*`, `RB_SESSION_IDLE_MINUTES`, `RB_SESSION_MAX_HOURS` | off | Admin sign-in (P4-01) and admin sessions (P4-02, default 30 min idle / 12 h): the admin panel is served at `/admin` when sign-in is on (P4-03, assets bundled, no static-assets binding). See the [identity providers guide](../../docs/guide/identity-providers.md) and [admin access](../../docs/guide/admin-access.md). A half-configured provider fails the boot. |

An invalid value (or a missing/wrong master key) fails closed: every request answers 503 and one log line names the
problem, never a secret value. Failed boots back off (5 s, then 15 s, then 60 s between attempts; a success resets it)
and requests meanwhile answer 503 with `Retry-After`.

## Behaviour on Workers

- **Per-isolate runtime.** The first request into an isolate builds the keyring (imported `CryptoKey`s), checks it
  against the stored key checks, and builds the app with its access cache and rate-limit buckets; later requests reuse
  them. Nothing request-specific is kept (THREAT_MODEL T21). The boot is single-flight: concurrent cold requests wait
  for one boot (one migration check and one set of key checks on D1). A waiter gives up after 3 s and boots itself, so
  a boot whose request was cancelled cannot hang the others.
- **Caches are per isolate.** An admin change (revoking a token, editing a grant) clears the access cache of the
  isolate that served the admin call only; other isolates pick it up within `RB_ACCESS_CACHE_TTL` (default 30 s).
- **Storage is D1** (`DB`). The schema is migrated by the Worker itself when an isolate boots (the same embedded,
  checksummed migrations as `relic-bridge serve`); there is no `wrangler d1 migrations apply` step. A database newer
  than the deployed build, or a failed migration, fails the boot closed (503) and the log names the error code.
- **Client address** for rate limits and audit rows: `CF-Connecting-IP` (set by Cloudflare; clients can't override it).

## Local development

```sh
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # then put real values in it (git ignores .dev.vars)
pnpm --filter @relic-bridge/worker dev                      # wrangler dev on http://localhost:8787
pnpm --filter @relic-bridge/worker build                    # bundle check (wrangler deploy --dry-run, no account)
pnpm test:workers                                           # tests inside workerd
```

`wrangler dev` keeps its local D1 database under `apps/worker/.wrangler/` (git-ignored); delete that folder to start
from an empty database. Deployment: [deployment guide](../../docs/guide/cloudflare-deploy.md) (`pnpm cf:setup`, which keeps provisioned ids in the git-ignored `wrangler.local.jsonc`, warns when it drifts from `wrangler.jsonc`, and gives each `--name` its own D1 database and Rate Limiting namespace).
