---
'relic-bridge': minor
---

Tool output polish from review 5 (P8-103). `list_recent_issues` returns `groups` only when `group_by` is set; without it
the page-only "repeated conditions" summary is gone (NEW-30). `list_change_events` with `entity_guid` now reports
`scope: "entity_changes"` instead of `"entity_deployments"`, since it lists every change type (NEW-31); read `scope` as
`"account"` or `"entity_changes"`. The `dependency_health` budget note no longer names the `RB_CALL_BUDGET` variable: it
gives the per-call limit and points to `whoami` `limits.perCallBudget` (NEW-35).
