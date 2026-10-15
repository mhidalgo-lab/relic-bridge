---
id: P8-79
title: get_dashboard returns widget visualizations; dashboard recipe title
phase: 8
status: in-progress
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-79 — get_dashboard returns widget visualizations; dashboard recipe title

## Goal
Found live on 0.10.0: every widget of a dashboard made with `create_dashboard` reads back through `get_dashboard` with
`visualization: null`, because the id (`viz.line`) goes through `label()`, whose charset rejects the dot. Read-back must show
the visualization.

## Scope
- Read the visualization id with a bounded, pattern-checked reader that accepts dotted New Relic ids (built-in and custom
  nerdpack ids). Built-in ids that `create_dashboard` accepts show in its form (`line`, not `viz.line`) so a read-back can be fed
  to create; other valid ids show in full; anything else is dropped (null).
- Tests for each built-in id, an unknown id, hostile values, `minimal_output`.
- Dashboard recipe: drop "(needs the P8-59 version)" from the "Server error %" widget title; the guide keeps the 0.10.0 note.
- Patch changeset.

## Acceptance criteria
- [x] `get_dashboard` returns the visualization for every widget, with and without `minimal_output`.
- [x] Hostile or malformed ids become null (tests).
- [x] `list_dashboards` and other readers checked: no other place reads visualization ids.
- [x] Dashboard JSON title and guide text updated; dashboard JSON test passes.
- [x] Changeset for `relic-bridge`; tool reference regenerated.

## Security notes
Visualization ids are untrusted text: only dotted segments of `[A-Za-z0-9_-]`, at most four segments, each length-bounded, are
shown (T-prompt-injection surface unchanged: no free text passes).

## Docs to update
- `docs/guide/observability.md`, `docs/guide/observability-dashboard.json`, `docs/reference/tools.md` (generated).

## Out of scope
- Reading back widget layout or per-visualization options.
