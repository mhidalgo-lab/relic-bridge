---
'relic-bridge': patch
---

`analyze_entity_logs` (and the logs section of `generate_alert_insights_report`) and `list_recent_logs` now read the
level of OpenTelemetry logs from `severity.text`. Lines without any level are counted as "(no level)" and the total
comes from the unfaceted count, so it no longer says "0 lines" next to message patterns. The `level` filter matches
every level column.
