---
id: P7-21
title: "MCP Tasks for composite reports and multi-query tools"
phase: 7
status: review
priority: low
depends_on: [P7-13]
adr: []
owner: claude-agent
---

# P7-21 — MCP Tasks for composite reports and multi-query tools

## Goal
Composite reports (`generate_alert_insights_report`, `generate_user_impact_report`, `entity_health`,
`dependency_health`) and multi-query tools report slow parts as "still running" today. With the Tasks extension
(P7-13) they could return a task and finish across polls instead.

## Refined scope (2026-10-06)
Sections of a composite run to completion inside one call (no sub-query is ever "pending" at New Relic: `run_nrql`'s
async handle is not used by the report parts), so "slow" here means "does not fit one request's budget". Design:
step-wise, poll-driven execution.
- First vertical slice: `generate_alert_insights_report`. The creating `tools/call` only looks the issue up (one
  request, so a bad id or a foreign issue still fails right there) and returns a task. `resumeTask` runs at most 3
  sections per `tasks/get` (`STEP_SECTIONS`), planned against that poll's own remaining budget, then stores the
  finished sections. The last step assembles the same text and structured result as a synchronous call.
- A section that merely did not fit one poll's budget waits for the next poll; only a first section that cannot run
  even alone is skipped with the budget note, as in a synchronous call.
- Task state (sealed, strict schema, re-validated on resume): the call arguments, the issue, its window, the notes and
  the finished sections (data + text). Above 300,000 JSON characters the remaining sections are skipped
  (`Task size limit reached`) and the report completes; the 512 KiB record cap of P7-13 stays the hard limit.
- No task when the issue has no entity / start time (nothing to run) or the client did not declare the extension;
  when the store fails the new `ToolOutput.taskFallback` runs the whole report inline.
- Sections keep calling their tool through `grantedSibling`, using the poll's context (grant, accounts, quota, budget),
  so every real call counts; a tool no longer granted completes the task with `RB_AUTH_FORBIDDEN`, a section whose tool
  was revoked is `skipped`.
- Other composites (`generate_user_impact_report`, `entity_health`, `dependency_health`) and multi-query tools: P7-23.

## Scope
- A resumable job state per tool (which sub-queries are done, their `queryId`s, partial results), sealed in the P7-13
  task record; `resumeTask` polls at most a bounded number of pending sub-queries per `tasks/get` within the request
  budget.
- Same fallback as today for clients without the extension.

## Acceptance criteria
- [x] At least `generate_alert_insights_report` completes through `tasks/get` with the same output as a synchronous call.
- [x] Budget, quota and the sealed-size cap hold for partial results; negative authz tests as in P7-13.
- [ ] Works with a real Tasks-capable client (not verifiable offline).
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:workers && pnpm build && pnpm bench:cpu && pnpm docs:tools`.

## Security notes
T32, T5, T6 as in P7-13; partial results are New Relic data and stay sealed and enveloped.

## Docs to update
- Tool reference, `docs/guide/clients.md`.

## Result (2026-10-06)
- `packages/core/src/tools/reports.ts` (`prepareInsights`, `insightsPlan`, `assembleInsights`, `resumeTask`),
  `ToolOutput.taskFallback` (`tool.ts`, `server.ts`).
- Tests: `packages/core/test/tools-reports.test.ts` (same report as sync, bounded steps, fallback, grant revoked),
  authz `packages/http-app/test/authz/tasks.test.ts` (HTTP app and Worker).
- The tool description is unchanged (description budget); documented in `docs/guide/clients.md`.
- Follow-up: P7-23 (the other composites).

## Out of scope
- Notifications (P7-22).
