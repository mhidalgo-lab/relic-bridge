---
id: P4-05
title: "Audit log viewer and usage stats"
phase: 4
status: review
priority: medium
depends_on: [P4-04, P2-08]
adr: []
owner: claude-agent
---

# P4-05 — Audit log viewer and usage stats

## Scope
- Screen `GET /admin/audit` (admins and owners see everything; members see only rows whose `userId` is their own,
  forced by the admin API, never by the page). Filters: kind, status, tool or admin action, project, user, device token,
  time range (1 h to 90 days or all). Keyset (cursor) pagination, 50 rows per page. Ids are shown with their label
  (project slug, user email, token label) resolved for display only; deleted records fall back to the id. Every audit
  string is escaped (tool names, error codes and details are attacker-influenced).
- CSV export `GET /admin/audit.csv` of the same filter: at most 5,000 rows, formula-injection safe, `no-store`.
- Screen `GET /admin/usage` (admins and owners): tool-call counts, error and denied rates and durations over a window
  (24 h, 7 d, 30 d, 90 d), grouped by tool, project, grant, device token or day, plus the slowest calls and events
  inspected. Bars are plain CSS.
- Admin API: `GET /audit` gains `order=slowest`; new `GET /audit/stats` (bounded SQL aggregates: window at most 90 days,
  at most 100 groups); `GET /audit` is open to `member` with the own-user restriction. Storage: `auditLog.stats`
  and `AuditQuery.order` in the memory, SQLite and D1 adapters.

## Acceptance criteria
- [x] Filters (kind, status, action, project, user, device token, time) work in the screen and the API; cursor
  pagination returns every row exactly once.
- [x] Pagination works on 100k rows (SQLite): a deep page is a keyset seek, not an offset scan.
- [x] CSV export is bounded, escapes formulas, quotes and newlines, and carries `no-store` and a download name.
- [x] Usage stats are computed with one bounded aggregate per view (window and group caps, `tool_call` rows only).
- [x] Members see only their own rows (API enforced); `GET /audit/stats` is admin-only; negative authz tests and
  matrix rows for every new route.
- [x] Hostile audit content is escaped (tests); axe passes on both screens.
- [x] Audit guide, admin API reference and threat model updated.

## Security notes
T17; members see only their own entries.

## Docs to update
- Audit guide, admin UI guide, admin API reference (generated), THREAT_MODEL.

## Out of scope
- Quotas (P7-12).
- Pre-aggregated rollup tables and charts libraries (see the pending decision about aggregate cost on D1).
