---
'relic-bridge': patch
---

`trace_error` fills `errors[].httpStatus` for every agent (0.9.1 verification, NEW-14). It read only `httpResponseCode`, which the PHP agent sends as a string ("500"), so the status was null. It now takes the first valid HTTP status (100-599) from `http.statusCode`, `response.statusCode`, `response.status` or `httpResponseCode`, numeric or a 3-digit string.
