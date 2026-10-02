---
id: P6-01
title: "Tools: list_alert_policies, list_alert_conditions"
phase: 6
status: todo
priority: high
depends_on: [P5-07]
adr: []
owner: ""
---

# P6-01 — Tools: list_alert_policies, list_alert_conditions

## Scope
- `account.alerts.policiesSearch` (name filter), `nrqlConditionsSearch` per policy; compact output incl. NRQL and thresholds.

## Acceptance criteria
- [ ] Fixture + contract tests; account filtering enforced.

## Security notes
T3.

## Docs to update
- Tool reference.

## Out of scope
- Mutations.
