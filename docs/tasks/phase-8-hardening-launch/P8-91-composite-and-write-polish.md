---
id: P8-91
title: Insights lookback clamp, create_dashboard errors and NRQL check, change events by entity, error group message match
phase: 8
status: todo
priority: medium
depends_on: []
adr: []
owner: ""
---

# P8-91 — Insights lookback clamp, create_dashboard errors and NRQL check, change events by entity, error group match

## Goal
Four tool findings from review 4 (0.11.0):
- **NEW-19:** `generate_alert_insights_report(change_lookback_hours: 168, before_minutes: 720)`: the `changes` section
  fails with `RB_LIMIT_QUERY` instead of clamping, and the top-level `partial: true` has empty `notes`.
- **NEW-20:** `create_dashboard` local refusals put `Details` inside the "untrusted data from New Relic" block (BUG-29 in
  a new path), the multi-statement hint says "call run_nrql once for each", and a dry run accepts `SELEKT …`.
- **NEW-21:** `list_change_events(entity_guid)` lists only deployments, so a change event that `create_change_event`
  made on that entity isn't shown there.
- **NEW-22:** `trace_error(error_group_id)` falls back to "matched on class only" when the group message has New Relic
  placeholders (`<NUMBER>`), though the group's own `eventsQuery` pattern matches.

## Scope
- Insights: clamp the window to the connection's limit with a note, like `entity_health.lookback_days`; add a top-level
  note naming any failed section whenever `partial` is true (applies to every composite report).
- `create_dashboard`: local errors use the local formatter; widget-specific hints; on `dry_run`, validate each widget
  query with one cheap NerdGraph NRQL call (`LIMIT 1`, short window) and report syntax errors per widget. The checks
  count against the budget. Warn when a widget query has no `SINCE` (the dashboard's time picker applies).
- `list_change_events(entity_guid)`: include change-tracking events for the entity (any category), or at least a note
  with the count of other kinds and how to see them. Update the description.
- `trace_error`: convert New Relic placeholders to `%` with the same builder the `eventsQuery` uses before the
  class-only fallback.

## Acceptance criteria
- [ ] Tests for each of the four items, including that every NRQL value goes through the `nrql` template (T4).
- [ ] Dry-run syntax check never mutates; a test asserts no mutation is sent.
- [ ] Tool docs regenerated.

## Security notes
T4 (NRQL injection: placeholder conversion and validation queries use the template helpers). Write tools stay
read-only on `dry_run`.

## Docs to update
- `docs/reference/tools.md` (generated), changeset (minor).

## Out of scope
- Deleting dashboards.
