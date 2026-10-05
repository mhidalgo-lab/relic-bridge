---
id: P6-04
title: "Tools: list_change_events, analyze_deployment_impact"
phase: 6
status: review
priority: high
depends_on: [P5-07]
adr: []
owner: claude-agent
---

# P6-04 — Tools: list_change_events, analyze_deployment_impact

## Scope
- `list_change_events`: without `entity_guid`, `actor.changeTracking.changeTrackingSearch(filter: { accountIds, limit,
  timeWindow })` (every kind of change event of one account: deployments, feature flags, configuration changes…); with
  `entity_guid`, `entity(guid).deploymentSearch(filter: { limit, timeWindow })` (deployments of that entity only). `time_range`
  (default last 7 days, capped by the window limit), `limit` (default 25, max 100; the API has no cursor, so a full page sets
  `maybeMore`), `account`, `minimal_output`. Newest first. Per event: time, type, user (emails masked), entity, descriptions,
  and for deployments version, commit, changelog, link.
- `analyze_deployment_impact` (APM applications only): resolve the entity and its deployments in one request, pick the latest
  deployment in `lookback` (default 7 days) or use `deployment_time` (ISO 8601), then run two NRQL queries (before and after,
  equal windows of `compare_minutes`, default 30, shrunk to the time since the deployment, at least 5 minutes) over
  `Transaction` by `entityGuid`: count, error percentage, average and p95 duration. Output: per metric before/after/delta/ratio
  and a verdict (worse, better, similar, changed, inconclusive, not_run) and an overall call. Thresholds are documented
  constants: 30 transactions per window, latency band 15%, throughput band 25%, error-rate two-proportion z of 3 and 0.5 pp.
- Budget: cost 3 (one lookup, two queries; under the 45-call Workers free budget). If the budget covers one window only, that
  window is returned and the result is `partial`; a failed window is reported the same way (partial results tested).
- Read-only, group `incident-response`. Every returned row must belong to the requested, allowed account (T3). Recorded text
  (descriptions, users, changelogs) is cleaned and enveloped (T6); NRQL is built only with the `nrql` tag (T4).

## Acceptance criteria
- [x] Fixture + contract tests (`tools-changes.test.ts`, sample calls in `contract.test.ts`); account filtering enforced
  (P2-12 `TOOL_CASES`, hostile mock).
- [x] Budget-aware; partial results tested (one window skipped for budget, one window failing).
- [x] Every value is a GraphQL variable or an NRQL template value; recorded text is inside the untrusted-data envelope.
- [x] `docs/reference/tools.md` regenerated; THREAT_MODEL and RESEARCH updated; owner decisions logged.

## Security notes
T3 (events re-checked against their entity GUID, deployments against the requested entity; foreign data dropped and flagged),
T4 (variables and `nrql` tag only), T6 (change descriptions and changelogs are free text written by pipelines: enveloped).

## Docs to update
- Tool reference (generated), THREAT_MODEL, RESEARCH.

## Out of scope
- Creating change events (P7-09).
- Non-APM entities, browser/mobile impact, custom metrics, per-transaction breakdown (P6-05).
- Paging change events (the API has no cursor).
