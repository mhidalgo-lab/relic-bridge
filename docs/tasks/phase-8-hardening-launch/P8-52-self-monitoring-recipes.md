---
id: P8-52
title: Self-monitoring recipes - alert conditions and a dashboard
phase: 8
status: review
priority: low
depends_on: [P8-50, P8-51, P8-59]
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
- [x] Every query in the guide runs against a live export (2026-10-14, relic-bridge 0.9.1, through `run_nrql` with a
      `SINCE` added). The server-error queries return 0 until P8-59 is deployed (no `fault` before it); refused
      requests and timeouts had no rows on 0.9.1.
- [x] Dashboard JSON is a valid NerdGraph `DashboardInput` (test against the committed schema snapshot), only
      `accountIds` to edit, every widget query run live.
- [ ] Dashboard JSON imports without edits besides the account id. Not ticked: importing creates a dashboard in an
      account, which this task does not do; the owner imports it once.
- [x] The guide says which conditions and widgets need P8-59.

## Security notes
None (documentation).

## Docs to update
- `docs/guide/observability.md`, new `docs/guide/observability-dashboard.json`, `docs/RESEARCH.md` (facet note).

## Out of scope
- Creating the alerts in anyone's account.
