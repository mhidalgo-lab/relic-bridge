---
id: P7-23
title: "MCP Tasks for the other composite reports and multi-query tools"
phase: 7
status: review
priority: low
depends_on: [P7-21]
adr: []
owner: claude-agent
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
- [x] Each tool completes through `tasks/get` with the same output as a synchronous call (tests per tool).
- [x] Budget, quota and sealed-size cap hold; authz negatives for each (tasks invisible to other principals).

## Security notes
T32, T5, T6 as in P7-13 and P7-21.

## Docs to update
- `docs/guide/clients.md`, THREAT_MODEL T32 row.

## Outcome
- `generate_user_impact_report`: prepare = issue lookup and window; then up to 3 related-front-end lookups per poll, then up to 2
  queries per poll. The state keeps the raw per-group numbers (browser/mobile numbers per guid, synthetic per-monitor results);
  flags, totals and notes are all computed in the last step from the state.
- `entity_health`: no request at creation (validation and window only), up to 3 sections per poll; the window and lookback are fixed
  at the call as absolute ranges (a poll hours later measures the same window).
- `dependency_health`: prepare = the relationship lookup; then the golden metrics of up to 2 entities per poll.
- `runSectionStep` / `MAX_TASK_STATE_CHARS` / `SIZE_NOTE` shared with P7-21; a step runs what fits in full into the poll's own budget,
  only the first item is reduced or skipped.
- `trace_error` was not converted: three parallel queries after one lookup, a task would not help (see pending decisions).
- Authz suite (`packages/http-app/test/authz/tasks.test.ts`) covers all four report tools; this also restores the P7-21
  report-task authz tests, which the P7-22 rewrite of that file had dropped.

## Out of scope
- Notifications (P7-22).
