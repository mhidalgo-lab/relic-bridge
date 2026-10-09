---
id: P3-12
title: Single-flight Worker boot with failure backoff
phase: 3
status: todo
priority: medium
depends_on: [P3-01]
adr: []
owner: ""
---

# P3-12 — Single-flight Worker boot with failure backoff

## Goal
Bound the D1 work a cold or failing isolate does. Today every concurrent request that finds no runtime boots one
itself (`apps/worker/src/worker.ts` `runtimeFor`): 50 concurrent unauthenticated `/health` requests on a cold isolate
ran 50 boots (migration check + key checks on D1), and a permanently failing boot retries every 5 s for every request
arriving when the window expires (phase-3 review M3, L3).

## Scope
- One boot in flight per isolate. Other requests wait for it with a short timeout (it must stay safe under workerd's
  rule that I/O is tied to the request that started it: a waiter whose boot owner was cancelled boots itself), or
  answer `503` + `Retry-After` at once.
- Exponential backoff for repeated boot failures (for example 5 s, 15 s, 60 s), reset on success.
- One log line per failed boot, not per waiting request.

## Acceptance criteria
- [ ] N concurrent cold requests cause one storage open (test with a counting `openStorage`).
- [ ] A cancelled boot owner does not hang its waiters (test).
- [ ] Repeated failures back off; a fixed configuration recovers within the backoff ceiling (test with the injected
      clock).
- [ ] `pnpm test:workers` green.

## Security notes
T20 (resource exhaustion): unauthenticated requests must not multiply D1 work before the rate limiter runs.

## Docs to update
- `apps/worker/README.md` (boot behaviour), `docs/guide/cloudflare-deploy.md` troubleshooting.

## Out of scope
- Moving migrations out of the request path (pending decision P3-02).
