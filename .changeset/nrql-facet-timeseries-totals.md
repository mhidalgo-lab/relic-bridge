---
'relic-bridge': patch
---

`run_nrql` no longer fails output validation on queries with both `FACET` and `TIMESERIES` (P8-44). NerdGraph returns `totalResult` and `otherResult` as an array of time buckets for that shape; the output schema and text now accept either an object or an array.
