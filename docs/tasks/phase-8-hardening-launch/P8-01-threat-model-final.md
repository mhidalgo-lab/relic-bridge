---
id: P8-01
title: "Threat model final review and fuzzing"
phase: 8
status: in-progress
priority: high
depends_on: [P7-04, P7-09]
adr: []
owner: claude-agent
---

# P8-01 — Threat model final review and fuzzing

## Scope
- Walk every THREAT_MODEL row against code; OWASP ASVS L2 subset checklist; fuzz NRQL/entity escaping, config parsing, OAuth inputs.

## Acceptance criteria
- [ ] All rows have verified mitigations or accepted-risk notes.

## Security notes
All.

## Docs to update
- THREAT_MODEL v1.

## Out of scope
- —
