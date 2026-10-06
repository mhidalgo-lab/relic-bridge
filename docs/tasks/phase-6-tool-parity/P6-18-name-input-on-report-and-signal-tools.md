---
id: P6-18
title: "Accept an entity name in the report, investigation and signal tools"
phase: 6
status: review
priority: low
depends_on: [P6-17]
adr: []
owner: claude-agent
---

# P6-18 — Accept an entity name in the report, investigation and signal tools

## Goal
Extend the `guid` XOR `name` input (P6-17, `entity-ref.ts`) to the remaining entity-taking tools.

## Scope
- One shared adapter, `withEntityName` (`packages/core/src/tools/entity-ref.ts`), applied in `createBuiltinTools` from a table
  (`NAME_INPUT`, `tools/index.ts`). It adds `name` (and `account` where the tool has none, only with `name`), makes a required
  guid input optional, enforces `guid` XOR `name`, resolves the name once up front with the shared resolver and runs the
  original handler with the guid, so every tool behaves like `get_entity` (P6-17): ambiguity or no match is
  `RB_INPUT_INVALID` (candidates in `details`), the handler's own `checkGuid` and account checks still run, and the text starts
  with the "Resolved name ..." line.
- Tools: `dependency_health`, `entity_health`, `get_dashboard` (`guid`), `trace_error`, `list_recent_issues`,
  `search_incidents`, `list_error_groups`, `list_change_events`, `analyze_deployment_impact`, `list_top_transactions`,
  `analyze_transactions`, `list_recent_logs`, `analyze_entity_logs`, `analyze_threads`, `list_gc_metrics`,
  `generate_user_impact_report` (`entity_guid`). Optional-guid tools keep working without either. APM tools search only
  `APM` entities, `get_dashboard` only `VIZ`/`DASHBOARD`.
- `generate_user_impact_report` refuses `name` together with `issue_id`, `trace_error` refuses `name` without
  `error_group_id`, both before any request.
- Composites (`entity_health`, `trace_error`, `generate_*_report`) call their section tools directly with the resolved guid, so
  a name is resolved once. Their `cost` includes `RESOLVE_COST`; the requests the resolution spends come off
  `ctx.budget`, so `planBudget` plans the sections from what is left.
- `generate_alert_insights_report` (issue id only), `list_synthetic_monitors`, `analyze_kafka_metrics` take no entity: unchanged.

## Acceptance criteria
- [x] Each listed tool accepts `guid`/`entity_guid` or a name (exactly one where the guid is required), ambiguity returns
  candidates.
- [x] Budget planning for composites accounts for the resolution requests.
- [x] Contract, authz and tool tests cover name variants.

## Security notes
T3, T16, T21 as P6-17.

## Docs to update
- Tool reference (generated).
- `docs/THREAT_MODEL.md` (resolver row).

## Out of scope
- Cross-account search beyond the grant's accounts.
