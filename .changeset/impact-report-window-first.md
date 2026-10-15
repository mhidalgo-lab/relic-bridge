---
"relic-bridge": patch
---

`generate_user_impact_report` with an `issue_id` and a `time_range` longer than the connection allows is now refused before it looks the issue up, like every other tool; it used to spend one New Relic request on the lookup first.
