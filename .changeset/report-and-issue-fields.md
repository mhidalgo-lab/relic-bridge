---
'relic-bridge': patch
---

Report and issue fields fixes:

- `generate_user_impact_report` fills front end names from the app events and reports `sessionsWithErrors` as unknown (null, with a note) instead of 0 when JavaScript errors carry no session id; the `js_errors_up` threshold (rate 1.5x, 10+ errors) is documented.
- `list_error_groups` and `entity_health` fill `lastSeenAt` from the in-window occurrences when the group has none.
- `trace_error` says distributed tracing appears to be disabled when no traced occurrence is found and the entity or account has no Span or traced error data.
- `search_incidents` parses JSON-encoded titles into `titles[]` and a joined `title`.
- `list_recent_issues` adds a `groups` summary and a text header when several issues on the page share a condition.
