---
id: P8-26
title: Report and issue fields (user impact, lastSeenAt, tracing hint, incident titles, issue grouping)
phase: 8
status: in-progress
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
- BUG-15 `list_recent_issues`: optional `group_by` (`condition` | `entity`) and a summary of near-identical issues.

## Acceptance criteria
- [ ] BUG-13 fixed with a regression test.
- [ ] BUG-30 fixed with a regression test.
- [ ] BUG-12 fixed with a regression test.
- [ ] BUG-18 fixed with a regression test.
- [ ] BUG-15 fixed with a regression test.
- [ ] Tool descriptions stay within the size budgets; generated docs regenerated.
- [ ] Changeset added.

## Security notes
None: read-only field shaping; NRQL via the `nrql` tag, values as variables.

## Docs to update
- Generated tool reference, RESEARCH.md if new platform facts are learned.

## Out of scope
- Other bugs from the live test run.
