---
id: P2-12
title: Authorization and isolation test suite
phase: 2
status: todo
priority: high
depends_on: [P2-06, P2-09]
adr: [0008]
owner: ""
---

# P2-12 — Authorization and isolation test suite

## Scope
- Dedicated suite, run for Node now and Workers in P3-06: cross-project token use, ungranted tool, ungranted account (in tool args), revoked/expired token, revoked grant, credential deleted, pass-through disabled, admin API without auth.
- **Concurrent two-tenant test** (T21): many interleaved requests for two projects with different credentials; assert each
  NerdGraph call carried the right key and no response leaked across tenants.
- Entity / relationship results never include entities from non-allowed accounts (a User key can span many accounts).
- Every future endpoint/tool must add cases here (documented in CONTRIBUTING).

## Acceptance criteria
- [ ] Suite runs in CI and is required.

## Security notes
T2, T3, T15, T19.

## Docs to update
- CONTRIBUTING.

## Out of scope
- —
