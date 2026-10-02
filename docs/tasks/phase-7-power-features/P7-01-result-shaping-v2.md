---
id: P7-01
title: "Result shaping v2: summaries, downsampling, stats"
phase: 7
status: todo
priority: medium
depends_on: [P6-13]
adr: []
owner: ""
---

# P7-01 — Result shaping v2: summaries, downsampling, stats

## Scope
- Automatic summaries for large results (top-N + "others", min/max/avg/percentiles), timeseries downsampling, anomaly hints; agent can request full pages via handle.

## Acceptance criteria
- [ ] Token usage reduced ≥ 50% on large-result eval cases without accuracy loss.

## Security notes
none.

## Docs to update
- Output formats guide.

## Out of scope
- —
