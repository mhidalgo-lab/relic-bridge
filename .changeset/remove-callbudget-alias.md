---
"relic-bridge": minor
---

**Breaking**: removed `whoami` `limits.callBudget` (deprecated in 0.9.1, announced for removal in 0.11.0); read
`limits.perCallBudget`, which has the same value. Reconnect your MCP client after upgrading.
