---
id: P3-04
title: Rate limiting on Workers
phase: 3
status: todo
priority: medium
depends_on: [P3-01, P2-07]
adr: []
owner: ""
---

# P3-04 — Rate limiting on Workers

## Scope
- Implement `RateLimiter` with the Workers Rate Limiting binding (verify current API/limits); fallback per-isolate bucket.
- Auth-failure throttling per IP (`CF-Connecting-IP`).
- Document optional Cloudflare WAF rate-limit rule for extra protection.

## Acceptance criteria
- [ ] Tests in workers pool; docs for WAF rule.

## Security notes
T1, T20.

## Docs to update
- Cloudflare guide.

## Out of scope
- —
