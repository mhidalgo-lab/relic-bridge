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

## P6-11 — MCP prompts

### P6-11 — Prompt set, "any of" gating, no k8s tools, no completion or resources
- **Context:** Seven prompts ship as static templates. There is no Kubernetes tool (no task covers one), and prompt arguments
  are strings only in MCP.
- **Assumption made:** a prompt is listed when at least one of its tools is allowed, and steps for other tools are dropped (a
  prompt with fewer steps is still useful). The Kubernetes prompt uses `run_nrql`, `list_event_types` and `get_attributes` and
  assumes the standard `K8s*Sample` event types (unverified live). Values are quoted JSON strings, 200 characters at most,
  one line. No argument completion and no per-project custom prompts.
- **Options:** (a) keep as is; (b) require all tools of a prompt (hide more prompts); (c) add a Kubernetes tool task;
  (d) `completion/complete` for entity guids and issue ids; (e) owner-defined prompts per project.
- **Needs:** a live check of the Kubernetes prompt; owner's call on (b) to (e).

## P6-12 — MCP resources

### P6-12 — Schema resources reuse the tools; fixed 24 h window; original NRQL cheat sheet; no completion or subscriptions
- **Context:** The task asked for a per-project schema resource. Resources are per connection (grant), not per project, and the
  server has no resource subscription or completion support.
- **Assumption made:** three resources (static NRQL reference, event types per account, attributes per event type) that call the
  `list_event_types` / `get_attributes` handlers (so authz, limits, cache, budget and audit are shared). Fixed last-24-hours
  window. `resources/list` shows one event-types URI per effective account; attributes are never listed. The NRQL reference is
  original text of about 3 KB with a link to the official docs (nothing copied). Reads show in the audit as `list_event_types` /
  `get_attributes` tool calls, and a resource is hidden when its tool is not allowed.
- **Options:** (a) keep as is; (b) own audit action `resource.read`; (c) a `since` query parameter or a combined
  "schema snapshot" resource with attributes of the top event types (costs one call per type); (d) `completion/complete` for
  event types; (e) richer NRQL reference (functions list) once a licence-safe source is agreed.
- **Needs:** owner's call on (b) to (e); a client check that real MCP clients surface templated resources.


## P6-14 — Fuzzy entity-name resolution

### P6-14 — Resolver ships as a tool; other entity tools do not take names yet; fallback scan is capped
- **Context:** The task asked for a resolver "used by every tool that takes an entity". Changing the input schema of every
  guid-taking tool (and their authz/contract cases) is a wide change.
- **Assumption made:** this task adds the shared `createEntityResolver` and a `resolve_entity` tool; the model resolves a name
  first, then passes the guid. Name lookup is a server-side `name LIKE` search, and only when it finds nothing a catalogue scan
  of at most 600 entities per call is matched locally (normalised names such as "shipping service" vs "shipping-service").
  Cache TTL 5 minutes, 64 entries, keyed by credential, region, effective accounts, filters and query. A bare guid is
  accepted offline without checking it exists.
- **Options:** (a) keep as is; (b) follow-up P6-17: accept `name` (via the resolver) in `get_entity`,
  `get_related_entities`, `get_golden_metrics` and report tools; (c) raise the scan cap or page it for very large accounts;
  (d) verify a pasted guid with one `get_entity` call.
- **Needs:** owner's call on (b) to (d).

## P6-15 — Raw NerdGraph tool decision

### P6-15 — No raw NerdGraph tool (ADR-0014); opt-in design parked as P7-15 (blocked)
- **Context:** Several community servers ship an ungated GraphQL passthrough (prior-art S2); the official server does not.
  A raw document bypasses read-only annotations and the OAuth `mcp:read` consent (mutations), the account allowlist and
  GUID checks (`actor.account(id:)`, `entitySearch`, `accounts`), and can select key-revealing fields
  (`actor.apiAccess ... key`) or side-effecting ones (`embeddedChartUrl`). A safe validator needs the `graphql` parser,
  schema-aware argument checks and per-row result filtering: large, and costly on Workers.
- **Assumption made:** ADR-0014 accepted as "no raw tool"; missing NerdGraph reads become typed tools. Implemented only
  guards: `defineDocument` refuses subscriptions and requires `{ mutation: true }` for mutations (none use it), plus tests
  that fail on a passthrough-shaped tool or any non-query request. The safest opt-in form is specified in
  P7-15 (`status: blocked`), not built.
- **Options:** (a) keep "no raw tool" (recommended); (b) build P7-15 (off by default, separate grant, never on OAuth or
  pass-through, parsed query-only, allow-listed root paths, account and field checks) after a new ADR; (c) build P7-15 for
  stdio/self-hosted bearer connections only; (d) drop P7-15 entirely.
- **Needs:** owner's confirmation of ADR-0014 (or a concrete NerdGraph read that justifies (b)/(c)); then unblock or drop P7-15.


## P6-16 — Investigation workflow tools

### P6-16 — All three candidate tools ship; two attribute names are unverified; no `around` for logs
- **Context:** The task listed `trace_error`, `dependency_health` and `entity_health` as candidates. `generate_alert_insights_report`
  already covers an issue's entity, but nothing gave a one-call health view for an arbitrary entity.
- **Assumption made:** ship all three (module `investigations.ts`, reusing sibling handlers, planned against the budget).
  `trace_error` finds an error group's trace through `TransactionError.error.group.guid` and drops synthetic traffic with
  `nr.syntheticsMonitorId IS NULL`; both attribute names are unverified (see RESEARCH). Spans are read from the one account
  queried, so a trace that crosses accounts shows only that account's part. The `around` timestamp for logs was not added: logs
  are matched by `trace.id`, which already pins them to the request. P6-13 evals get a note to cover the tools.
- **Options:** (a) keep as is; (b) verify the two attribute names against a real account and adjust; (c) add `around` plus a
  fallback "logs near the error time" when the trace has no logs; (d) cross-account trace stitching (one query per allowed
  account); (e) fold `entity_health` into `generate_alert_insights_report` (entity_guid input) and drop it.
- **Needs:** owner's call on (b) to (e); a check against a real account.


## P6-17 — Name input on entity tools

### P6-17 — Name input only on three tools; resolution cost is charged to every call
- **Context:** Scope said "get_entity, get_related_entities, get_golden_metrics and the entity-based report tools".
- **Assumption made:** shipped the three entity tools; the report, investigation and `entity_guid` tools split into P6-18
  (composites need resolve-once and budget planning). Each tool's `cost` includes the worst case of a resolution (4 requests),
  so budget planning is conservative even for guid calls. Only `account` narrows a name (no `domain`/`type`); ambiguity is
  an `RB_INPUT_INVALID` error with the candidates in `details`, not a successful result.
- **Options:** (a) keep as is; (b) also add `domain`/`type` to the name path; (c) make ambiguity a normal result with a
  `candidates` field (needs output-schema changes); (d) charge the resolution cost only when `name` is given (needs
  per-call cost).
- **Needs:** owner's call on (b) to (d); whether P6-18 is wanted.


## P6-18 — Name input on report, investigation and signal tools

### P6-18 — Adapter instead of per-tool edits; resolution cost charged to every call
- **Context:** 16 tools take an entity guid with different shapes (required/optional, some already have `account`).
- **Assumption made:** one adapter (`withEntityName`) wraps them in `createBuiltinTools`; tools called directly from
  `createXTools` (outside the registry) do not get `name`. Cost is raised by `RESOLVE_COST` (4) for all calls, as in P6-17.
  APM tools search only `APM` entities and `get_dashboard` only dashboards (fewer false ambiguities). `generate_alert_insights_report`
  is unchanged (issue id input only).
- **Options:** (a) keep; (b) charge the cost only when `name` is given; (c) fold the P6-17 tools into the adapter too.
- **Needs:** owner's call on (b), (c).


## P6-13 — Tool description quality and agent evals

### P6-13 — LLM eval not run: no API key; baseline and release gate pending
- **Context:** The LLM tool-choice eval (`pnpm eval:tools`) needs a paid `ANTHROPIC_API_KEY`; none was available and no
  external LLM API was called. The acceptance criterion "baseline pass rate recorded" is met offline only (description lint
  + BM25 router baseline in `pnpm test`, top-1 30/44, top-3 38/44).
- **Assumption made:** default model `claude-opus-5-5`, effort `medium`, server-side refusal fallback on; the release gate is
  `--min 0.9` plus every injection case passing. `@anthropic-ai/sdk` 0.131.0 added as a root dev dependency (script only,
  never bundled). v0.6.0 is not cut by this task.
- **Options:** (a) run `ANTHROPIC_API_KEY=... pnpm eval:tools --out eval-report.json` once, record the result in
  `docs/dev/evals.md` § Baseline and pick the gate from it; (b) also run it with `--model claude-sonnet-5-5` / `claude-haiku-4-5`
  to see how the descriptions hold up on smaller models; (c) run it in CI on release tags with a budgeted key (secret +
  billing decision).
- **Needs:** owner runs (a) (about 47 requests); decision on the gate threshold and on (c).

### P6-13 — Untrusted-data sentence shortened in descriptions
- **Context:** Each description had its own one- or two-sentence untrusted-data warning (~130 chars × 33 tools).
- **Assumption made:** one fixed sentence (`UNTRUSTED`) on every open-world tool, enforced by the lint; the per-result
  envelope notice (the actual control, T6) is unchanged. Catalogue size went from 65 683 to 61 267 characters.
- **Options:** (a) keep; (b) drop the sentence from descriptions entirely and rely on the result notice plus a server
  `instructions` field.
- **Needs:** owner's call; (b) only after the LLM eval shows injection cases still pass without it.


## P6-19 — Trim tool input schema text

### P6-19 — `$schema` keyword dropped from listed tool schemas; LLM eval not re-run
- **Context:** `tools/list` went from 61 267 to 51 980 characters (descriptions plus input schemas). Besides shorter and
  shared field wording, the `$schema` keyword (55 characters per tool, also on output schemas) is no longer emitted.
  MCP says JSON Schema 2020-12 applies when none is declared. No `$ref`/`$defs` sharing was used: many clients do not
  resolve `$ref`. Validation is unchanged (the zod schemas are the same). Enum value lists were dropped from a few
  descriptions where the input schema already lists them (issue and error-group states, entity alert severity, log levels).
- **Assumption made:** no client needs an explicit `$schema`. `pnpm eval:tools` was not run (no API key), so the
  tool-choice rate after trimming is unmeasured; only the lint and the offline router baseline hold.
- **Options:** (a) keep; (b) restore `$schema` (about 2 000 characters); (c) run `pnpm eval:tools` and compare with the
  P6-13 baseline before merging the stack.
- **Needs:** owner runs (c) with the P6-13 decision; (b) only if a client rejects schemas without `$schema`.


## Phase 6 review

### REVIEW — A composite's grant no longer implies its sibling tools
- **Context:** `generate_alert_insights_report`, `generate_user_impact_report`, `entity_health` and `dependency_health`
  called sibling handlers directly, so a grant with only the composite returned log patterns, error groups, issues,
  deployments and neighbours that the grant did not list (review H1).
- **Assumption made:** fixed by requiring the sibling's grant (`grantedSibling`): a section whose tool is not granted is
  `skipped` with the reason; `dependency_health` without `get_related_entities` fails with `RB_TOOL_DISABLED`. The
  composite's own queries (issue lookup, `trace_error` spans/errors/trace logs, user-impact front-end queries) stay part
  of its grant. Stdio and pass-through list every tool, so nothing changes there.
- **Options:** (a) keep (least privilege); (b) a composite grant implies its parts, documented in the admin UI (the
  grant editor could auto-add them); (c) the admin UI warns when a composite is granted without its parts.
- **Needs:** owner's call; (c) is cheap with (a).

### REVIEW — CPU benchmark gate
- **Context:** agents reported `pnpm bench:cpu` as noisy during Phase 6. See the review's Local CI section for the
  measurements and what changed in `scripts/bench-cpu.ts`.
- **Needs:** nothing unless the owner prefers a different gate.

### P6-20 — Cost rule: count polls, retries not counted
- **Context:** declared costs undercounted real NerdGraph calls (review M2).
- **Assumption made:** one rule: every NRQL costs 2 (`maxPolls: 1` means submit + one poll, or async attempt + sync
  fallback); retries are not in the declared cost (the per-request budget still caps them); `RESOLVE_COST` stays a flat 4
  on the entity tools whether or not `name` is given (a static cost cannot see the arguments), so `affordable` is
  conservative for guid callers. `generate_user_impact_report` now runs at most 5 queries (cost 14) instead of planning
  against the whole remaining budget. `run_nrql` keeps cost 1 + default polls (the caller can raise `max_polls`).
  The "Runs ..." hint threshold in the description lint moved from 6 to 8 (name resolution made most entity tools 5 to 8).
- **Options:** (a) keep; (b) `maxPolls: 0` inside composites (cost 1 per NRQL, pending results reported more often);
  (c) charge the resolver only when `name` is given, via a per-call cost.
- **Needs:** owner's call; none blocks Phase 7.
