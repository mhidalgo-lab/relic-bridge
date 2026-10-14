---
'relic-bridge': patch
---

`whoami` returns `limits.callBudget` again, as a deprecated alias with the same value as `limits.perCallBudget` (NEW-12). Version 0.9.0 renamed `callBudget` to `perCallBudget` and removed `callsUsed` and `callsRemaining` without a deprecation path. The alias will be removed in the minor after next, so switch to `perCallBudget`. `callsUsed` and `callsRemaining` stay removed: the budget is per tool call, not a running total. The `whoami` description now says what `perCallBudget` means.
