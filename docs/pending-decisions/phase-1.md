# Phase 1 — pending decisions

Decisions that agents could not make alone during the autonomous run (2026-10-03). Each entry says what was
assumed so work could continue. Review, then answer in place or move the outcome into an ADR / task file.

Format: `### <task id> — <short title>` then **Context**, **Assumption made**, **Options**, **Needs**.

## Workflow

### ALL — stacked PRs instead of merging to `main`
- **Context:** The owner was away. Every task PR targets the previous task's branch (the first one targets
  `phase/1-core-stdio`), so nothing is merged into `main`.
- **Assumption made:** A dependency counts as satisfied when its task is `review` and its branch is lower in the
  stack. Tasks stay `review`, not `done`, until their PRs are merged.
- **Options:** merge the stack bottom-up (retarget each PR to `main` after its parent merges), or squash-merge the
  tip into `main` in one go.
- **Needs:** owner's merge strategy; then mark merged tasks `done` and run `pnpm tasks index`.

## P1-05 — Output shaping

### P1-05 — Envelope everything vs only free-text fields
- **Context:** The task says to envelope telemetry fields such as log and error messages. Any NRQL attribute can carry
  attacker-written text, and we can't reliably tell which columns are free text.
- **Assumption made:** Every rendered data block (all rows, plus NRQL totals) goes inside one envelope per result.
  Cost: about 60 tokens per result. `untrusted: false` exists only for values relic-bridge generates itself.
- **Options:** keep (safest); envelope only known free-text attributes (cheaper, easy to miss one); make it a
  connection setting.
- **Needs:** owner's confirmation.

### P1-05 — Redacting secret-shaped values in telemetry rows
- **Context:** Log lines sometimes contain keys or `password=…`. The central `redact()` (T8) can scrub them before they
  reach the agent transcript, but it also changes data the user might want to see verbatim.
- **Assumption made:** Redaction on by default for rows and structured content (`redactSecrets: true`); tools can turn
  it off per call site, but no tool input exposes that switch.
- **Options:** keep on by default; make it a connection setting (P2); off by default.
- **Needs:** owner's preference.

### P1-05 — Default caps
- **Context:** No measured token budget yet (P7-01 evaluates large results).
- **Assumption made:** 100 rows, 300 characters per value, 24 000 characters per data block, 50 columns; `auto`
  renders a table up to 8 columns, CSV above. Hard maximums 1000 / 4000 / 100 000 / 200.
- **Options:** tune after P1-12 evals or real usage.
- **Needs:** nothing now; revisit with data.

## P1-06 — Query tools

### P1-06 — `run_nrql` still listed when raw NRQL is off
- **Context:** The task says the tool is disabled when `rawNrql=false`. ARCHITECTURE prefers tools a caller may not
  use to be absent from `tools/list`. Phase 1 has no grant resolution yet that feeds limits into `ToolRegistry.select`.
- **Assumption made:** `run_nrql` and `get_query_result` stay listed and fail with `RB_TOOL_DISABLED` plus a hint to
  use purpose-built tools. No request reaches New Relic.
- **Options:** keep; filter in the stdio CLI (P1-11) when its config sets `rawNrql: false`; filter centrally in the
  Phase 2 grant resolution (P2-xx).
- **Needs:** owner's preference on where the filter lives; nothing blocks Phase 1.

### P1-06 — Polling behaviour of `run_nrql`
- **Context:** The engine supports `sync`, `async` and `auto` modes. Agents only see `timeout_s`.
- **Assumption made:** `run_nrql` always uses `auto`: wait up to `timeout_s` (default 10 s), then poll up to 3 times
  within budget (waits capped at 10 s each) before handing back a `query_id`. Worst case is roughly `timeout_s` + 30 s
  per call.
- **Options:** keep; expose a `wait` / `mode` input; return the handle right after `timeout_s` (no polling).
- **Needs:** nothing now; revisit after P1-12 evals or real usage.

## P1-07 — Identity, accounts and time tools

### P1-07 — `RegionScope` value and `ToolContext.connection`
- **Context:** `Actor.accounts` takes `scope: RegionScope`; P0-09 confirmed the argument but not a live call with it.
  `whoami` also needs the project slug and granted tools, which Phase 1 context doesn't carry.
- **Assumption made:** pass `IN_REGION` (the key's own data center) as a variable `$scope: RegionScope!`; add an
  optional `ToolContext.connection { project?, allowedTools? }` that P1-11 / Phase 2 fill in (absent shows "unknown").
  The enum value is from the NerdGraph schema as remembered, not yet verified against a live account.
- **Options:** `GLOBAL` (accounts in every region); verify live with the P0-09 spike profile.
- **Needs:** one live check of `IN_REGION` when a key is at hand; swap the `ACCOUNT_SCOPE` constant if rejected.

### P1-07 — `time_range` semantics
- **Context:** the task didn't fix the grammar, time zone or clause format.
- **Assumption made:** UTC only; weeks start Monday; "last week/month" are rolling 7/30 days while "this/previous
  week/month" are calendar periods; date-only range ends include the whole day. Relative input yields NRQL
  `SINCE n units ago`; absolute input yields `SINCE <epoch seconds> UNTIL <epoch seconds>` (epoch seconds are
  documented NRQL; the clause is accepted by our own limits parser but not yet run live).
- **Options:** add a `timezone` input; use ISO string literals in the clause; calendar meaning for "last week".
- **Needs:** nothing now; revisit after P1-12 evals.

### P1-07 — `whoami` email default
- **Assumption made:** email shown unmasked unless `mask_email: true` (it is the connection owner's own address and the
  tool exists for debugging). Names and email are enveloped as untrusted data.
- **Options:** mask by default; drop the email.
- **Needs:** owner's preference.


## P1-08 — Entity tools

### P1-08 — Unverified entity-search details
- **Context:** P0-09 measured quoting (`\'`) and `accountId = '…'`, but not `accountId IN (…)`, `options.limit`
  semantics, `relatedEntities(filter:)` or `entitySearch.types` against a live account (the probed account had no APM
  entities).
- **Assumption made:** every search carries `accountId IN ('<id>', …)` (quoted, like the probe), passes
  `options: { limit }` and `results(cursor:)`; related entities use `EntityRelationshipEdgeFilter { direction,
  entityDomainTypes { include } }` from the introspected schema; the type catalogue reads `entitySearch.types`.
  Results are filtered by `accountId` client-side regardless, so a wrong guess can only hide entities, never leak them.
- **Options:** verify with the P0-09 spike profile; switch to unquoted ids or one search per account if `IN` is rejected.
- **Needs:** one live run against an account with APM entities.

### P1-08 — Tag keys and name matching
- **Assumption made:** tag-key filters accept only `[A-Za-z0-9_.]` (bare `tags.<key>`), because backtick quoting inside
  entity search is undocumented; keys like `team-name` are refused with a hint. `name` is a substring match
  (`LIKE '%…%'`) and a `%` typed by the agent stays a wildcard (no documented escape; it can't end the literal).
- **Options:** probe backtick quoting live and widen the charset; offer an exact-name option.
- **Needs:** nothing now.

### P1-08 — `list_entity_types` cache scope
- **Context:** the task asks for a per-isolate cache; AGENTS.md forbids module-level request state (T21).
- **Assumption made:** a bounded map (64 entries, 10-minute TTL) held by each `createEntityTools()` instance (not module
  state), keyed by credential id + region + sorted account set, so one credential or grant never sees another's
  catalogue. It stores only domain/type names and counts.
- **Options:** keep; move to the Phase 7 cache layer; drop caching (one subrequest per call).
- **Needs:** owner's confirmation when the Worker shares tool instances across tenants (Phase 3).

### P1-09 — Golden metrics run when raw NRQL is off
- **Context:** golden-metric NRQL is supplied by New Relic, but `run_nrql`'s `rawNrql` switch exists to stop agent-written NRQL.
- **Assumption made:** `get_golden_metrics` is not gated by `rawNrql` (new `runTrustedNrql` engine entry point); query limits still apply.
- **Options:** keep; gate the tool on `rawNrql` as well; add its own grant in Phase 2.
- **Needs:** owner's call once per-tool grants exist (Phase 2).

### P1-09 — Trend definition and defaults
- **Assumption made:** window default "last 30 minutes" with `TIMESERIES AUTO`; trend compares the mean of the later half of the series with the earlier half (flat within +/-5%, at least 4 points); faceted metrics get a value-less row pointing to `run_nrql`. Metrics with their own SINCE/TIMESERIES keep them. At most 10 metrics by default (max 20); the `title`/`query` fields are the only ones selected (`unit` unverified live).
- **Options:** other thresholds or a `COMPARE WITH` baseline; select `unit` once checked against the live schema.
- **Needs:** one live run against an APM entity.

### P1-10 — Schema tools not gated by `rawNrql`; defaults; no counts
- **Context:** `list_event_types` / `get_attributes` run server-built NRQL (the `nrql` tag), not agent-written NRQL.
- **Assumption made:** not gated by `rawNrql` (query limits and event-type allow/deny still apply). Default window "last 24 hours", 5-minute per-instance cache. With an event-type allow list `list_event_types` returns the list without querying; deny lists are filtered from the output. The optional per-type counts in the original scope were dropped (one query per type; use `run_nrql`). Exact NRQL result shapes of `keyset()` (`key`/`type` rows; older key-list form also parsed) are unverified live.
- **Options:** gate on `rawNrql`; longer default window; add counts as a separate task.
- **Needs:** one live run against an account with APM data.

