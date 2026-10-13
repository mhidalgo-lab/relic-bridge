---
'relic-bridge': patch
---

`partial` now means involuntary truncation only (0.8.0 verification run, 2026-10-13, NEW-05). Golden metrics left out by your own `max_metrics` (and related entities left out by `max_dependencies`) no longer set `partial: true` or a `partial` status in `get_golden_metrics`, `entity_health`, `dependency_health` and `generate_alert_insights_report`; they are listed as `skipped` with a `reason` (`max_metrics`, `budget`, `error` or `no_data`). A cut forced by the request budget or an error still sets `partial`.

`list_recent_issues` with `group_by` now counts the whole requested window, not only the returned page (NEW-07). The window is read in up to 4 extra pages, counted in the declared cost; if it is larger or the budget runs out, the counts cover the page and the new `groupsScope` field says `page` (a note says why). `groupsScope` is always present.
