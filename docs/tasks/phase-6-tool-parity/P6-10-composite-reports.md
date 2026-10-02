---
id: P6-10
title: "Composite reports: alert insights and user impact"
phase: 6
status: todo
priority: medium
depends_on: [P6-02, P6-04, P6-06]
adr: [0010]
owner: ""
---

# P6-10 — Composite reports: alert insights and user impact

## Scope
- `generate_alert_insights_report { issue_id }`: issue details → entity → golden metrics around the window → related entities → error groups → logs summary → change events; structured sections the agent can reason over.
- `generate_user_impact_report`: browser/mobile/synthetics signals for affected entities.
- Strict budget planning; partial-report semantics; consider the MCP **Tasks** extension for long runs where supported.

## Acceptance criteria
- [ ] Works within Free-plan budget with reduced depth (documented).

## Security notes
T6 (aggregates lots of untrusted text).

## Docs to update
- Tool reference.

## Out of scope
- LLM summarisation server-side (the client agent reasons).
