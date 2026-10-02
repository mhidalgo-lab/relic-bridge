---
id: P2-04
title: Access model and effective-permission resolver
phase: 2
status: todo
priority: high
depends_on: [P2-01, P2-03]
adr: [0008]
owner: ""
---

# P2-04 — Access model and effective-permission resolver

## Scope
- Domain services: create/validate credential (calls `actor.user`/`actor.accounts`, stores reachable accounts), create project, create grant, list effective permissions.
- `resolveAccess({ projectSlug, principal }) → { tools, accounts, defaultAccount, credential, limits }` implementing the intersection rules (ARCHITECTURE §4); limits = project limits tightened by grant.
- Expired/revoked grants and credentials fail closed.

## Acceptance criteria
- [ ] Table-driven tests for every intersection case, incl. grant asking for more than project allows (gets the intersection, never more).
- [ ] Credential revalidation job/command (detect revoked NR keys).

## Security notes
T2, T3. Fail closed everywhere.

## Docs to update
- `docs/guide/access-model.md` (diagrams, personal vs team examples, BYO-key pattern).

## Out of scope
- UI (P4).
