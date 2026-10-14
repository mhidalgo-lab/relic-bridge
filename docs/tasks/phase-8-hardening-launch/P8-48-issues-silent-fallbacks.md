---
id: P8-48
title: list_recent_issues says when group counts or limit fall back
phase: 8
status: review
priority: low
depends_on: []
adr: []
owner: claude-agent
---

# P8-48 — list_recent_issues says when group counts or limit fall back

## Goal
NEW-09 of the 0.9.0 verification: on a 7-day window `group_by` silently returns `groupsScope: "page"`, and `limit: 200`
silently returns 50 rows.

## Scope
- When window counting cannot cover the window (request budget of the 5-request scan), add a note with how many issues
  the counts cover, or count with one aggregate query if the API allows it (check `NrAiIssue` first; record in
  RESEARCH.md).
- `limit` above the API page size: either lower the schema maximum or add a note "limit lowered to N (API page size)".

## Acceptance criteria
- [x] A page-scope fallback always carries a reason.
- [x] A lowered limit is reported (or impossible by schema).
- [x] Tests for both.

## Security notes
None.

## Docs to update
- `docs/RESEARCH.md`, `docs/reference/tools.md` (generated), changeset.

## Out of scope
- Other list_recent_issues filters.
