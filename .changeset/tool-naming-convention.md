---
"relic-bridge": minor
---

**Breaking (pre-1.0): one name per concept in tool arguments and structured output (P6-22).** Tool names are unchanged,
so grants keep working; clients and scripts that pass arguments by the old names must update them. No aliases are kept
(nothing was released with the old names). The convention is in `docs/dev/tool-conventions.md`.

Arguments:
- `guid` → `entity_guid` on `get_entity`, `get_related_entities`, `get_golden_metrics`, `decode_entity_guid`,
  `get_dashboard`, `dependency_health`, `entity_health`.
- `since` → `time_range` on `get_golden_metrics`, `dependency_health`, `list_event_types`, `get_attributes`.
- `name` (substring filter) → `name_contains` on `search_entities`, `list_alert_policies`, `list_alert_conditions`,
  `list_dashboards`, `list_synthetic_monitors`. `name` now always means an entity name resolved to `entity_guid`.
- `run_nrql`: `timeout_s` → `timeout_seconds`.
- `list_recent_issues`: `policy_id` is a digit string, like `list_alert_conditions` and `list_alert_policies` output.
- `generate_user_impact_report`: `compare` → `compare_previous`.

Structured output:
- The account of a result is `accountId` (was `account`); lists of account ids are `accountIds` (`run_nrql`,
  `get_query_result`, `list_entity_types`, `resolve_entity`); `whoami` / `list_accounts` return `defaultAccountId` and
  `unreachableAccountIds`.
- `entity_health` returns `entityGuid` (was `guid`).
- Lists cut without paging return `truncated` (was `maybeMore` on `list_change_events`, `list_recent_logs`,
  `list_top_transactions`; `hasMore` on `get_related_entities`).
- `list_error_groups`: `total` (was `totalCount`).
- `search_entities`, `list_dashboards`, `list_synthetic_monitors` also return `hiddenOutsideScope`.
- `get_golden_metrics`, `dependency_health`, `list_event_types`, `get_attributes` return resolved `since` and `until`
  (ISO 8601) instead of the window expression.
- `run_nrql` / `get_query_result`: `retryAfterSeconds` (was `retryAfterS`).
- APM transaction stats: `avgDurationSeconds`, `p50DurationSeconds`, `p95DurationSeconds`, `p99DurationSeconds`;
  Kafka rates: `bytesInPerSecond`, `bytesOutPerSecond`, `messagesInPerSecond`.
- Paged tools print `nextCursor: <value>` in their text (was `next_cursor:`), matching `structuredContent`.
