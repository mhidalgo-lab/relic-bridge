---
id: P3-15
title: Key-rotation guards (unreadable rows warning, Free-plan batch size, kv TTL validation)
phase: 3
status: done
priority: low
depends_on: [P3-11]
adr: [0007]
owner: claude-agent
---

# P3-15 — Key-rotation guards (unreadable rows warning, Free-plan batch size, kv TTL validation)

## Goal
Small guards found by the phase-3 review around master-key rotation and the D1 adapter.

## Scope
- Log a warning at boot (Worker and `serve`) when credentials exist under a key version the keyring does not hold
  (an operator who removed `RB_MASTER_KEY_PREVIOUS` before the rotation finished).
- On `RB_PLAN=free`, cap `keys/rotate` `batchSize` so one call stays under 50 D1 queries (100 rows ≈ 106 queries).
- `kv.put`: reject a non-finite `expirationTtl` / `expiration` (`InvalidInputError`) in every adapter; delete expired
  `kv` rows from the cron once something uses `kv`.
- Guard non-finite `limit` in the D1 adapter's `auditLog.list` / `purgeBefore` (callers validate today).

## Acceptance criteria
- [x] Tests for each guard (Node and workers pool where the adapter is D1). The `kv` cron purge is deferred until
      something uses `kv` (pending decision).
- [x] Storage contract suite updated for the `kv` TTL rule.

## Security notes
T7 (master key and stored keys): an unreadable-row warning prevents silent loss of stored credentials.

## Docs to update
- `docs/guide/secrets.md`, `docs/guide/cloudflare-deploy.md`, `docs/reference/admin-api.md`.

## Out of scope
- Background rotation from the cron (pending decision P3-11).
