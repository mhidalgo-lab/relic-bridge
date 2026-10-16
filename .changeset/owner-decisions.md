---
"relic-bridge": minor
---

Span status follows the OpenTelemetry server conventions: only server faults and refused writes (`RB_WRITE_APPROVAL_UNAVAILABLE`, `RB_WRITE_APPROVAL_DECLINED`) set span status ERROR; other caller errors (and HTTP 4xx on non-tool requests) leave the status Unset but still carry `error.type` and `fault=caller`. `rpc.server.duration` is unchanged. A `time_range` that starts in the future is refused with `RB_INPUT_INVALID` ("The range is in the future: New Relic has no data there") instead of warning; ranges that only end in the future still work. `create_dashboard` declares its true worst-case cost (`1 + 10 * 2`: the dry run probes up to 10 widget queries).
