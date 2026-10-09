# Phase 6 — pending decisions

Decisions that agents could not make alone during the autonomous run (2026-10-03). Each entry says what was
assumed so work could continue. Review, then answer in place or move the outcome into an ADR / task file.

Format: `### <task id> — <short title>` then **Context**, **Assumption made**, **Options**, **Needs**.

## Workflow

### ALL — stacked PRs instead of merging to `main`
- **Context:** The owner was away. Every task PR targets the previous task's branch (the first one targets
  `phase/6-tool-parity` (itself stacked on the tip of Phase 5, `task/P5-12-review-followups`)), so nothing is merged into `main`.
- **Assumption made:** A dependency counts as satisfied when its task is `review` and its branch is lower in the
  stack. Tasks stay `review`, not `done`, until their PRs are merged.
- **Options:** merge the stack bottom-up (retarget each PR to `main` after its parent merges), or squash-merge the
  tip into `main` in one go.
- **Needs:** owner's merge strategy; then mark merged tasks `done` and run `pnpm tasks index`.

## P6-01 — Alert tools

### P6-01 — nrqlConditionsSearch not live-verified; one account per call
- **Context:** `policiesSearch` has a live sample (P0-09); `nrqlConditionsSearch` (and `queryLike`) is only introspected, and
  neither search has a `limit` argument, so page size is NerdGraph's. Cursors belong to one `account(id:)` search.
- **Assumption made:** both tools read exactly one account per call (the default account unless `account` is given) and
  select only `AlertsNrqlCondition` interface fields. The condition's `dataAccountId` is shown as a number; legacy
  (non-NRQL) conditions and mutations are out of scope.
- **Options:** (a) keep as is; (b) add a live probe for `nrqlConditionsSearch` when a key is available; (c) fan out over all
  allowed accounts with a composite cursor (only worth it if agents ask for it).
- **Needs:** a live run with a User key to confirm shapes and page size (`pnpm test:live`).

## P6-02 — Issue and incident tools

### P6-02 — aiIssues is experimental and only introspected; cross-account issues hidden; no NRQL fallback
- **Context:** `aiIssues` needs an opt-in header and is unstable. The only live sample (P0-09) returned empty lists, so row
  shapes (notably the scalar-typed incident `accountIds`/`entityGuids`, and what `timeWindow` filters on) are from
  introspection. The incident filter has no text search.
- **Assumption made:** one account per call; a row is dropped whole when any account id or entity GUID it carries is not
  allowed (so an issue spanning an allowed and a foreign account is invisible); `search_incidents.contains` filters the fetched
  page client-side; no `NrAiIssue`/`NrAiIncident` NRQL fallback (the API has every field in scope; `run_nrql` can still query them).
- **Options:** (a) keep as is; (b) a live probe with real issues to confirm shapes (`pnpm test:live`); (c) show cross-account
  issues with the foreign parts removed; (d) add the NRQL fallback if a field turns out missing.
- **Needs:** a live run on an account with issues; owner's call on (c).

## P6-03 — Errors Inbox tool

### P6-03 — errorsInbox only introspected; groups without an entity GUID hidden; no sort ascending
- **Context:** The only live sample (P0-09) returned an empty list, so row shapes, what the free-text `query` matches, whether
  `occurrences` follows `timeWindow`, and the page size are from introspection. `ErrorsInboxDirection` has only `DESC`.
- **Assumption made:** one account per call (`filter.accountIds`); a group is shown only when its `entityGuid` decodes to the
  requested allowed account, so custom groups without a GUID are dropped (and flagged); the assignee email and `resources` are
  not selected.
- **Options:** (a) keep as is; (b) live probe with real error groups (`pnpm test:live`); (c) show GUID-less groups on the
  strength of `accountIds` filtering alone; (d) add assignee display (masked) if wanted.
- **Needs:** a live run on an account with errors; owner's call on (c) and (d).

## P6-04 — Change tracking and deployment impact tools

### P6-04 — change tracking only introspected; entity scope is deployments only; impact is APM only with fixed thresholds
- **Context:** No live sample exists for `changeTrackingSearch` or `deploymentSearch`, so row shapes, the `limit` ceiling and
  the syntax of the filter `query` are from introspection. Neither search pages, and `changeTrackingSearch` cannot be filtered
  by entity with a verified syntax. Whether `Transaction.entityGuid` and the single-percentile result shape hold for every
  APM agent is unverified.
- **Assumption made:** `list_change_events` shows every event kind per account, and with `entity_guid` only that entity's
  deployments; events without an entity are hidden. `analyze_deployment_impact` handles APM applications only, compares equal
  windows (default 30 minutes) on `Transaction` (throughput, error percentage, average and p95 duration), and applies fixed
  thresholds (30 transactions per window, 15% latency band, 25% throughput band, error-rate z of 3 and 0.5 pp). Cost is 3.
- **Options:** (a) keep as is; (b) live probe with real deployments (`pnpm test:live`); (c) use `query` to filter other change
  kinds per entity once its syntax is verified; (d) support browser/mobile/OTel services; (e) make thresholds arguments.
- **Needs:** a live run on an account with recorded deployments; owner's call on (c) to (e).

## P6-05 — APM transaction tools

### P6-05 — NRQL result shapes unverified; no entity-type check; fixed sort keys
- **Context:** No live sample exists for `FACET name` results over `Transaction`, so the facet key, the shape of multi-percentile
  selects and NRQL `ORDER BY` / `LIKE` behaviour are from documentation and the P6-04 assumptions.
- **Assumption made:** `list_top_transactions` sorts by p95 (slowest), error count or request count and re-sorts client-side;
  `analyze_transactions` compares with the equal window before (the P6-04 thresholds). Neither looks the entity up (the account
  comes from the GUID, cost 1 and 2), so a non-APM GUID returns no rows instead of an error. Percentiles use three single-value
  selects. Web/background is `transactionType` `Web`/`Other`.
- **Options:** (a) keep as is; (b) live probe on an APM account (`pnpm test:live`); (c) add an entity lookup (cost +1) to refuse
  non-APM entities with a clear error; (d) minimum-requests filter for the slowest sort; (e) a time series per transaction.
- **Needs:** a live run on an APM account; owner's call on (c) to (e).

## P6-06 — Log tools

### P6-06 — Log attribute names and level spellings unverified; extra redaction kept local; sampled patterns
- **Context:** No live sample exists for `Log` queries here. `entity.guid`, `level`, `message`, `LIKE` case sensitivity,
  `TIMESERIES <n> seconds` and the non-aggregate row ceiling are from documentation and the earlier phases' assumptions.
- **Assumption made:** `list_recent_logs` filters by `entity.guid` (or the whole account) and matches levels against fixed case
  variants; `analyze_entity_logs` computes message patterns client-side from the newest 1000 lines (numbers, ids, UUIDs, times,
  addresses normalised), counts by `FACET level`, and finds bursts (24 buckets, at least 10 lines and 3 times the median).
  Cost 1 and 3. Extra secret patterns (JWT, cloud/VCS/Slack/Stripe tokens, URL credentials, PEM keys) live in `logs.ts`, not
  in the central `redact()`, so other tools' output is unchanged.
- **Options:** (a) keep as is; (b) live probe on an account with logs (`pnpm test:live`); (c) move the extra patterns into the
  central `redact()` (affects every tool and the logger; needs a snapshot review); (d) mask emails and IP addresses in log
  lines; (e) server-side patterns with `FACET message` or `aggregationEndpoint`-style sampling; (f) per-connection default
  `Log` deny.
- **Needs:** a live run on an account with logs; owner's call on (c) to (f).

## P6-07 — Runtime tools

### P6-07 — JVM metric names and Kafka event types unverified; Kafka scoped by account, not entity
- **Context:** No live sample exists. Metric timeslice names (`Threads/SummaryState/*`, `GC/*`, `Memory/Heap/*`, `CPU/*`) and the `nri-kafka`
  event and attribute names are from documentation and memory (see RESEARCH). Kafka cluster entities are not reliably tied to a
  GUID that appears on the samples.
- **Assumption made:** `analyze_threads` (cost 2) and `list_gc_metrics` (cost 1) read `Metric` timeslices by `entity.guid` and report
  average, peak, total and samples as reported (no unit conversion); `analyze_kafka_metrics` (cost 3) takes an account plus optional
  `cluster_name`, `consumer_group`, `topic` and reads `KafkaOffsetSample`, `KafkaTopicSample`, `KafkaBrokerSample`. Missing data is a
  normal answer naming what was looked for. Lag imbalance is worst partition over the mean partition lag.
- **Options:** (a) keep as is; (b) live probe on a Java APM account and a Kafka account (`pnpm test:live`); (c) dimensional APM metrics
  (`apm.service.*`) instead of timeslices; (d) OpenTelemetry Kafka metrics and MSK/Confluent integrations; (e) entity-GUID scoping for Kafka
  (cluster entity); (f) thread dumps from the profiler (separate, heavier tool).
- **Needs:** a live run on both account types; owner's call on (c) to (f).

## P6-08 — Synthetics tool

### P6-08 — Synthetic entity fields and SyntheticCheck attributes unverified; type/status filtered client-side
- **Context:** No live sample exists. `SyntheticMonitorEntityOutline` fields (`monitorId`, `monitorType`, `monitoredUrl`, `period`,
  `status`) and `SyntheticCheck` attributes (`entityGuid`, `location`, `result`, `duration`, `error`, `timestamp`) are from documentation
  and memory (see RESEARCH). A wrong field name makes the search fail (GraphQL error) or the results come back empty.
- **Assumption made:** `list_synthetic_monitors` (cost 2) searches `domain = 'SYNTH' AND type = 'MONITOR'` in one account, applies
  `monitor_type` and `status` to the returned page (their server-side search fields are not confirmed, so a page can hold fewer matches
  than `limit`), then reads one `SyntheticCheck` query for the page's monitors faceted by monitor and location (failure percent, average
  duration in ms, latest result and latest failure message). A failed or denied results query still returns the monitors as `partial`.
  Scripts, secure credentials and headers are never read.
- **Options:** (a) keep as is; (b) live probe on an account with monitors (`pnpm test:live`); (c) server-side type/status filters once
  the field names are confirmed; (d) time series per monitor; (e) include the script's last-run error steps for scripted browser
  monitors (needs a separate, secret-aware design); (f) private-location health.
- **Needs:** a live run on an account with synthetics; owner's call on (c) to (f).

## P6-09 — Dashboard tools

### P6-09 — Widgets are not executed; widget field names unverified
- **Context:** The task allowed an optional `run_dashboard_widget`. A widget's NRQL is raw NRQL authored by a third party and may name
  another account; no live sample of `rawConfiguration` exists (see RESEARCH).
- **Assumption made:** `list_dashboards` and `get_dashboard` (cost 1 each) only return data. Widget NRQL is shown (inside the untrusted
  envelope) so an agent can pass it to `run_nrql`, which enforces the `rawNrql` switch, scope and limits. Widgets with queries for
  accounts outside the connection (or no account id) have NRQL and markdown withheld. Only widgets with `nrqlQueries` or markdown
  `text` yield content.
- **Options:** (a) keep as is; (b) add `run_dashboard_widget` going through `runRawNrql` (needs the rawNrql switch and a decision on
  `TIMESERIES`/variable substitution); (c) live probe on an account with dashboards (`pnpm test:live`); (d) dashboard variables and
  time-picker substitution in returned NRQL.
- **Needs:** a live run; owner's call on (b) and (d).

### P6-09 — `pnpm bench:cpu` flags `mcp.tools-list.hit` (about 2.05x, threshold 2x), also on the P6-08 base
- **Context:** Measured on the unmodified base branch (P6-08) and with P6-09: both report about 2.0x versus the stored baseline, so the
  regression predates P6-09 and grows with the tool count (every Phase 6 tool adds schema to serialise on `tools/list`).
- **Assumption made:** left as is; no baseline change in a tool task.
- **Options:** (a) re-baseline after Phase 6; (b) cache the serialised `tools/list` payload per tool set; (c) lazy tool groups.
- **Needs:** owner's call.
- **Update (P6-10):** profiled and fixed. The cause was per-request JSON Schema conversion of every tool schema by the MCP SDK
  (on `registerTool` and again on `tools/list`), not payload size. Schemas are now converted once per isolate
  (`withCachedJsonSchema`); `tools/list` hit went from about 10.5 ms to 1.6 ms and the baseline was re-taken. No decision needed
  unless the owner prefers not to re-baseline inside a task branch.

## P6-10 — Composite reports

### P6-10 — Reports reuse sibling tools; one primary entity; fixed thresholds; front-end attributes unverified
- **Context:** The reports aggregate up to six tools. No live sample exists for an issue lookup by `ids`, nor for `entityGuid` on
  browser/mobile events (see RESEARCH). The insights report covers only the issue's first entity.
- **Assumption made:** `generate_alert_insights_report` (cost 14) and `generate_user_impact_report` (cost 9) call the sibling tools'
  handlers directly; sections are planned against the remaining budget (golden metrics shrink first, others are all-or-nothing) and
  run in parallel; any authorization error aborts the whole report (fail closed, like the other multi-part tools). Front ends are
  found through one-hop relationships only (at most 3 lookups). Impact flags use fixed thresholds. MCP Tasks are not used (P7-13).
- **Options:** (a) keep as is; (b) cover every issue entity (cost grows per entity); (c) make thresholds arguments; (d) degrade a
  section on `RB_AUTH_FORBIDDEN` instead of failing the report; (e) live probe (`pnpm test:live`) for the `ids` filter and the
  browser/mobile attributes.
- **Needs:** a live run on an account with issues and browser/mobile apps; owner's call on (b) to (d).
