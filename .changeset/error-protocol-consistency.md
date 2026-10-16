---
'relic-bridge': patch
---

Three consistency fixes from review 5. Input errors raised before New Relic is called (for example `create_dashboard`
with multi-statement or unbalanced NRQL) now print their details as plain text; only details that came from New Relic
stay wrapped as untrusted data. `tasks/get`, `tasks/update` and `tasks/cancel` answer `-32601 Method not found` on a
connection that was never offered the Tasks extension (before 2026-07-28), like `tasks/list` and `tasks/result`. Span
status follows one rule for every method: `ERROR` only for server or upstream faults; caller faults, declined or
unavailable write approvals and JSON-RPC protocol errors such as `-32601` leave it unset, and a JSON-RPC error is no
longer recorded as `ok`.
