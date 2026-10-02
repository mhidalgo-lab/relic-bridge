---
id: P7-11
title: "OS keychain for local credentials"
phase: 7
status: todo
priority: low
depends_on: [P6-13]
adr: []
owner: ""
---

# P7-11 — OS keychain for local credentials

## Scope
- `keychain:` references in YAML (macOS Keychain, Windows Credential Manager, libsecret) via a maintained library; `relic-bridge credential add --keychain`.

## Acceptance criteria
- [ ] Works on macOS, Windows, Linux CI (where possible).

## Security notes
T7 for local mode.

## Docs to update
- Local config guide.

## Out of scope
- —
