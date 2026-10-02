---
id: P2-08
title: Audit log
phase: 2
status: todo
priority: high
depends_on: [P2-06]
adr: []
owner: ""
---

# P2-08 — Audit log

## Scope
- Record per tool call: ts, user, grant, token/client, project, tool, NRQL (literal values masked by default; full/hashed configurable), accounts, status, duration, inspected count, error code.
- Admin actions audited too (credential added, token created/revoked, grant changed) — no secret values.
- Async write (`waitUntil` on Workers); never blocks or fails the request.
- Retention setting + purge command/cron.

## Acceptance criteria
- [ ] Tests: entries written; masking works; no secrets (scan test).

## Security notes
T8, T17. Privacy: document what is stored.

## Docs to update
- `docs/guide/audit-log.md`, THREAT_MODEL open question resolved.

## Out of scope
- Viewer UI (P4-05).
