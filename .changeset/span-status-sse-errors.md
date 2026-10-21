---
'relic-bridge': patch
---

A JSON-RPC error that the MCP SDK sends as a one-message event stream (for example `tasks/list`, `tasks/result` or an
unknown prompt on a 2025-era session) now marks its span as a caller fault with `error.type` set to the code, like the
same error sent as JSON. The stream reaches the client unchanged and unhurried.
