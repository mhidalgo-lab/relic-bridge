---
id: P8-30
title: Golden-metric trend compares the window with the previous window
phase: 8
status: review
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-30 — Golden-metric trend compares the window with the previous window

## Goal
P8-21 fixed partial buckets (BUG-06, BUG-26), but the golden-metric trend still compared the two halves of one window,
so the throughput trend in `entity_health` could contradict `analyze_transactions`, which compares the window with the
previous equal window (live test run, 2026-10-12). The trend must use the same basis.

## Scope
- `get_golden_metrics` (and so `entity_health`, `dependency_health`, the insights report): after the time series, one
  extra aggregate query per metric (`COMPARE WITH` the window length) gives the current and previous window; the trend
  and `changeRatio` come from them. The series still gives the latest complete-bucket value (P8-21).
- The extra query is part of the declared cost and of the budget split (`goldenCost`, `goldenMetricsFor`).
- Fallback to the halves method, with a note, when the previous window would exceed `maxWindowDays` (width or lookback,
  P8-24), when the golden query has its own window or `COMPARE`, or when the comparison query fails or has no usable data.
- Tool description stays within the tools/list budget (no budget raise; wording trimmed in the same description).
- `dependency_health` default `max_metrics` 3 to 2, so its declared cost (43) still fits the 45-call free plan.

## Acceptance criteria
- [x] Current window up versus previous, with a lower last half: trend `up` (regression test).
- [x] The comparison query is a variable-only NRQL with `COMPARE WITH`; cost and budget include it.
- [x] Previous window beyond the lookback or width limit: halves fallback and a note, no extra query.
- [x] Complete-bucket handling (P8-21) unchanged.
- [x] `pnpm docs:tools`, `pnpm tasks index`, RESEARCH.md updated; changeset added.

## Security notes
T5 (window limits): the previous window is checked against `maxWindowDays` before the extra query is sent.

## Docs to update
`docs/RESEARCH.md`, generated tool reference.

## Out of scope
- Statistical verdicts (P8-22).
