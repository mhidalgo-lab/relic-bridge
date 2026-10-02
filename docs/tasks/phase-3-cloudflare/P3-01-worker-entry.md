---
id: P3-01
title: Cloudflare Worker entry and bindings
phase: 3
status: todo
priority: high
depends_on: [P2-13]
adr: [0004, 0005]
owner: ""
---

# P3-01 — Cloudflare Worker entry and bindings

## Scope
- `apps/worker`: export the shared Hono app; bindings `DB` (D1), `OAUTH_KV` (KV, used in P5), `RATE_LIMITER`, secrets `RB_MASTER_KEY`, `RB_ADMIN_TOKEN`.
- `wrangler.jsonc.example` (no account ids committed), current `compatibility_date`, `nodejs_compat` only if required (prefer not).
- Isolate-level caches (access resolution, imported CryptoKeys) with TTLs from config.
- `waitUntil` for audit writes.

## Acceptance criteria
- [ ] `wrangler dev` serves `/p/:slug/mcp` with D1 local; the authz suite passes against it.

## Security notes
T7 (secrets only via `wrangler secret`), T20.

## Docs to update
- Worker deployment guide (P3-07).

## Out of scope
- D1 adapter details (P3-02).
