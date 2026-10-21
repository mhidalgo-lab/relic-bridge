---
'relic-bridge': patch
---

`trace_error` now reads the level of a trace's log lines from `severity.text` as well as `level`, `severity` and
`log.level`, so OpenTelemetry logs no longer show a blank level. The NRQL reference says that OpenTelemetry logs carry
the level in `severity.text`.
