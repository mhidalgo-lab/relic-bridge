---
'relic-bridge': patch
---

`trace_error` now says span data is missing whenever the account or entity has no `Span` events, even if errors carry a trace id (BUG-12), and notes when its tracing check could not run.
