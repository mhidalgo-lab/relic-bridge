---
id: P6-01
title: "Tools: list_alert_policies, list_alert_conditions"
phase: 6
status: review
priority: high
depends_on: [P5-07]
adr: []
owner: claude-agent
---

# P6-01 — Tools: list_alert_policies, list_alert_conditions

## Scope
- `list_alert_policies`: `account(id).alerts.policiesSearch(cursor, searchCriteria { nameLike })`; one account per call (default
  account unless `account` is given: NerdGraph cursors belong to one account search). Output: id, name, incident preference.
- `list_alert_conditions`: `account(id).alerts.nrqlConditionsSearch(cursor, searchCriteria { policyId, nameLike, queryLike })`,
  selecting only fields of the `AlertsNrqlCondition` interface so STATIC, BASELINE and OUTLIER answer alike. Output: id, name,
  policy, enabled, type, NRQL query, thresholds (priority, operator, threshold, duration, occurrences), signal settings.
- Both: read-only, cost 1, group `alerting`, `next_cursor` pagination, `minimal_output`, NR-supplied text enveloped (T6),
  rows re-checked against the requested account (`accountId`, entity GUID) (T3).
- Fields verified against the P0-09 introspection; `policiesSearch` has a live sample (`spikes/nerdgraph/results/sanitized`),
  `nrqlConditionsSearch` is introspected only (not yet live-verified; RESEARCH §5, phase-6 pending log).

## Acceptance criteria
- [x] Fixture + contract tests (sample calls in `contract.test.ts`); account filtering enforced (P2-12 `TOOL_CASES`, hostile mock).
- [x] Every value is a GraphQL variable; name/NRQL/description text is inside the untrusted-data envelope.
- [x] `docs/reference/tools.md` regenerated; THREAT_MODEL row added.

## Security notes
T3 (account scope, rows re-checked), T4 (variables only), T6 (alert names, descriptions and NRQL are user text).

## Docs to update
- Tool reference (generated), THREAT_MODEL, RESEARCH.

## Out of scope
- Mutations; multi-account listing in one call; other condition kinds (APM/infra/NRQL-less legacy conditions).
