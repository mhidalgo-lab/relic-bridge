---
id: P8-52
title: Self-monitoring recipes - alert conditions and a dashboard
phase: 8
status: in-progress
priority: low
depends_on: [P8-50, P8-51]
adr: []
owner: claude-agent
---

# P8-52 — Self-monitoring recipes: alert conditions and a dashboard

## Goal
The relic-bridge entity has no alert conditions (`NOT_CONFIGURED`) and no dashboard. Operators should get a
copy-paste starting point.

## Scope
- Observability guide section with NRQL alert conditions: tool error rate, p95 tool duration, rejected requests by
  reason, real request timeouts, exporter gaps (no data).
- A dashboard JSON (importable in New Relic) for calls, errors by code and tool, latency, NerdGraph calls and bytes per
  call, rejected requests.

## Acceptance criteria
- [ ] Every query in the guide runs against a live export.
- [ ] Dashboard JSON imports without edits besides the account id.

## Security notes
None (documentation).

## Docs to update
- `docs/guide/observability.md`, new `docs/guide/observability-dashboard.json` (or similar).

## Out of scope
- Creating the alerts in anyone's account.
