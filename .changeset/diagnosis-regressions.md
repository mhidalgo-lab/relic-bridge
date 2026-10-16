---
"relic-bridge": patch
---

Restore two fixes that had regressed. `trace_error` now checks the whole account for `Span` events whenever the trace has no spans (from `trace_id` or an error group, with or without an entity): none means "distributed tracing or span collection appears to be disabled", otherwise the "sampled out" wording stays. This costs one extra query, only when spans are missing. `generate_user_impact_report` now treats `sessionsWithErrors` as unknown (`null`, with a note) in the previous window too when its JavaScript errors carry no session id, and a total is `null` (with a note) when any front end's part is `null`, instead of a false 0.
