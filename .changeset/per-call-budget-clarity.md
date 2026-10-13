---
'relic-bridge': minor
---

The call budget is now unmistakably per tool call (NEW-02, BUG-28). `whoami` reports `limits.perCallBudget` (the most New Relic calls one tool call may make) instead of `callBudget`, `callsUsed` and `callsRemaining`, which only described `whoami`'s own call and looked like a broken running total. Its text points to rate limits and grant quotas for limits across calls, and the docs say the same. These output fields were removed: reconnect your MCP client after upgrading so it reads the new tool schema.
