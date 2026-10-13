---
id: P8-41
title: partial only for involuntary truncation; group_by counts the whole window
phase: 8
status: review
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-41 — partial only for involuntary truncation; group_by counts the whole window

## Goal
Fix NEW-05 and NEW-07 from the 0.8.0 verification run (2026-10-13): a cap the caller asked for must not read as a degraded answer, and `list_recent_issues` groups must not look like window totals when they are page-local.

## Scope
- NEW-05: `partial` (and section `status: partial`) means involuntary truncation only (budget, limits, errors, timeouts). Metrics left out are listed with a reason (`max_metrics`, `budget`, `error`, `no_data`); a requested cap is reported as such. Review every tool that sets `partial` for consistent semantics, including `dependency_health` neighbours.
- NEW-07: `list_recent_issues group_by` counts the whole requested window with one extra aggregate query when the budget allows (same scope and filters, counted in the declared cost); otherwise page-local counts labelled `groupsScope: 'page'` with a note. `groupsScope` is always present.
- Keep the tools/list size budget: minimal new description text, trim wording elsewhere instead of raising budgets.

## Acceptance criteria
- [x] `max_metrics` (golden, entity_health, dependency_health) no longer sets `partial`; skipped metrics are listed with a reason.
- [x] Involuntary cuts (budget, error) still set `partial` and carry a reason.
- [x] `group_by` counts the whole window; page fallback is labelled with `groupsScope: 'page'` and a note.
- [x] Regression tests for every item; description budgets and 1 000-character headroom kept, no budget raised.
- [x] Generated docs regenerated; RESEARCH.md updated if something new was learned.

## Security notes
none: the extra query uses the same account/entity scope and GraphQL variables (T3, T4).

## Docs to update
- Generated tool reference (`pnpm docs:tools`), task index, changeset.

## Out of scope
- NEW-03, NEW-04, NEW-06.
