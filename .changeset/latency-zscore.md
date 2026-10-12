---
'relic-bridge': patch
---

`analyze_deployment_impact` and `analyze_transactions` now apply the same |z| >= 3 rule to average and p95 latency as to error rate and throughput: the window query adds the standard deviation of duration, and a latency move beyond the 15% band and 5 ms only counts as `worse` or `better` when it is statistically significant. Noisy low-traffic windows no longer give false latency regressions, and each `note` names the rule and the z value (BUG-07).
