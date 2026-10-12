---
'relic-bridge': patch
---

Fix the relationship tools. `get_related_entities` with `types` no longer returns an empty list for hosts: the kind is matched on each neighbour's real domain and type across several pages, and edges from the entity to itself are left out with a note. `dependency_health` now skips key transactions, service levels, alert objects, workloads and dashboards, reads several relationship pages, and measures hosts and called services first. `decode_entity_guid` reports infra host guids as type HOST (inferred) instead of `NA`.
