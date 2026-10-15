# relic-bridge

## 0.11.0

### Minor Changes

- 56df551: Sensitive admin actions now need a recent sign-in. From an admin session, master-key rotation, configuration import,
  owner setup links, unbinding a user, the OAuth client and registration settings, replacing a stored New Relic key,
  deleting a project, creating an administrator or owner, changing a role, disabling or re-enabling a user, signing
  another user out and device tokens longer than 90 days (or `never`) require a sign-in from the last 10 minutes
  (`RB_SESSION_REAUTH_MINUTES`, 1 to 60). Otherwise the admin API answers `403 forbidden` with
  `detail: reauth_required`. The admin panel sends you through sign-in and back to the page. The admin token used by
  the CLI is not affected.
- 0822a6e: CLI fixes:
  
  - `relic-bridge doctor` no longer changes what it checks. It opens the database read-only. Before, it set the file
    mode to `0600` and the journal mode to WAL, then printed a `chmod 600` warning from the old mode. Now the warning
    stands until you fix it. The new `doctor --fix` sets a group- or world-accessible database file to `0600` and says
    what it changed.
  - `audit purge --older-than-days` takes a whole number of days from 1 to 99999. A value such as `1.5`, `1e3` or `0x10`
    is refused with exit code 2, by the command itself as well as by the argument parser.
  - `config import` and the Admin API now use the same 1 MiB limit. `POST /config/import` accepts bodies up to 1 MiB
    (it was 64 KiB, too small for a bundle with encrypted keys). The CLI refuses a larger file, or a larger import
    request, before sending it, and its error message gives the limit. The other admin routes keep the 64 KiB limit.
  - The `RB_AUDIT=off` startup warning (`serve` and the Worker) now says that it disables every audit row: tool
    calls, refusals and admin changes.
- 4917c96: Deprecated configuration is now announced where you run it. A new registry lists every deprecated environment
  variable, config-file key and CLI flag with its replacement and the release that removes it. While you use one,
  `relic-bridge serve` and the stdio server print one warning per name on stderr at startup, the Cloudflare Worker logs
  one warning per deprecated variable once per isolate, and `relic-bridge doctor` adds a `deprecated-config` line for
  each (one `ok` line when there is none). Only the name is shown, never its value. Nothing is deprecated today, so the
  list is empty and only the `doctor` line is new.
- 041f2be: HSTS is on by default for a public https server. When `RB_PUBLIC_URL` is an https URL and `RB_HSTS` is unset or
  `auto`, `relic-bridge serve` now sends `Strict-Transport-Security: max-age=31536000; includeSubDomains` on every
  response, even though it sees plain http behind a TLS-terminating proxy. Before, it was only sent with `RB_HSTS=true`
  or when the request itself arrived over https. `includeSubDomains` makes browsers use https for every subdomain of
  that host for a year: set `RB_HSTS=false` if other hosts under the same domain still serve plain http. An https
  `RB_PUBLIC_URL` does not declare a TLS proxy: pass-through still needs `RB_HSTS=true` to accept plain-http requests
  from the proxy. On Cloudflare Workers, the `503` answered while the Worker cannot start now carries HSTS too.
- 705f3a5: **Breaking**: removed `whoami` `limits.callBudget` (deprecated in 0.9.1, announced for removal in 0.11.0); read
  `limits.perCallBudget`, which has the same value. Reconnect your MCP client after upgrading.
- 3003f93: Supported migration from a self-hosted server to the Cloudflare Worker. `relic-bridge db export <file> --format d1`
  writes the server's SQLite database as a SQL file that `wrangler d1 execute <database> --remote --file <file>` imports
  into the Worker's D1 database: device tokens, encrypted New Relic keys, projects, grants, settings and the audit log
  (`--no-audit` leaves it out) move; sessions and OAuth connections do not. Nothing is decrypted, the file is created
  with mode 0600 and never overwritten without `--force`, and the import refuses a D1 database that already has data.
  `pnpm cf:setup --master-key-stdin` sets up the Worker with the server's existing master key instead of generating
  one; that key is never printed or written to `--backup-file`. See "Migrate from a self-hosted server" in the
  Cloudflare guide.
- 0ed8f1e: Setup links keep their one-time code out of URLs, logs and `Referer`. A link now looks like `<RB_PUBLIC_URL>/auth/setup?provider=<id>#setup=rb_setup_…`: the code is in the URL fragment, which browsers never send to a server, and a small setup page posts it in a same-origin form before the sign-in choice. Links with the code in the query string (`?setup=`) are refused with a page that asks for a new link.
  
  Upgrade note: setup links created before this version no longer work; issue a new one with `relic-bridge setup-link`.
- 800f1de: `trace_error` now follows error groups from OpenTelemetry services (Span-sourced groups in Errors Inbox). It matches their spans on the span name and status description, takes the latest traced error and continues into the trace, as it already did for APM groups. Groups from other sources (for example browser JavaScript errors) are still refused with a hint.

### Patch Changes

- 4ad99b3: `get_dashboard` now returns each widget's visualization. Every widget used to read back with `visualization: null`, because New Relic's dotted ids (`viz.line`) failed the code-label check. Built-in charts show as `line`, `area`, `bar`, `billboard`, `pie`, `table` and `markdown`, the values `create_dashboard` takes; other ids appear in full when they match a strict pattern. The observability dashboard's "Server error %" widget no longer says it needs an unreleased version.
- 74ae191: `generate_user_impact_report` with an `issue_id` and a `time_range` longer than the connection allows is now refused before it looks the issue up, like every other tool; it used to spend one New Relic request on the lookup first.
- 0694c57: Three input checks are stricter. `RB_OTEL_HEADERS` values must decode to Latin-1 text without control characters (tab allowed): anything else now stops start-up with a configuration error that names the header but not its value, instead of every export failing later. NRQL with unbalanced parentheses is refused before it is sent, so the `LIMIT` added to a raw event query can no longer land inside an open parenthesis. A log field named `ts`, `level` or `msg` is written as `field_ts`, `field_level` or `field_msg` and no longer replaces the record's own timestamp, level or message.
- 6e31fc8: OAuth dynamic client registration now refuses a `client_name` that starts or ends with a control, format or line-separator character (for example a trailing tab or a leading U+FEFF). Such names used to pass the check because it trimmed them first, and were then stored as sent. Pages already showed the cleaned-up name.
- 74ae191: Revoking a user's OAuth app through the admin API (`POST /api/admin/v1/users/{id}/oauth-devices/{deviceId}/revoke`) with an unknown user id now writes its `oauth_device.revoke` audit row with the `not_found` error, like every other failed admin change. It used to answer 404 without a row.
- 91e58e8: `get_golden_metrics` now says what each metric's trend got when the previous window is beyond the window limit: the halves of the window, or no trend when there are too few points (it used to claim the halves for every metric). The documentation also gains a timeout query that facets by `service.version` without hiding records that have no `mcpMethod`, and the Cloudflare and self-hosting guides give the same upgrade steps as the upgrade guide (check out a release tag instead of pulling `main`).

## 0.10.0

### Minor Changes

- 6837e8e: Self-monitoring separates caller errors from server errors. Only server errors (New Relic unreachable, rate limiting or timing out, an unexpected answer, a refused stored key, internal errors) set span status ERROR and `error.type`, and `rpc.server.duration` now also carries `rpc.grpc.status_code` for them, so the New Relic service's Error rate counts them (it stayed 0 before). Caller errors (invalid input, limits, quotas, unknown query ids, tools or accounts not granted) leave the span status unset, so they no longer open Errors Inbox groups; they are still counted by `status`, `error.code` and the new `fault` attribute (`caller`/`server`). Alerts on span status ERROR now see server errors only.

### Patch Changes

- 59e4792: Self-monitoring access logs name `server/discover` (the MCP 2026-07-28 discovery request) instead of `mcpMethod = other`.
- db45930: Bound redaction and NRQL masking work on long input: every secret pattern now does work linear in the input, and
  output cells, trailers, column names, error messages and the audit NRQL column redact only the text they keep (with a
  margin so a secret crossing the cap is still recognised). An unterminated NRQL string ending in a backslash is now
  masked too.
- 074ed5e: A malformed `RB_RATE_LIMIT_*` value no longer appears in the startup error, so a secret pasted into the wrong variable never reaches the log.
- bb78276: Hardening from the pre-launch review:
  
  - Event-type allow and deny lists now also cover queries without a `FROM` clause. With a list set, `run_nrql` refuses `SHOW EVENT TYPES` and other FROM-less statements or subqueries (`RB_LIMIT_QUERY`); use `list_event_types`, which respects the lists.
  - `COMPARE WITH` inside a subquery is refused with a clear error (New Relic does not support it there).
  - Requests to NerdGraph (which carry the User API key) and OTLP exports never follow redirects: a 3xx answer fails the request. This also makes OTLP export work on Cloudflare Workers, which rejects the `redirect: 'error'` mode the exporter used.
  - **Behaviour change:** "Don't ask again" on the OAuth consent page is now offered only to apps identified by their client ID metadata document (such as claude.ai). Dynamically registered apps, whose identity is not verified, ask every time. Approvals remembered for them earlier are no longer used or listed.
- 8e93886: OAuth client limits are fairer. Metadata-document clients that completed a token exchange (or hold a grant) can always fetch their document again; records of clients that never completed an exchange are kept for 5 minutes and, when 200 are stored, the oldest one makes room instead of new clients being refused. Dynamic client registration now counts toward the deployment-wide cap only once the registration succeeds, and every attempt that passes the registration policy counts toward the per-address cap, accepted or not.
- 6a4e007: `trace_error` with `error_group_id` finds the group's traced occurrence again (0.9.1 verification, NEW-13). It filtered `TransactionError` on `error.group.guid`, which those events do not have, so it always said no traced occurrence was found. It now looks the group up in Errors Inbox and picks the latest traced error with the group's error class and message on its entity, falling back to class and entity (with a note) when the message does not match exactly. An unknown group id, or a group that does not come from APM `TransactionError` events (OpenTelemetry spans, browser errors), is a clear `RB_INPUT_INVALID` with a hint. When no occurrence is found but other errors carry trace ids, the note says tracing works instead of implying it is off. The call now makes up to 5 requests with `error_group_id`.
- aead7e5: `trace_error` fills `errors[].httpStatus` for every agent (0.9.1 verification, NEW-14). It read only `httpResponseCode`, which the PHP agent sends as a string ("500"), so the status was null. It now takes the first valid HTTP status (100-599) from `http.statusCode`, `response.statusCode`, `response.status` or `httpResponseCode`, numeric or a 3-digit string.
- 4acc0a0: Golden-metric trend notes say why there is no trend (previous window unread, no data in the previous window, too few
  points) instead of always claiming the halves were compared; `changeRatio` null for a zero baseline is documented.

## 0.9.1

### Patch Changes

- c897f62: `get_attributes` now applies `name_contains` before the 1,000-attribute cap (NEW-08). On event types with more than 1,000 attributes, such as Log, a filter whose matches sat past the cut returned an empty list with `truncated: true`. `totalAttributes` is the real count before filter and cap, and `truncated` means the filtered list shown was cut.
- 614ff91: An explicit `baseline: "same_window_7d_ago"` whose control falls outside the connection's lookback limit now falls back to `same_window_1d_ago` in `analyze_transactions` and `analyze_deployment_impact`, instead of running no control and reporting `used: "previous_window"` (NEW-11). `baseline.used` and `reason` name the requested baseline and what ran, and a note stays. The limit is never relaxed.
- edfff5f: `list_recent_issues` no longer falls back silently (0.9.0 verification, NEW-09). When `group_by` counts only the page, `groupsNote` (and a text note) says why and how many issues the counts cover (window too large for the extra requests, request budget, or a failed request). A `limit` above the API page size (50 rows) is reported as `limitNote`, e.g. "limit 200 lowered to 50 (API page size)", instead of returning fewer rows without a word.
- 2f7b3bb: `run_nrql` no longer fails output validation on queries with both `FACET` and `TIMESERIES` (P8-44). NerdGraph returns `totalResult` and `otherResult` as an array of time buckets for that shape; the output schema and text now accept either an object or an array.
- 2330bb5: Self-monitoring logs are easier to use (P8-50). A standalone `GET` stream or `subscriptions/listen` stream that reaches the request deadline now logs `mcp stream closed at deadline` at info instead of an `mcp request timed out` warning; a real request that never finishes still warns. Access-log (`http request`) records now export the integer HTTP `status`, `method` and the matched `route` pattern (fixed sets; never raw paths), so 4xx/5xx can be counted in New Relic. The observability guide now lists the attribute names as New Relic shows them (`tool`, `ms`, `code`, without `log.`). Deadline and access-log records also export the MCP method (fixed list, else `other`) and, for `tools/call`, the tool name.
- 86c809a: Self-monitoring gives the New Relic service entity throughput and response time: relic-bridge now exports the OpenTelemetry `rpc.server.duration` metric (New Relic builds the golden metrics from it), adds `telemetry.sdk.*` and a random per-process `service.instance.id` to the resource, and names spans `tools/call <tool>` so Errors Inbox groups are distinct per tool.
- b5ab36e: `trace_error` now says how many errors carry a trace id when it finds no spans ("none of N errors carry a trace id" or "even though K of N errors carry a trace id") instead of always claiming some do (NEW-10). The count is folded into the existing tracing check query.
- 0c719e6: `whoami` returns `limits.callBudget` again, as a deprecated alias with the same value as `limits.perCallBudget` (NEW-12). Version 0.9.0 renamed `callBudget` to `perCallBudget` and removed `callsUsed` and `callsRemaining` without a deprecation path. The alias will be removed in the minor after next, so switch to `perCallBudget`. `callsUsed` and `callsRemaining` stay removed: the budget is per tool call, not a running total. The `whoami` description now says what `perCallBudget` means.

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
