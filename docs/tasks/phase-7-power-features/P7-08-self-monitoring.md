---
id: P7-08
title: "Self-monitoring via OpenTelemetry (opt-in)"
phase: 7
status: todo
priority: low
depends_on: [P6-13]
adr: []
owner: ""
---

# P7-08 — Self-monitoring via OpenTelemetry (opt-in)

## Scope
- OTLP export of traces/metrics/logs (tool latency, errors, budget usage) to New Relic OTLP endpoint or any collector; no NRQL text or telemetry content exported; works on Workers (fetch exporter) and Node.

## Acceptance criteria
- [ ] Off by default; documented attributes.

## Security notes
T8: exporter redaction tests.

## Docs to update
- Observability guide.

## Out of scope
- —
