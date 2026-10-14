---
"relic-bridge": patch
---

A malformed `RB_RATE_LIMIT_*` value no longer appears in the startup error, so a secret pasted into the wrong variable never reaches the log.
