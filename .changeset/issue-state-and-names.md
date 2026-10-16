---
'relic-bridge': patch
---
Alert issues report one state across list_recent_issues, generate_alert_insights_report and the acknowledge_issue and close_issue dry runs: when New Relic returns older records of an issue, the freshest one is used. get_related_entities labels entities with no name (AIOPS issues) as "(unnamed issue 661dd2d5)" and marks them with `nameIsFallback`.
