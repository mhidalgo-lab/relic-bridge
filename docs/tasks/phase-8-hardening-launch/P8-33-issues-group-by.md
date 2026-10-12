---
id: P8-33
title: list_recent_issues group_by
phase: 8
status: done
priority: low
depends_on: []
adr: []
owner: claude-agent
---

# P8-33 — list_recent_issues group_by

## Goal
Finish BUG-15 from the live test run (2026-10-12): P8-26 added a summary of repeated conditions but could not add the `group_by` input because of the tools/list size budget. Let callers group the page per condition or per entity.

## Scope
- `list_recent_issues` gets `group_by` (`condition` | `entity`). The `groups` summary and its text header use it; without it the current behaviour (repeated conditions only) is kept.
- Make room by trimming wording in other tool descriptions (meaning kept) instead of raising the budgets.

## Acceptance criteria
- [x] `group_by: entity` and `group_by: condition` return a `groups` summary (every group, including single-issue ones) with a regression test.
- [x] Default behaviour unchanged (tests from P8-26 still pass).
- [x] Tool descriptions stay within the size budgets and keep 1 000 characters of headroom; no budget raised.
- [x] Generated docs regenerated.

## Security notes
none: grouping is computed on rows that already passed the account/entity scope check (T3).

## Docs to update
- Generated tool reference (`pnpm docs:tools`), task index.

## Out of scope
- Grouping across pages (the summary covers the returned page only).
