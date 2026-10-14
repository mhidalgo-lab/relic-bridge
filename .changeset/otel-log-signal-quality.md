---
'relic-bridge': patch
---

Self-monitoring logs are easier to use (P8-50). A standalone `GET` stream or `subscriptions/listen` stream that reaches the request deadline now logs `mcp stream closed at deadline` at info instead of an `mcp request timed out` warning; a real request that never finishes still warns. Access-log (`http request`) records now export the integer HTTP `status`, `method` and the matched `route` pattern (fixed sets; never raw paths), so 4xx/5xx can be counted in New Relic. The observability guide now lists the attribute names as New Relic shows them (`tool`, `ms`, `code`, without `log.`).
