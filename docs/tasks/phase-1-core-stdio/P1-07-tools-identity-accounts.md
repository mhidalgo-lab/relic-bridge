---
id: P1-07
title: "Tools: whoami, list_accounts, time_range"
phase: 1
status: todo
priority: high
depends_on: [P1-02]
adr: []
owner: ""
---

# P1-07 — Tools: whoami, list_accounts, time_range

## Scope
- `whoami`: NR user email (masked option), region, project slug, default account, allowed tools — helps agents and users debug setup. Never returns key material.
- Key validation passes `actor.accounts(scope:)` explicitly (the argument exists; default scope unverified, P0-09).
- `list_accounts`: accounts reachable **and allowed** (intersection), marking the default.
- `time_range { expression }`: converts "last 2 hours", ISO ranges, etc. into epoch ms + NRQL `SINCE/UNTIL` clause (pure function, no subrequest).

## Acceptance criteria
- [ ] Tests incl. account intersection (credential reaches 3, project allows 2 → 2 listed).

## Security notes
T3 (account filtering), T8.

## Docs to update
- Tool reference.

## Out of scope
- —
