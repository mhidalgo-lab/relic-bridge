---
id: P8-26
title: Report and issue fields
phase: 8
status: done
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-26 — Report and issue fields

## Goal
Fix wrong or missing fields found in the live test run (2026-10-12): BUG-13, BUG-30, BUG-12, BUG-18, BUG-15.

## Scope
- BUG-13 `generate_user_impact_report`: front-end name, `sessionsWithErrors` source attribute, document the JS-error signal threshold.
- BUG-30 `list_error_groups` / `entity_health`: fill `lastSeenAt` for groups with occurrences in the window.
- BUG-12 `trace_error`: when no traced occurrence is found, check for Span / `trace.id` data and hint that tracing appears disabled.
- BUG-18 `search_incidents`: parse JSON-string titles into `titles[]` plus a joined `title`.
- BUG-15 `list_recent_issues`: a `groups` summary and text header for conditions repeated on the page (no new input: the tools/list size budget has no headroom).

## Acceptance criteria
- [x] BUG-13 fixed with a regression test.
- [x] BUG-30 fixed with a regression test.
- [x] BUG-12 fixed with a regression test.
- [x] BUG-18 fixed with a regression test.
- [x] BUG-15 fixed with a regression test.
- [x] Tool descriptions stay within the size budgets; generated docs regenerated.
- [x] Changeset added.

## Security notes
None: read-only field shaping; NRQL via the `nrql` tag, values as variables.

## Docs to update
- Generated tool reference, RESEARCH.md if new platform facts are learned.

## Out of scope
- Other bugs from the live test run.
