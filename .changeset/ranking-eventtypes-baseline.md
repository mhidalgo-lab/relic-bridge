---
'relic-bridge': patch
---

- `list_top_transactions` with `sort_by: slowest` now skips transactions with fewer than `min_requests` requests (default 10), so one-request transactions no longer top the ranking (NEW-03).
- `list_event_types` lists global event types only in `globalEventTypes`, no longer also in `eventTypes` (NEW-04).
- The automatic seasonal baseline of `analyze_transactions` and `analyze_deployment_impact` prefers the same windows 7 days earlier for windows of 24 h or more or across a weekend, when the `maxWindowDays` limit allows it; otherwise it uses 1 day and says which `maxWindowDays` a weekly control needs (NEW-06).
