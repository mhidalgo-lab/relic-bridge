---
"relic-bridge": minor
---

`trace_error` now follows error groups from OpenTelemetry services (Span-sourced groups in Errors Inbox). It matches their spans on the span name and status description, takes the latest traced error and continues into the trace, as it already did for APM groups. Groups from other sources (for example browser JavaScript errors) are still refused with a hint.
