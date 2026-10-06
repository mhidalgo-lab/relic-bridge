---
id: P6-20
title: "Honest tool costs and budget planning (polls, retries, resolution)"
phase: 6
status: review
priority: medium
depends_on: [P6-18]
adr: [ADR-0010]
owner: claude-agent
---

# P6-20 — Honest tool costs and budget planning (polls, retries, resolution)

## Goal
Phase 6 review M2 (`docs/reviews/phase-6-review.md`): a tool's declared `cost` is used to hide tools that can't fit the
request budget (`affordable`) and by composites to plan sections, but it undercounts real NerdGraph calls. The hard cap
(one budget unit per attempt in `client.query`) still holds, so this is about predictable partial results, not a DoS.

## Scope
- Every NRQL runs with `maxPolls: 1`, which can take two calls (async submit + poll, or async-to-sync fallback), and
  retries can triple an attempt. Decide one rule (count polls, or pass `maxPolls: 0` inside composites) and apply it.
- `resolve_entity` declares 1 but can make up to 4 calls (`entity-resolver.ts`).
- `get_golden_metrics` declares 15; at the default 10 metrics it can make 1 + 2 per metric (+4 by name).
- `dependency_health` (17 + 4) can plan up to 66 calls at its maximums; `generate_user_impact_report` declares 9 but plans
  against the whole remaining budget.
- `planBudget` assumes one call per query; make grants include the poll allowance.
- Charge `RESOLVE_COST` only when `name` is given if a per-call cost is introduced (P6-17/P6-18 decision).

## Acceptance criteria
- [x] A test asserts, per tool, that the worst-case calls (mock forcing async + poll on every NRQL, name input) are at most
      the declared cost, or the tool degrades to a partial result before exceeding it.
- [x] Workers Free preset (`callBudget: 45`): every composite at its maximum arguments ends within the budget with a
      partial result, never `RB_BUDGET_EXHAUSTED` for the whole call.
- [x] `docs/reference/tools.md` regenerated.

## Outcome
Rule: every NRQL costs `NRQL_COST` = 2; retries are not counted (budget-capped). Declared costs now include it, composites
plan with `goldenCost`/`goldenMetricsFor`, parallel NRQL parts start only as many as `startableNrql` allows, `resolve_entity`
costs 4, `generate_user_impact_report` runs at most 5 queries (cost 14). Test: `packages/core/test/tool-costs.test.ts`
(forced async + poll, async unavailable, name path, wide golden/related answers, resolver worst case, Free budget 45).
The Workers Free test covers composites at their maximum arguments. Charging `RESOLVE_COST` only with `name` stays open
(pending-decisions/phase-6.md).

## Security notes
T5 / ADR-0010 (subrequest DoS). The per-request budget remains the control.

## Docs to update
- `docs/reference/tools.md` (generated), `docs/ARCHITECTURE.md` budget section if the rule changes.

## Out of scope
- Durable Object limiter (P7-10), quotas (P7-12).
