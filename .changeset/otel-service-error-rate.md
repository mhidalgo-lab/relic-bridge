---
'relic-bridge': minor
---

Self-monitoring separates caller errors from server errors. Only server errors (New Relic unreachable, rate limiting or timing out, an unexpected answer, a refused stored key, internal errors) set span status ERROR and `error.type`, and `rpc.server.duration` now also carries `rpc.grpc.status_code` for them, so the New Relic service's Error rate counts them (it stayed 0 before). Caller errors (invalid input, limits, quotas, unknown query ids, tools or accounts not granted) leave the span status unset, so they no longer open Errors Inbox groups; they are still counted by `status`, `error.code` and the new `fault` attribute (`caller`/`server`). Alerts on span status ERROR now see server errors only.
