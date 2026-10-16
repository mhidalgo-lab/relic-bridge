---
id: P8-103
title: Review 5 tool output polish - implicit groups, change event scope, budget note
phase: 8
status: todo
priority: low
depends_on: []
adr: []
owner: ""
---

# P8-103 — Review 5 tool output polish: implicit groups, change event scope, budget note

## Goal
Review 5 (0.12.0) output findings:
- **NEW-30:** `list_recent_issues` without `group_by` returns `groups` (only conditions repeated on the page), with no
  `groupsScope` or `groupsNote`, and the `group_by` description doesn't mention it.
- **NEW-31:** `list_change_events(entity_guid)` now lists every change type but still reports
  `scope: "entity_deployments"`.
- **NEW-35:** on Workers the budget note says "the server call budget is RB_CALL_BUDGET", an environment variable name
  that means nothing to a model or user.

(NEW-32, read lag after ack and close, is covered by P8-100.)

## Scope
- `list_recent_issues`: return `groups` only when `group_by` is set (the page summary without `group_by` goes away), or
  give the implicit one `groupsScope: "page"` and a note. Prefer the first; update the description either way.
- `list_change_events`: `scope: "entity_changes"` for entity listings. Keep `entity_deployments` out of the output enum
  only after checking nothing in the repo (prompts, docs, tests, UI) depends on it; mention the rename in the changeset.
- Budget notes: name the limit and where to read it ("the server's per-call budget (N requests; whoami
  limits.perCallBudget)") instead of the variable name, everywhere the same text appears.

## Acceptance criteria
- [ ] Tests for each of the three changes.
- [ ] Generated tool docs regenerated.

## Security notes
None.

## Docs to update
- Generated tool docs, changeset (minor if an output field changes meaning, else patch).

## Out of scope
- Polling New Relic after writes (P8-100).
