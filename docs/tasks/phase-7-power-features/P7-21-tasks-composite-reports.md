---
id: P7-21
title: "MCP Tasks for composite reports and multi-query tools"
phase: 7
status: todo
priority: low
depends_on: [P7-13]
adr: []
owner: ""
---

# P7-21 — MCP Tasks for composite reports and multi-query tools

## Goal
Composite reports (`generate_alert_insights_report`, `generate_user_impact_report`, `entity_health`,
`dependency_health`) and multi-query tools report slow parts as "still running" today. With the Tasks extension
(P7-13) they could return a task and finish across polls instead.

## Scope
- A resumable job state per tool (which sub-queries are done, their `queryId`s, partial results), sealed in the P7-13
  task record; `resumeTask` polls at most a bounded number of pending sub-queries per `tasks/get` within the request
  budget.
- Same fallback as today for clients without the extension.

## Acceptance criteria
- [ ] At least `generate_alert_insights_report` completes through `tasks/get` with the same output as a synchronous call.
- [ ] Budget, quota and the sealed-size cap hold for partial results; negative authz tests as in P7-13.

## Security notes
T32, T5, T6 as in P7-13; partial results are New Relic data and stay sealed and enveloped.

## Docs to update
- Tool reference, `docs/guide/clients.md`.

## Out of scope
- Notifications (P7-22).
