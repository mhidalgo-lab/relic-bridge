# @relic-bridge/worker

The Cloudflare Worker host for relic-bridge: the same HTTP app as `relic-bridge serve` (`@relic-bridge/http-app`),
with Workers bindings. Private package; it is deployed with Wrangler, not published to npm.

> **Status (Phase 3, in progress).** The entry, bindings and per-isolate runtime are in place (P3-01). The D1 storage
> adapter lands in P3-02: until then every route answers `503 {"error":"unavailable"}` and the log says
> `the D1 storage adapter is not available yet (P3-02)`. The deployment guide comes with P3-05/P3-07.

## Bindings

| Binding | Kind | Purpose |
|---|---|---|
| `DB` | D1 | Storage (projects, grants, tokens, encrypted credentials, audit log). |
| `OAUTH_KV` | KV | OAuth provider state (Phase 5). |
| `RATE_LIMITER` | Rate Limiting | Shared rate-limit store (P3-04). Until then buckets are per isolate. |
| `RB_MASTER_KEY` | secret, required | Encrypts stored New Relic keys (`relic-bridge keys generate`). Back it up. |
| `RB_MASTER_KEY_PREVIOUS` | secret, optional | The previous master key while rotating. |
| `RB_ADMIN_TOKEN` | secret | Enables the admin API (`/api/admin/v1`); 32-512 printable characters. |

Secrets go through `wrangler secret put` (or `.dev.vars` locally), never `vars` and never D1. `wrangler.jsonc` holds no
account or resource ids: local dev uses local resources, and Wrangler's automatic provisioning creates D1/KV on the
first deploy.

## Settings (`vars`)

| Variable | Default | Meaning |
|---|---|---|
| `RB_PLAN` | `free` | NerdGraph calls per MCP request: `free` = 50, `paid` = 1000 (ADR-0010; P3-03 adds the other presets). |
| `RB_ALLOWED_HOSTS` | any | Comma-separated `Host` allowlist. Cloudflare only routes your hostnames to the Worker, so the DNS-rebinding check `serve` needs is off by default; set it to pin your hostnames. |
| `RB_ALLOWED_ORIGINS` | loopback | Hostnames browsers may send in `Origin`. |
| `RB_CORS_ORIGINS` | off | Full origins allowed by CORS. |
| `RB_ACCESS_CACHE_TTL` | `30` | Seconds a resolved token/grant stays cached per isolate (0-60, 0 disables). |
| `RB_AUDIT`, `RB_AUDIT_NRQL`, `RB_AUDIT_CLIENT_IP` | `on`, `mask`, `on` | As for `serve`. Audit rows are written with `ctx.waitUntil`. |
| `RB_RATE_LIMIT` | `on` | `off` disables rate limiting. Per-rule tuning comes with P3-04. |
| `RB_PASSTHROUGH` | `off` | `on` is refused until P3-04 (pass-through needs a fingerprint secret and a limiter shared by all isolates). |
| `RB_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. Logs go to Workers Logs, redacted. |

An invalid value (or a missing/wrong master key) fails closed: every request answers 503 and one log line names the
problem, never a secret value. The Worker retries the boot after 5 seconds.

## Behaviour on Workers

- **Per-isolate runtime.** The first request into an isolate builds the keyring (imported `CryptoKey`s), checks it
  against the stored key checks, and builds the app with its access cache and rate-limit buckets; later requests reuse
  them. Nothing request-specific is kept (THREAT_MODEL T21).
- **Caches are per isolate.** An admin change (revoking a token, editing a grant) clears the access cache of the
  isolate that served the admin call only; other isolates pick it up within `RB_ACCESS_CACHE_TTL` (default 30 s).
- **Client address** for rate limits and audit rows: `CF-Connecting-IP` (set by Cloudflare; clients can't override it).

## Local development

```sh
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # then put real values in it (git ignores .dev.vars)
pnpm --filter @relic-bridge/worker dev                      # wrangler dev on http://localhost:8787
pnpm --filter @relic-bridge/worker build                    # bundle check (wrangler deploy --dry-run, no account)
pnpm test:workers                                           # tests inside workerd
```

Deployment (D1 migrations, secrets, custom domain) is documented with P3-05/P3-07; before P3-02 a deployed Worker
only answers 503.
