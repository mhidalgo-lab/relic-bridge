---
id: P6-02
title: "Tools: list_recent_issues, search_incidents"
phase: 6
status: todo
priority: high
depends_on: [P5-07]
adr: []
owner: ""
---

# P6-02 — Tools: list_recent_issues, search_incidents

## Scope
- `aiIssues` issues/incidents (state, priority, entity, time filters); fall back to `NrAiIssue`/`NrAiIncident` NRQL where API lacks a field.

## Acceptance criteria
- [ ] Fixture + contract tests.

## Security notes
T6 (issue titles/descriptions enveloped).

## Docs to update
- Tool reference.

## Out of scope
- Acknowledge/close (P7-09).
