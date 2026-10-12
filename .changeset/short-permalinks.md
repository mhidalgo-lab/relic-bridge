---
'relic-bridge': patch
---

`list_error_groups`, `list_recent_issues` and `generate_alert_insights_report` now return short permalinks (entity redirect, issue page with account) instead of long launcher URLs that were cut off with "…" and made the output much larger. Links are left out under `minimal_output`.
