---
id: P7-05
title: "relic-bridge doctor"
phase: 7
status: todo
priority: medium
depends_on: [P6-13]
adr: []
owner: ""
---

# P7-05 — relic-bridge doctor

## Scope
- Checks: Node version, config validity, key type/validity, region mismatch, account access, reachability of NerdGraph, remote instance health, token validity, client config files (Claude Code/Desktop) pointing to the right URL.

## Acceptance criteria
- [ ] Each failure has an actionable fix message.

## Security notes
Never prints secrets.

## Docs to update
- Troubleshooting.

## Out of scope
- —
