---
id: P3-08
title: Audit retention purge on Workers (cron trigger)
phase: 3
status: todo
priority: medium
depends_on: [P3-02]
adr: []
owner: ""
---

# P3-08 — Audit retention purge on Workers

## Goal
`relic-bridge serve` deletes audit rows past `RB_AUDIT_RETENTION_DAYS` every hour. Workers have no long-lived timer,
so the Worker needs a `scheduled` handler to keep the D1 audit table bounded (D1 free-plan storage is small).

## Scope
- `scheduled` handler in `apps/worker` calling `createAuditRecorder(...).purge(retentionDays)` against D1.
- `triggers.crons` in `wrangler.jsonc` (hourly or daily; free plan allows a few cron triggers).
- `RB_AUDIT_RETENTION_DAYS` parsed like the CLI (`0` keeps everything).

## Acceptance criteria
- [ ] Workers-pool test: the scheduled handler removes rows older than retention and keeps newer ones.
- [ ] A purge failure is logged and does not throw out of the handler.

## Security notes
none beyond P2-08 (retention bounds stored client IPs and masked NRQL).

## Docs to update
- Cloudflare guide (P3-07), `docs/guide/audit-log.md`.

## Out of scope
- —
