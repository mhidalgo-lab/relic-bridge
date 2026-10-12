---
id: P8-24
title: Enforce maxWindowDays as lookback as well as width
phase: 8
status: review
priority: high
depends_on: []
adr: []
owner: claude-agent
---

# P8-24 — Enforce maxWindowDays as lookback as well as width

## Goal
`maxWindowDays` is documented as how far back a connection can reach (`docs/guide/query-limits.md`), but only the width
of the window was enforced, so `SINCE 60 days ago UNTIL 59 days ago` read data far outside the limit (BUG-22, live test
run 2026-10-12). Owner decision: the limit applies to both the width (`UNTIL − SINCE`, plus `COMPARE WITH`) and the
lookback (`now − SINCE`, `COMPARE WITH` offsets included).

## Scope
- `enforceQueryLimits` (`packages/core/src/nrql/limits.ts`): reject a query whose earliest read instant is more than
  `maxWindowDays` before now, for relative times, calendar keywords, quoted dates, epoch seconds and milliseconds,
  `UNTIL` in the past, lowercase keywords and subqueries. Inclusive boundary (exactly N days is allowed), shared with
  P8-23 (BUG-23).
- `assertWindowWithinLimit` (tools that read through NerdGraph without NRQL, and parsed `time_range` inputs and paging
  cursors): also check `now − sinceMs`.
- `time_range` tool warns for a window beyond the lookback.
- Docs: `configuration.md`, `query-limits.md`, THREAT_MODEL T5.

## Acceptance criteria
- [x] Every bypass of the BUG-22 table is rejected with `RB_LIMIT_QUERY` (unit tests in `nrql-limits.test.ts`).
- [x] Exactly `maxWindowDays` of lookback is allowed; one millisecond more is rejected.
- [x] Tools that take `time_range` reject a narrow window far in the past without sending a request.
- [x] Docs say "reach back" and describe both checks; THREAT_MODEL T5 updated.
- [x] Changeset added.

## Security notes
T5: `maxWindowDays` is a data-access limit, not only a cost limit.

## Docs to update
- `docs/guide/configuration.md`, `docs/guide/query-limits.md`, `docs/THREAT_MODEL.md`.

## Out of scope
- BUG-23 padding in `list_recent_logs` (P8-23); only the inclusive rule in the shared code is kept here.

## Notes
- Tools that derive a window from an old issue (`issueWindow`) now start it no earlier than the lookback limit and say it was cut, instead of failing.
- The tool-level check allows 60 s of clock drift between resolving "last N days" and checking it; the NRQL check is exact.
