# relic-bridge

## 0.9.0

### Minor Changes

- 44faed0: The call budget is now unmistakably per tool call (NEW-02, BUG-28). `whoami` reports `limits.perCallBudget` (the most New Relic calls one tool call may make) instead of `callBudget`, `callsUsed` and `callsRemaining`, which only described `whoami`'s own call and looked like a broken running total. Its text points to rate limits and grant quotas for limits across calls, and the docs say the same. These output fields were removed: reconnect your MCP client after upgrading so it reads the new tool schema.

### Patch Changes

- 9a86880: Tool output schemas no longer forbid extra properties, so a client that connected before an upgrade no longer rejects results that gained fields (for example `whoami` after 0.7.0 to 0.8.0, NEW-01). Input validation is unchanged. **Reconnect your MCP client after upgrading relic-bridge** to see new tools and parameters: a stateless server cannot signal a changed tool list.
- 41a8ecd: `partial` now means involuntary truncation only (0.8.0 verification run, 2026-10-13, NEW-05). Golden metrics left out by your own `max_metrics` (and related entities left out by `max_dependencies`) no longer set `partial: true` or a `partial` status in `get_golden_metrics`, `entity_health`, `dependency_health` and `generate_alert_insights_report`; they are listed as `skipped` with a `reason` (`max_metrics`, `budget`, `error` or `no_data`). A cut forced by the request budget or an error still sets `partial`.
  
  `list_recent_issues` with `group_by` now counts the whole requested window, not only the returned page (NEW-07). The window is read in up to 4 extra pages, counted in the declared cost; if it is larger or the budget runs out, the counts cover the page and the new `groupsScope` field says `page` (a note says why). `groupsScope` is always present.
- 5bdea2f: - `list_top_transactions` with `sort_by: slowest` now skips transactions with fewer than `min_requests` requests (default 10), so one-request transactions no longer top the ranking (NEW-03).
  - `list_event_types` lists global event types only in `globalEventTypes`, no longer also in `eventTypes` (NEW-04).
  - The automatic seasonal baseline of `analyze_transactions` and `analyze_deployment_impact` prefers the same windows 7 days earlier for windows of 24 h or more or across a weekend, when the `maxWindowDays` limit allows it; otherwise it uses 1 day and says which `maxWindowDays` a weekly control needs (NEW-06).
- fd46afe: `trace_error` now says span data is missing whenever the account or entity has no `Span` events, even if errors carry a trace id (BUG-12), and notes when its tracing check could not run.

## 0.8.0

### Minor Changes

- 99c8916: Name lookups can be narrowed with optional `domain` and `type` (for example `domain: "APM"`) on every tool that takes `name`, so an app that also has a same-named browser entity no longer fails with an ambiguity error. The ambiguity error now suggests `domain`. APM-only tools (transactions, deployment impact, threads, GC) keep resolving a bare name to the APM entity.
- 5942246: Deployment and transaction verdicts are more reliable. `analyze_transactions` and `analyze_deployment_impact` now call a change in error rate when |z| >= 3 and at least 5 errors more or fewer than expected (a strong z-score under half a percentage point is no longer "similar"), and every note says which rule decided. New optional `baseline` input (`previous_window`, `same_window_1d_ago`, `same_window_7d_ago`): when the throughput shifted a lot between the windows (for example the overnight trough) the same windows one day earlier are compared as a control (2 extra queries), and a change that also happened then is a `warning` instead of `regression_suspected`.
- e0ebb62: `maxWindowDays` now limits how far back a query reads as well as how wide it is: `SINCE 60 days ago UNTIL 59 days ago` (and the same with dates, epoch seconds or milliseconds, `COMPARE WITH` offsets, or subqueries) is refused with `RB_LIMIT_QUERY`, in `run_nrql` and in every tool that reads a time window. Exactly `maxWindowDays` days is still allowed.

### Patch Changes

- 75d5976: Fix `list_change_events` in account scope returning no APM deployments: the account-wide change feed does not carry deployments recorded through the APM deployment API, so the tool now also reads the deployments of up to 50 of the account's APM applications and merges them (limits are reported in a new `notes` field). Events no longer come back with `type: null`; the type is taken from the category when NerdGraph leaves it empty.
- 5a2c88d: Error contracts and polish from the live test run: `get_query_result` with an unknown or expired id now fails with the new `RB_QUERY_NOT_FOUND` code and a "rerun run_nrql" hint; a `run_nrql` query with several `;`-separated statements is refused with "one NRQL statement per call"; limit and time-range errors show their details as plain text instead of wrapping them as untrusted New Relic data; `whoami` reports `callsUsed` and `callsRemaining` and states that the call budget is per tool call; `list_event_types` flags global types (`Public_*`, `NrUsage`, ...) that cannot be mixed with account data (`globalEventTypes`); `get_attributes` takes `name_contains` to narrow large attribute lists.
- f169613: Golden metrics: the value and trend now ignore the time bucket that is still filling (no more "throughput 0" or a false drop), the trend compares equal halves of the complete buckets, `timeseries: false` really returns one aggregate without `TIMESERIES`, signals read "down 39%" instead of "down -39%", and query adjustments such as "LIMIT MAX replaced" are stated once instead of on every metric.
- e265186: Golden-metric trends (`get_golden_metrics`, `entity_health`) now compare the window with the previous equal window, like `analyze_transactions`, instead of the two halves of one window (live test run, 2026-10-12, BUG-06). This adds one query per metric, counted in the request cost; beyond the window limit the old halves method is used and a note says so.
- 5a6343b: `list_recent_issues` takes `group_by` (`condition` or `entity`) and counts the returned page per group, so repeated alerts for one condition or host collapse into a short summary.
- 7fb8c15: `analyze_deployment_impact` and `analyze_transactions` now apply the same |z| >= 3 rule to average and p95 latency as to error rate and throughput: the window query adds the standard deviation of duration, and a latency move beyond the 15% band and 5 ms only counts as `worse` or `better` when it is statistically significant. Noisy low-traffic windows no longer give false latency regressions, and each `note` names the rule and the z value (BUG-07).
- a4a85e9: Fix `list_top_transactions` failing on every call: the generated NRQL used `ORDER BY` after `FACET`, which NRDB rejects. The ranking aggregate (p95, error count or request count per `sort_by`) now leads the SELECT list, which is how NRDB orders facets.
- 1a65af5: Log tool fixes from the live test run (2026-10-12): `analyze_entity_logs` message patterns no longer fail with a too-large response on busy entities (messages are cut at New Relic, at most 20 patterns with one example each, and a too-large sample is repeated smaller instead of dropping the section); `list_recent_logs` and `analyze_entity_logs` share one level vocabulary that also accepts the Monolog/syslog names (`warning`, `notice`, `critical`, `alert`, `emergency`); `time_range: "last 7 days"` is accepted with a 7-day limit (whole-second rounding no longer counts against the window); `list_recent_logs` paging keeps one fixed `since`/`until`, never returns lines outside it and no longer skips or repeats lines with equal timestamps; lines with an empty `message` show their `log` or `logged_message` field, or a short attribute summary.
- deca849: Fix `list_recent_logs` failing with a response-too-large error on accounts with very wide Log events: it now reads a fixed set of columns (timestamp, level and its aliases, message, `log`, `logged_message`, `messageId` and a few context attributes) with long text cut at New Relic, instead of every attribute. Lines without a `message` still fall back to `log`, `logged_message`, then a short summary built from that small context set.
- d8b68ab: Fix the relationship tools. `get_related_entities` with `types` no longer returns an empty list for hosts: the kind is matched on each neighbour's real domain and type across several pages, and edges from the entity to itself are left out with a note. `dependency_health` now skips key transactions, service levels, alert objects, workloads and dashboards, reads several relationship pages, and measures hosts and called services first. `decode_entity_guid` reports infra host guids as type HOST (inferred) instead of `NA`.
- f94ccbe: Report and issue fields fixes:
  
  - `generate_user_impact_report` fills front end names from the app events and reports `sessionsWithErrors` as unknown (null, with a note) instead of 0 when JavaScript errors carry no session id; the `js_errors_up` threshold (rate 1.5x, 10+ errors) is documented.
  - `list_error_groups` and `entity_health` fill `lastSeenAt` from the in-window occurrences when the group has none.
  - `trace_error` says distributed tracing appears to be disabled when no traced occurrence is found and the entity or account has no Span or traced error data.
  - `search_incidents` parses JSON-encoded titles into `titles[]` and a joined `title`.
  - `list_recent_issues` adds a `groups` summary and a text header when several issues on the page share a condition.
- c1fcb9d: `list_error_groups`, `list_recent_issues` and `generate_alert_insights_report` now return short permalinks (entity redirect, issue page with account) instead of long launcher URLs that were cut off with "…" and made the output much larger. Links are left out under `minimal_output`.
- 642d8ac: Fix `list_synthetic_monitors` failing on every call: the monitor status is now read from `monitorSummary { status }`, because NerdGraph has no `status` field on the monitor outline type.

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
