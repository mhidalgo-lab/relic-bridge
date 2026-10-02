---
id: P4-05
title: "Audit log viewer and usage stats"
phase: 4
status: todo
priority: medium
depends_on: [P4-04, P2-08]
adr: []
owner: ""
---

# P4-05 — Audit log viewer and usage stats

## Scope
- Filter by project, user, device/client, tool, status, time; CSV export.
- Basic stats: calls per tool/day, errors, slowest queries, inspected events.

## Acceptance criteria
- [ ] Pagination works on 100k rows (SQLite/D1).

## Security notes
T17; members see only their own entries.

## Docs to update
- Audit guide.

## Out of scope
- Quotas (P7-12).
