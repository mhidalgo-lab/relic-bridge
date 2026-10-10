---
id: P3-01
title: Cloudflare Worker entry and bindings
phase: 3
status: done
priority: high
depends_on: [P2-13]
adr: [0004, 0005]
owner: "claude-agent"
---

# P3-01 — Cloudflare Worker entry and bindings

## Goal
`apps/worker` serves the shared Hono app (`createHttpApp`) on Cloudflare Workers with the right bindings, secrets and
per-isolate caches, so P3-02 (D1) and P3-04 (rate limiting) only have to plug their adapters into a working entry.

## Scope
- `apps/worker/src`: `createWorker(options)` (testable factory) and the default `{ fetch }` export built from it.
- Typed bindings (`WorkerEnv`): `DB` (D1), `OAUTH_KV` (KV, used in P5), `RATE_LIMITER` (Rate Limiting binding, used
  in P3-04), secrets `RB_MASTER_KEY` (required), `RB_MASTER_KEY_PREVIOUS` (rotation), `RB_ADMIN_TOKEN`.
- **Storage seam**: `openStorage(env)` option. The default refuses with a logged `storage_unavailable` (503) until
  P3-02 supplies the D1 adapter; tests inject the in-memory adapter.
- `apps/worker/wrangler.jsonc` without account or resource ids (Wrangler's automatic provisioning fills them on deploy;
  local dev uses local resources), current `compatibility_date`, **no `nodejs_compat`** (nothing needs it).
  `.dev.vars.example` for local secrets.
- Per-isolate runtime, built lazily on the first request and cached: keyring from the secret bindings
  (`loadKeyringFromEnv` + `verifyKeyChecks`, so imported `CryptoKey`s live per isolate), the access cache
  (`RB_ACCESS_CACHE_TTL`), the app. A failed boot is not cached (retried after 5 s) and answers 503 without detail.
- Request plumbing: `waitUntil` = `ctx.waitUntil` (audit writes), client IP from `CF-Connecting-IP`, NerdGraph call
  budget from `RB_PLAN` (`free` = 50 default, `paid` = 1000; ADR-0010 provisional presets, finalised in P3-03).
- Worker settings from `vars`: `RB_PLAN`, `RB_ALLOWED_HOSTS`, `RB_ALLOWED_ORIGINS`, `RB_CORS_ORIGINS`,
  `RB_ACCESS_CACHE_TTL`, `RB_AUDIT`, `RB_AUDIT_NRQL`, `RB_AUDIT_CLIENT_IP`, `RB_RATE_LIMIT`, `RB_LOG_LEVEL`. Invalid
  values fail closed (503 + one log line naming the variable).
- Rate limiting: the existing per-isolate `MemoryRateLimiter` hooks as the interim/fallback limiter (P3-04 adds the
  binding-backed one).

## Acceptance criteria
- [x] Workers-runtime test (`@cloudflare/vitest-plugin`, workerd): MCP `initialize` + `tools/list` with a device token
      through the Worker's `fetch`; wrong token → 401.
- [x] Missing/invalid `RB_MASTER_KEY` or an unopenable storage → 503 with a generic body; a request after the 5 s retry window boots again.
- [x] Audit rows are written through `ctx.waitUntil`; the client IP comes from `CF-Connecting-IP`.
- [x] Invalid `vars` fail closed; settings parsing has unit tests.
- [x] `wrangler dev` boots the Worker locally with local D1/KV/rate-limit bindings (checked by hand with wrangler
      4.144.0) and answers; every route, `/health` included, is `503 unavailable` with the log line
      "the D1 storage adapter is not available yet (P3-02)" until P3-02. `pnpm build` bundles it
      (`wrangler deploy --dry-run`, 339 KiB gzip).

The boot retry is 5 s (`BOOT_RETRY_MS`) so a broken deployment doesn't hit storage on every request; concurrent cold
requests each boot (no request awaits another request's I/O in workerd), and the first finished runtime is kept.

Moved out of the original criterion "`wrangler dev` serves `/p/:slug/mcp` with D1 local; the authz suite passes
against it": the D1 part needs the adapter (P3-02), running the P2-12 suite against the Worker is P3-06.

## Security notes
T7 (secrets only via `wrangler secret` / `.dev.vars`, never `vars` or D1), T20 (plan budget), T21 (no module-level
request state: the per-isolate runtime holds configuration and caches only).

## Docs to update
- Worker deployment guide (P3-07): a short `apps/worker/README.md` for local dev now.
- `docs/THREAT_MODEL.md` (Workers isolate caches, boot failure behaviour).

## Out of scope
- D1 adapter details (P3-02). Binding-backed rate limiter and pass-through on Workers (P3-04; pass-through needs a
  shared fingerprint secret). Plan presets beyond the call budget (P3-03). Audit retention purge on Workers (P3-08).
