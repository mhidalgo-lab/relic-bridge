---
id: P4-18
title: "Tighten member key switching and personal keys as project defaults"
phase: 4
status: todo
priority: low
depends_on: [P4-10]
adr: []
owner: ""
---

# P4-18 — Tighten member key switching and personal keys as project defaults

## Goal
Two self-service edges from the phase 4 review (L2, L3), pending the owner's answer to "P4-10 — Members cannot create
their own grants; BYO keys are not switchable per project" in `docs/pending-decisions/phase-4.md`.

## Scope
- `PATCH /me/grants/{id}` with `{"credentialId": null}` moves a grant an administrator pinned to a narrow key back to
  the project default (possibly wider accounts when the grant has no `accountIds`). Allow `null` only when the grant
  currently uses a key the member owns, or add the per-project "no member key switches" flag (option c).
- A personal key can be a project's default (an owner may choose that for themselves; since the review admins cannot
  pick an owner's key). When a *member's* personal key is a project default, that member can rotate or rename the key
  every user of the project queries through. Refuse a personal key as `defaultCredentialId` unless the acting user owns
  it, and warn on the project page when the default is personal.

## Acceptance criteria
- [ ] The pinned-grant reset is refused (or allowed) per the owner's decision, with a member authz test.
- [ ] A member-owned default key: decision implemented and tested (API, UI, workers pool).

## Security notes
T3 (account scope), T21 (data plane isolation between users).

## Docs to update
- `docs/guide/admin-access.md` (member self-service), `docs/guide/admin-panel.md`.

## Out of scope
- Member-created grants (option b of the same decision).
