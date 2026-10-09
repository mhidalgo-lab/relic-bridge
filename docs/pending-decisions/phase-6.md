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
