---
id: P8-46
title: An explicit baseline that cannot run falls back to an available control
phase: 8
status: done
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-46 — An explicit baseline that cannot run falls back to an available control

## Goal
NEW-11 of the 0.9.0 verification: `analyze_transactions(baseline: "same_window_7d_ago")` with the 7-day control outside
the lookback limit reports `baseline.used: "previous_window", reason: "Requested in the baseline input."` (wrong) and
runs no control, so a normal morning ramp ends `regression_suspected`.

## Scope
- When the requested seasonal baseline is outside the `maxWindowDays` limit, use the best control that fits (1-day),
  with `automatic: false` and a `reason` naming the requested baseline, why it could not run and what was used.
- Keep the note. Same behaviour in `analyze_deployment_impact`.
- The limit is never relaxed for baseline queries (P8-24).

## Acceptance criteria
- [x] Requested 7d outside the limit → 1d control runs; `baseline.used` and `reason` are accurate.
- [x] Requested baseline inside the limit → unchanged.
- [x] Regression tests for both tools.

## Security notes
T5: lookback limit still bounds every query.

## Docs to update
- `docs/RESEARCH.md` if the rule text lives there, `docs/reference/tools.md` (generated), changeset.

## Out of scope
- Changing the automatic baseline choice (P8-42).
