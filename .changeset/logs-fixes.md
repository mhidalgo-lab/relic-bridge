---
'relic-bridge': patch
---

Log tool fixes from the live test run (2026-10-12): `analyze_entity_logs` message patterns no longer fail with a too-large response on busy entities (messages are cut at New Relic, at most 20 patterns with one example each, and a too-large sample is repeated smaller instead of dropping the section); `list_recent_logs` and `analyze_entity_logs` share one level vocabulary that also accepts the Monolog/syslog names (`warning`, `notice`, `critical`, `alert`, `emergency`); `time_range: "last 7 days"` is accepted with a 7-day limit (whole-second rounding no longer counts against the window); `list_recent_logs` paging keeps one fixed `since`/`until`, never returns lines outside it and no longer skips or repeats lines with equal timestamps; lines with an empty `message` show their `log` or `logged_message` field, or a short attribute summary.
