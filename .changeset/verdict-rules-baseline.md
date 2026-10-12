---
'relic-bridge': minor
---

Deployment and transaction verdicts are more reliable. `analyze_transactions` and `analyze_deployment_impact` now call a change in error rate when |z| >= 3 and at least 5 errors more or fewer than expected (a strong z-score under half a percentage point is no longer "similar"), and every note says which rule decided. New optional `baseline` input (`previous_window`, `same_window_1d_ago`, `same_window_7d_ago`): when the throughput shifted a lot between the windows (for example the overnight trough) the same windows one day earlier are compared as a control (2 extra queries), and a change that also happened then is a `warning` instead of `regression_suspected`.
