---
id: P8-21
title: Golden metrics read complete buckets, honour timeseries false, state limit notes once
phase: 8
status: done
priority: high
depends_on: []
adr: []
owner: claude-agent
---

# P8-21 — Golden metrics read complete buckets, honour timeseries false, state limit notes once

## Goal
Fix three findings of the live test run (2026-10-12) in `get_golden_metrics` and the composites that use it
(`entity_health`, `dependency_health`): the latest value and trend read a bucket that is still filling and contradict
other tools (BUG-06, BUG-26), `timeseries: false` is not honoured (BUG-26), and the same limit note is repeated on every
metric (BUG-20).

## Scope
- Leave out time buckets that end after "now" when computing `value` and the trend; compare two halves of equal length.
- With `timeseries: false` send no `TIMESERIES` (also removing one the golden query carries): one aggregate per metric.
- Signals read "down 39%", "up 79%" (no sign next to the direction word).
- Report query adjustments (for example `LIMIT MAX replaced`) once, in a top-level `notes` field and line, not per metric.
- Tool description and generated docs state the trend definition.

## Acceptance criteria
- [x] The bucket still filling never supplies `value` and never enters the trend.
- [x] The trend compares equal-length halves of the complete buckets; the description says so.
- [x] `timeseries: false` sends NRQL without `TIMESERIES`.
- [x] No double signs in health signals.
- [x] Limit adjustments appear once at the top level, not on each metric row.
- [x] Tests: regression tests for each of the above (fail before the fix).

## Security notes
None: no access behaviour changes; the NRQL text still goes only through the existing limit/tokenizer path.

## Docs to update
- Tool reference (generated), changeset.

## Out of scope
- Comparing against a separately queried previous window (COMPARE WITH); the trend stays within the one window.
