---
id: P7-03
title: "Deep links to the New Relic UI"
phase: 7
status: todo
priority: low
depends_on: [P6-13]
adr: []
owner: ""
---

# P7-03 — Deep links to the New Relic UI

## Scope
- Never use `embeddedChartUrl` for deep links: it creates public links (T26).
- Links for entities, NRQL queries (query builder), issues, dashboards — region-aware (US/EU UI hosts). Verify URL formats.

## Acceptance criteria
- [ ] Links open correctly for both regions.

## Security notes
none.

## Docs to update
- Tool reference.

## Out of scope
- —
