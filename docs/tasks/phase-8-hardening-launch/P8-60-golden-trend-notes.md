---
id: P8-60
title: Golden-metric trend notes say why there is no trend
phase: 8
status: done
priority: low
depends_on: []
adr: []
owner: claude-agent
---

# P8-60 — Golden-metric trend notes say why there is no trend

## Goal
Live (0.9.1, 2026-10-14), `entity_health` on a low-traffic service over 6 hours returned trend `unknown` for two metrics
(2 points) with the note "Trend compares the halves of the window: the previous window could not be read." That note is
wrong twice: the previous window was read (it had no data), and the halves did not give a trend either. A third metric
had trend `up` with `changeRatio` null. Notes must say why there is no trend, and the null ratio must be documented.

## Scope
- `get_golden_metrics` (and so `entity_health`): distinguish comparison query failed or not usable ("could not be
  read"), previous window without data ("no data in the previous window"), and halves also inconclusive ("too few points
  to compare the halves"); never claim the halves were compared when the trend is `unknown`.
- `changeRatio` is null when the baseline is 0 (ratio undefined; trend `up`, or `flat` when both are 0): deliberate,
  now documented in the output schema description.
- Unit tests for each case; patch changeset.

## Acceptance criteria
- [x] Comparison failed: note says the previous window could not be read (halves trend kept when usable).
- [x] Previous window empty: note says no data in the previous window.
- [x] Halves also inconclusive: note is "No trend: ...", never "compares the halves".
- [x] Zero previous window: `up`, `changeRatio` null, documented.
- [x] Tests for each case; changeset added; `pnpm tasks index` run.

## Security notes
none (notes text only; no new query or input).

## Docs to update
Generated tool reference if the schema description is rendered there.

## Out of scope
- The result-level note when the previous window exceeds the window limit (unchanged).
