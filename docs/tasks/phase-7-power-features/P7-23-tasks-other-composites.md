---
id: P7-23
title: "MCP Tasks for the other composite reports and multi-query tools"
phase: 7
status: todo
priority: low
depends_on: [P7-21]
adr: []
owner: ""
---

# P7-23 — MCP Tasks for the other composite reports and multi-query tools

## Goal
P7-21 made `generate_alert_insights_report` resumable step by step. Do the same for `generate_user_impact_report`,
`entity_health` and `dependency_health` (and any multi-query tool that routinely exhausts one request's budget).

## Scope
- Per tool: split the handler into "prepare" (cheap lookups, validation, plan) and bounded steps, with a strict sealed
  state schema (what is done, partial data) and the same size cap behaviour as P7-21.
- `generate_user_impact_report` computes signals from the current and previous window together: keep the raw per-group
  numbers in the state, compute flags in the last step.
- Reuse `grantedSibling`, `ToolOutput.taskFallback` and the polling rules of P7-13.

## Acceptance criteria
- [ ] Each tool completes through `tasks/get` with the same output as a synchronous call (tests per tool).
- [ ] Budget, quota and sealed-size cap hold; authz negatives for each (tasks invisible to other principals).

## Security notes
T32, T5, T6 as in P7-13 and P7-21.

## Docs to update
- `docs/guide/clients.md`, THREAT_MODEL T32 row.

## Out of scope
- Notifications (P7-22).
