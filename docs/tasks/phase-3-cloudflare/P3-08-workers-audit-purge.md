---
id: P3-08
title: Audit retention purge on Workers (cron trigger)
phase: 3
status: review
priority: medium
depends_on: [P3-02]
adr: []
owner: claude-agent
---

# P3-08 — Audit retention purge on Workers

## Goal
`relic-bridge serve` deletes audit rows past `RB_AUDIT_RETENTION_DAYS` every hour. Workers have no long-lived timer,
so the Worker needs a `scheduled` handler to keep the D1 audit table bounded (D1 free-plan storage is small).

## Scope
- `scheduled` handler on the Worker handler (`apps/worker/src/worker.ts`) calling the shared recorder's
  `purge(retentionDays, { limit })` against D1: the same storage method and policy as `relic-bridge audit purge`.
  It does not boot the full runtime (no master key needed), so a bad key never stops the cleanup.
- Bounded work per run: `AuditLogRepository.purgeBefore(before, limit?)` gains an optional row limit (all adapters,
  oldest first). The handler deletes in batches (500 rows, at most 20 batches, 10 s); a larger backlog is finished by
  the next run.
- `triggers.crons` in `wrangler.jsonc` (hourly, like `serve`).
- `RB_AUDIT_RETENTION_DAYS` parsed like the CLI (whole days, default 90, `0` keeps everything; invalid fails closed).
- Logs (structured, no secrets) `audit purge finished` with counts; an `admin` / `audit.purge` row (`source: cron`)
  when rows were removed.

## Acceptance criteria
- [x] Workers-pool test (local D1): the scheduled handler removes rows older than retention and keeps newer ones.
- [x] A backlog above the per-run budget is removed in bounded batches and finished by the next run.
- [x] Retention `0` deletes nothing; an invalid value is logged and nothing is deleted.
- [x] A purge failure is logged and does not throw out of the handler.
- [x] `purgeBefore(before, limit)` is covered by the storage contract for every adapter.

## Security notes
none beyond P2-08 (retention bounds stored client IPs and masked NRQL).

## Docs to update
- `docs/guide/cloudflare-deploy.md`, `docs/guide/audit-log.md`, `apps/worker/README.md`, `docs/THREAT_MODEL.md`.

## Out of scope
- —
