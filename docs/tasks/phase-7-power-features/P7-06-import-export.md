---
id: P7-06
title: "Config import/export"
phase: 7
status: todo
priority: low
depends_on: [P6-13]
adr: []
owner: ""
---

# P7-06 — Config import/export

## Scope
- Export projects/grants (YAML); credentials excluded or encrypted with a passphrase (age/scrypt); import with dry-run diff. Enables moving between local, Docker and Worker.

## Acceptance criteria
- [ ] Round trip Node → Worker tested.

## Security notes
T7: passphrase KDF is fine here (offline, not hot path).

## Docs to update
- Migration guide.

## Out of scope
- —
