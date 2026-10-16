---
'relic-bridge': patch
---

`list_top_transactions`, `analyze_transactions`, `analyze_deployment_impact`, `analyze_threads` and `list_gc_metrics` now refuse an entity that is not an APM application with `RB_INPUT_INVALID` (naming its domain and type and the tools to use) instead of returning empty or inconclusive results. `dependency_health` counts the entity's own signals in the summary, says why a metric was skipped, and notes when there are no neighbours.
