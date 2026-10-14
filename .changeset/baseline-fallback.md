---
'relic-bridge': patch
---

An explicit `baseline: "same_window_7d_ago"` whose control falls outside the connection's lookback limit now falls back to `same_window_1d_ago` in `analyze_transactions` and `analyze_deployment_impact`, instead of running no control and reporting `used: "previous_window"` (NEW-11). `baseline.used` and `reason` name the requested baseline and what ran, and a note stays. The limit is never relaxed.
