---
id: P7-24
title: "Write rate limit enforced deployment-wide on Workers"
phase: 7
status: todo
priority: medium
depends_on: [P7-10]
adr: [ADR-0015]
owner: claude-agent
---

# P7-24 — Write rate limit enforced deployment-wide on Workers

## Goal
Phase 7 review M1 (`docs/reviews/phase-7-review.md`): ADR-0015 promises a write rate limit of 20 per hour per grant,
failing closed. On Workers it is per isolate unless `RB_SHARED_LIMITER=on`, and with the shared limiter on,
`WorkersRateLimiter.take` (`apps/worker/src/rate-limit.ts`) answers from the isolate bucket when the Durable Object
errors, so a DO outage multiplies the cap by the number of isolates. stdio has no write limit at all (one user, local).

## Scope
- `write:` keys always go to the Durable Object when one is bound, and a DO error refuses the write (fail closed)
  instead of falling back to the isolate bucket. Reads keep the per-isolate fallback.
- The Worker warns at startup (or refuses, owner's call) when `RB_WRITE_TOOLS=on` runs without the shared limiter.
- Fix the "fails closed" wording in `packages/http-app/src/rate-limit-hooks.ts` and the shared-limiter guide.

## Acceptance criteria
- [ ] Worker test: a DO that throws makes a write call fail with `RB_LIMIT_RATE` and sends no mutation; a read still
      passes on the isolate fallback.
- [ ] Startup warning (or refusal) for writes without the shared limiter, tested.
- [ ] THREAT_MODEL T31 row and `docs/guide/shared-limiter.md` updated.

## Security notes
T31 (write tools), T20 (abuse).

## Docs to update
- `docs/THREAT_MODEL.md`, `docs/guide/shared-limiter.md`, ADR-0015 (addendum only if behaviour changes).
