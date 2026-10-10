# relic-bridge

## 0.7.0

First published release. It contains everything built in Phases 1-7: local stdio, self-hosted HTTP, Cloudflare
Worker, sign-in and admin panel, OAuth 2.1 for MCP clients, the extended tool set and the power features below.
Versions 0.1.0-0.6.x were never published; the 0.1.0 notes are kept below for reference.

### Minor Changes

- Claude Code plugin (P7-07): MCP config, skills and commands for using relic-bridge from Claude Code.
- Config import and export (P7-06): move projects, grants and quotas between servers as one validated file, without secrets.
- Doctor command (P7-05, P7-17): checks configuration, keys, accounts and client configs, and says how to fix what it finds.
- Per-grant usage quotas (P7-12): daily and monthly caps on New Relic calls and inspected events, with a soft warning and RB_LIMIT_QUOTA past the cap.
- MCP Tasks (P7-13, P7-21, P7-22, P7-23, P7-29): long composite reports run as tasks with polling, cancel, notifications and compare-and-swap task records.
- OS keychain support (P7-11, P7-30): keep New Relic keys in macOS Keychain, Windows Credential Manager or libsecret; helper programs run by absolute path.
- OpenTelemetry export (P7-08, P7-18): traces, metrics and allowlisted logs to your own OTLP collector; filesystem paths are never exported (P7-30).
- Paging and limits are the same on every list tool (P6-24). Breaking, listed with the P6-22 renames: `list_change_events` and
  `list_recent_logs` page with `cursor` / `nextCursor` (newest first, by time) instead of `truncated`; `get_related_entities`
  pages and no longer returns `truncated`; `list_alert_policies`, `list_alert_conditions`, `list_recent_issues`,
  `search_incidents` and `list_error_groups` take `limit` (default 25 to 50, max 200) and the cursors they return are
  composite and bound to the tool, account and filters (a NerdGraph cursor passed back as is is refused); `list_accounts`,
  `list_entity_types` and `list_event_types` take `limit` and `cursor` (`list_accounts` no longer returns `truncated`).
  On time-windowed lists a cursor keeps the window of the first call. `list_top_transactions` and `get_attributes` stay
  bounded and say so in their descriptions. The `tools/list` budget in the offline eval grew from 52 000 to 53 500
  characters for the new `limit` and `cursor` arguments.
- **Breaking (pre-1.0): one name per concept in tool arguments and structured output (P6-22).** Tool names are unchanged,
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
- New tool `get_ui_link` (P7-03): offline links that open an entity, dashboard, NRQL query (query builder) or alert issue
  in the New Relic UI, with the US or EU host of the connection. Built only from validated ids and never from chart URLs.
- Opt-in write tools (P7-09, P7-19, P7-20, P7-25, P7-26): a few small changes in New Relic (record a change, acknowledge or close an alert issue, create a dashboard). Off by default at every layer, per grant, audited before each mutation, with confirmation or human approval.

### Patch Changes

- Phase 6 review nits: `entityQuery.and()` parenthesises parts containing `OR`, `generate_user_impact_report` no longer mislabels
  front ends when an entity name is empty, and section summaries say "skipped (budget or grant, see the section notes)".

## 0.1.0 (never published; included in 0.7.0)

### Minor Changes

- First release: local stdio MCP server for New Relic NerdGraph.

  - Tools: `whoami`, `list_accounts`, `time_range`, `run_nrql`, `get_query_result`, `search_entities`, `get_entity`,
    `decode_entity_guid`, `get_related_entities`, `list_entity_types`, `get_golden_metrics`, `list_event_types`,
    `get_attributes`.
  - Env mode (one account) and YAML mode (several projects, `${VAR}` key references).
  - Safety: read-only tools, NRQL query limits and allow/deny lists, untrusted-data envelopes, secret redaction,
    per-call NerdGraph budget.
