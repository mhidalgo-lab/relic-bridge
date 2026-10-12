---
id: P8-22
title: Verdicts honour z-scores; seasonal baseline for window comparisons
phase: 8
status: in-progress
priority: high
depends_on: []
adr: []
owner: claude-agent
---

# P8-22 — Verdicts honour z-scores; seasonal baseline for window comparisons

## Goal
Fix BUG-07 of the live test run (2026-10-12): `analyze_transactions` and `analyze_deployment_impact` call strong error
rate changes "similar" (a percentage-point floor hides |z| of 3 to 16), and flag `regression_suspected` for a
deployment that never happened because the before/after windows cross the overnight traffic drop (control run).

## Scope
- Error rate: a change counts when |z| >= 3 **and** the extra (or missing) error count against the before rate is at
  least 5 (replaces the 0.5 percentage-point floor). Throughput: changed when beyond the 25% band **and** |z| >= 3.
  Latency: the 15% band plus a 5 ms minimum absolute delta. Each `note` names the rule that decided.
- New optional input `baseline: previous_window | same_window_1d_ago | same_window_7d_ago` on
  `analyze_deployment_impact` and `analyze_transactions` (the only verdict tools comparing windows).
  `previous_window` = plain comparison. A same-window baseline additionally runs the same pair of windows 1 or 7 days
  earlier as a control (2 extra queries). Default: automatic. It is `same_window_1d_ago` when the first comparison shows a
  large throughput shift (changed: beyond the 25% band, |z| >= 3), else `previous_window`.
- A metric change that the control shows too (same direction, at least half the size) becomes verdict `warning`, not
  `worse`/`better`/`changed`, so a traffic-trough artefact is no regression.
- The structured output states the baseline used and why; tool descriptions state the extra queries.
- Control test: a synthetic overnight drop with no deployment must not give `regression_suspected`.

## Acceptance criteria
- [ ] |z| >= 3 with enough extra errors is `worse`/`better`; the note says which rule decided.
- [ ] `baseline` input on both tools; auto rule documented; extra queries documented in the descriptions.
- [ ] A throughput change (and any other metric change) mirrored in the baseline is `warning`.
- [ ] Control test passes (no regression_suspected for an overnight drop without deployment).
- [ ] Tests: regression tests for the BUG-07 cases (fail before the fix).

## Security notes
None: no access behaviour changes. Baseline windows are queried through the same `nrql` template and window limit
(`maxWindowDays` lookback) as the primary windows; a control window beyond the limit is skipped with a note.

## Docs to update
- Tool reference (generated), changeset, RESEARCH.md (seasonality note).

## Out of scope
- Latency z-scores (needs standard deviation in the window query).
