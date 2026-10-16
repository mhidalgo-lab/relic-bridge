---
"relic-bridge": patch
---

Fix the open CodeQL findings. Base64 parsing no longer uses a pattern that could backtrack exponentially on a long hostile string (reachable only through the authenticated admin API); trailing-slash trimming of configured URLs and the OR scan in entity-search filters are linear; backslashes are escaped in markdown table cells; the database file and backup file are created with `O_EXCL` and `O_NOFOLLOW` and an existing database file is tightened to `0600` through the opened handle, closing a check-then-use window.
