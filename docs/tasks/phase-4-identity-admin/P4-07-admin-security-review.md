---
id: P4-07
title: "Admin panel security review"
phase: 4
status: todo
priority: high
depends_on: [P4-04]
adr: []
owner: ""
---

# P4-07 — Admin panel security review

## Scope
- XSS (stored: entity names, labels), CSRF, clickjacking, session fixation, authz on every route, open redirects (`next=` params), error pages leaking info.
- ZAP baseline scan in CI against a local instance.

## Acceptance criteria
- [ ] Findings fixed or tracked as tasks; THREAT_MODEL updated.

## Security notes
T13, T14.

## Docs to update
- THREAT_MODEL.

## Out of scope
- External review (P8-02).
