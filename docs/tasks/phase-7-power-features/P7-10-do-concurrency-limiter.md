---
id: P7-10
title: "Durable Object concurrency limiter for shared keys"
phase: 7
status: todo
priority: low
depends_on: [P6-13]
adr: [0010]
owner: ""
---

# P7-10 — Durable Object concurrency limiter for shared keys

## Scope
- Optional DO per credential implementing a semaphore (≤ configured concurrency) across isolates; only for Workers Paid / shared-key setups.

## Acceptance criteria
- [ ] 429s from NerdGraph eliminated in a 20-parallel-client load test.

## Security notes
none.

## Docs to update
- Cloudflare limits guide.

## Out of scope
- —
