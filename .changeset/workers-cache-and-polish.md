---
"relic-bridge": patch
---

Query cache on Workers: when the per-colo Cache API accepts a write but returns nothing (a `*.workers.dev` hostname), the result now carries `cache.note` saying results are not shared across isolates, and the Worker stops spending Cache API calls on it; the memory tier of the isolate still serves repeats. Polish: `dependency_health` says whether `max_dependencies` or the request budget stopped it; `get_related_entities` notes a short page caused by filtering after paging; `time_range` warns when the range is entirely in the future; `get_dashboard` keeps line breaks in markdown widget text; the not-found hint of `acknowledge_issue` and `close_issue` no longer mentions `lookback`; `create_change_event` says "https only" for an `http:` `deep_link`; `list_recent_issues` returns `groupsScope` only with `group_by`.
