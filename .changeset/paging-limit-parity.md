---
"relic-bridge": minor
---

Paging and limits are the same on every list tool (P6-24). Breaking, listed with the P6-22 renames: `list_change_events` and
`list_recent_logs` page with `cursor` / `nextCursor` (newest first, by time) instead of `truncated`; `get_related_entities`
pages and no longer returns `truncated`; `list_alert_policies`, `list_alert_conditions`, `list_recent_issues`,
`search_incidents` and `list_error_groups` take `limit` (default 25 to 50, max 200) and the cursors they return are
composite and bound to the tool, account and filters (a NerdGraph cursor passed back as is is refused); `list_accounts`,
`list_entity_types` and `list_event_types` take `limit` and `cursor` (`list_accounts` no longer returns `truncated`).
On time-windowed lists a cursor keeps the window of the first call. `list_top_transactions` and `get_attributes` stay
bounded and say so in their descriptions. The `tools/list` budget in the offline eval grew from 52 000 to 53 500
characters for the new `limit` and `cursor` arguments.
