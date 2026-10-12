---
'relic-bridge': patch
---

Error contracts and polish from the live test run: `get_query_result` with an unknown or expired id now fails with the new `RB_QUERY_NOT_FOUND` code and a "rerun run_nrql" hint; a `run_nrql` query with several `;`-separated statements is refused with "one NRQL statement per call"; limit and time-range errors show their details as plain text instead of wrapping them as untrusted New Relic data; `whoami` reports `callsUsed` and `callsRemaining` and states that the call budget is per tool call; `list_event_types` flags global types (`Public_*`, `NrUsage`, ...) that cannot be mixed with account data (`globalEventTypes`); `get_attributes` takes `name_contains` to narrow large attribute lists.
