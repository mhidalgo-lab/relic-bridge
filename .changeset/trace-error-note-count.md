---
'relic-bridge': patch
---

`trace_error` now says how many errors carry a trace id when it finds no spans ("none of N errors carry a trace id" or "even though K of N errors carry a trace id") instead of always claiming some do (NEW-10). The count is folded into the existing tracing check query.
