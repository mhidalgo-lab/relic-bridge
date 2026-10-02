---
id: P2-07
title: Rate limiting (pluggable)
phase: 2
status: todo
priority: high
depends_on: [P2-06]
adr: [0010]
owner: ""
---

# P2-07 — Rate limiting (pluggable)

## Scope
- `RateLimiter` interface; Node in-memory token bucket; Workers implementation in P3-04.
- Keys: per token, per grant, per IP for auth failures (stricter).
- Defaults sized against NRQL 3,000/min/account and personal use; configurable per grant.
- 429 responses with `Retry-After`; MCP tool error message tells the agent to slow down.

## Acceptance criteria
- [ ] Tests for bucket behaviour and auth-failure throttling.

## Security notes
T1, T5, T20.

## Docs to update
- Configuration reference.

## Out of scope
- Global distributed limiter (P7-10).
