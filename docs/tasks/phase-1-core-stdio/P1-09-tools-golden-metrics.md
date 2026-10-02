---
id: P1-09
title: "Tool: get_golden_metrics"
phase: 1
status: todo
priority: high
depends_on: [P1-06, P1-08]
adr: []
owner: ""
---

# P1-09 — Tool: get_golden_metrics

## Scope
- `get_golden_metrics { guid, since?, timeseries? }`: fetch `entity.goldenMetrics { metrics { title query } }`, run each query (parallel within limiter, budget-aware), return a compact health summary (current value + trend direction) and the NRQL used.
- Graceful partial results if budget/limiter stops some metrics.

## Acceptance criteria
- [ ] Fixture tests incl. partial result under small budget.

## Security notes
Golden-metric NRQL comes from New Relic, not the client — still pass through limits (time window).

## Docs to update
- Tool reference.

## Out of scope
- —
