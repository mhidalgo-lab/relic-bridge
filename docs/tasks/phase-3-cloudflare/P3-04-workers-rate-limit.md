---
id: P3-04
title: Rate limiting on Workers
phase: 3
status: done
priority: medium
depends_on: [P3-01, P2-07]
adr: []
owner: claude-agent
---

# P3-04 — Rate limiting on Workers

## Scope
- Implement `RateLimiter` for Workers: the Rate Limiting binding as a shared backstop (verify current API/limits) layered over per-isolate buckets that enforce exact rules and provide `peek`.
- Auth-failure throttling per IP (`CF-Connecting-IP`): per isolate (the binding cannot `peek`); keep M6 semantics.
- Fail open on limiter errors; shared fingerprint secret + binding required for pass-through on Workers.
- Document optional Cloudflare WAF rate-limit rule for extra protection.

## Acceptance criteria
- [x] Tests in workers pool (layered limiter, binding keys, refusal, fail open, throttle, pass-through prerequisites).
- [x] Docs for the WAF rule and the limiter design in the Cloudflare guide.
- [x] Pass-through available on Workers with `RB_FINGERPRINT_SECRET`.

## Security notes
T1, T20.

## Docs to update
- Cloudflare guide.

## Out of scope
- —
