---
"relic-bridge": patch
---

`get_golden_metrics` now says what each metric's trend got when the previous window is beyond the window limit: the halves of the window, or no trend when there are too few points (it used to claim the halves for every metric). The documentation also gains a timeout query that facets by `service.version` without hiding records that have no `mcpMethod`, and the Cloudflare and self-hosting guides give the same upgrade steps as the upgrade guide (check out a release tag instead of pulling `main`).
