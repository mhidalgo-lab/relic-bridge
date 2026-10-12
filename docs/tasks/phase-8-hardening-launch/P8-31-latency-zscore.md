---
id: P8-31
title: Add z-scores to latency verdicts
phase: 8
status: in-progress
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-31 — Add z-scores to latency verdicts

## Goal
Finish BUG-07 of the live test run (2026-10-12): P8-22 added |z| >= 3 rules for error rate and throughput, but latency
verdicts still use only a 15% band and a 5 ms floor, because the window query had no standard deviation.

## Scope
- Add `stddev(duration)` to the window queries of `analyze_deployment_impact` and `analyze_transactions`.
- Compute a z for average latency (Welch) and p95 latency (normal-approximation standard error of the quantile).
- Latency is `worse`/`better` only when beyond the 15% band, at least 5 ms and |z| >= 3; the `note` names the rule and z.
  Without spread data the old band rule decides and the note says so.
- Keep the P8-22 baseline/warning logic (the control windows get the same z rule).
- No change to tool descriptions or inputs (they already say "Changes need |z| >= 3"): tools/list budgets untouched.

## Acceptance criteria
- [x] Both tools request `stddev(duration)` per window; the control windows too.
- [x] A noisy latency rise below |z| 3 is `similar` with a note naming z; a tight one is `worse`.
- [x] Control scenario (overnight drop, no deployment) still gives no `regression_suspected`.
- [x] Tests: z helper, rule boundaries, fallback without spread, query contains `stddev`.
- [x] No tools/list budget change.

## Security notes
None: no access behaviour changes; the added aggregate goes through the `nrql` template.

## Docs to update
- RESEARCH.md (latency z), changeset.

## Out of scope
- Exact (non-parametric) confidence intervals for p95.
