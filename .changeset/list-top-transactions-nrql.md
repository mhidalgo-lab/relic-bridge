---
'relic-bridge': patch
---

Fix `list_top_transactions` failing on every call: the generated NRQL used `ORDER BY` after `FACET`, which NRDB rejects. The ranking aggregate (p95, error count or request count per `sort_by`) now leads the SELECT list, which is how NRDB orders facets.
