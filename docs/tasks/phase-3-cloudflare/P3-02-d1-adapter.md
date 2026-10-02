---
id: P3-02
title: D1 storage adapter
phase: 3
status: todo
priority: high
depends_on: [P3-01]
adr: [0006]
owner: ""
---

# P3-02 — D1 storage adapter

## Scope
- Drizzle D1 driver; same migrations applied with `wrangler d1 migrations apply`.
- Minimize subrequests: batch statements (`db.batch`), single-query access resolution (join), throttled `last_used_at`.

## Acceptance criteria
- [ ] Storage contract suite passes under `@cloudflare/vitest-pool-workers`.
- [ ] Access resolution = 1 D1 call on cache miss, 0 on hit (test).

## Security notes
none beyond P2-01.

## Docs to update
- `docs/dev/storage.md`.

## Out of scope
- —
