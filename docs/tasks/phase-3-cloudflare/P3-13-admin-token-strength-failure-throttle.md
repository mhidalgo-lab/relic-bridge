---
id: P3-13
title: Admin token strength check and auth-failure throttle that cannot lock out valid tokens
phase: 3
status: review
priority: medium
depends_on: [P3-04]
adr: []
owner: claude-agent
---

# P3-13 — Admin token strength check and auth-failure throttle that cannot lock out valid tokens

## Goal
The Worker's admin API is reachable from the internet and protected only by `RB_ADMIN_TOKEN`, which is checked for
length only (`'a'.repeat(32)` boots and works). The auth-failure throttle (`fail:<ip>`) is per isolate on Workers and,
once tripped, answers `429` to every request from that IP, including one with the valid admin or MCP token (phase-3
review M1, M2; Phase 2 review M6, still open).

## Scope
- `checkAdminToken`: refuse low-entropy values (a single repeated character, fewer than ~10 distinct characters); warn
  at boot when the token does not look generated. `cf:setup` already generates 256-bit tokens.
- Failure throttle semantics: a request carrying a well-formed token that verifies is not refused by `fail:<ip>` (only
  further failures are), or the owner chooses another rule (decide M6 first: `docs/pending-decisions/phase-3.md`).
- Optionally a shared failure counter on Workers (one atomic D1 upsert) instead of per isolate, or document the WAF
  rate-limit rule for `/api/admin/*` as the interim defence.

## Acceptance criteria
- [x] Weak admin tokens refused at boot on `serve` and the Worker (tests).
- [x] A valid token from an IP that sprayed bad tokens is served (test on Node and in the workers pool).
- [x] Bad tokens are still throttled per IP (existing tests stay green).
- [x] P2-12 authorization matrix green.

## Security notes
T1 (brute force), T14 (admin takeover), T20. Changing lock-out semantics must not open an unthrottled guessing path.

## Docs to update
- `docs/THREAT_MODEL.md` (T1), `docs/guide/cloudflare-deploy.md`, `docs/guide/secrets.md`.

## Out of scope
- The Durable Object limiter (P7-10).

## Outcome
- M6 decided as option (a) (owner confirmation pending, `docs/pending-decisions/phase-3.md`): the failure throttle is
  charged and checked on failure (`refuseAuthFailure` hook), so a verified MCP or admin token is served from a locked
  IP; failures past the budget get `429`. Pass-through keeps the strict pre-auth check. No shared D1 counter; the WAF
  rate-limiting rule on `/api/admin/*` is documented as the optional shared backstop.
- `checkAdminToken` refuses fewer than 8 distinct characters (not ~10: 128-bit hex tokens would be refused about once
  in 7,700), repeated blocks, mostly runs/steps and placeholders; `adminTokenLooksWeak` warns at boot (`serve`, Worker).
