---
'relic-bridge': patch
---

Golden-metric trends (`get_golden_metrics`, `entity_health`) now compare the window with the previous equal window, like `analyze_transactions`, instead of the two halves of one window (live test run, 2026-10-12, BUG-06). This adds one query per metric, counted in the request cost; beyond the window limit the old halves method is used and a note says so.
