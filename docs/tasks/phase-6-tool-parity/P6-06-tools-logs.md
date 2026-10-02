---
id: P6-06
title: "Tools: list_recent_logs, analyze_entity_logs"
phase: 6
status: todo
priority: high
depends_on: [P5-07]
adr: []
owner: ""
---

# P6-06 — Tools: list_recent_logs, analyze_entity_logs

## Scope
- Recent logs (level filter, search term escaped, row cap); analysis = counts by level, top message patterns (normalise numbers/ids), spikes.

## Acceptance criteria
- [ ] Log content always enveloped; tests.

## Security notes
**T6 primary risk surface** — log lines are attacker-controlled.

## Docs to update
- Tool reference; security guide note.

## Out of scope
- —
