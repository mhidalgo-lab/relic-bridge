---
id: P4-10
title: "Member self-service API: own credentials, grants and device tokens"
phase: 4
status: todo
priority: medium
depends_on: [P4-02]
adr: [0008, 0009]
owner: ""
---

# P4-10 — Member self-service API: own credentials, grants and device tokens

## Goal
P4-02 enforces roles but gives `member` sessions only `GET /session` and their own session revocation. ROADMAP and
ADR-0008 also expect members to manage their own New Relic keys (BYO-key), see their own grants and tokens, and
connect devices, without seeing anyone else's data.

## Scope
- Ownership-scoped admin API access for `member` sessions (or a `/api/admin/v1/me/*` namespace): list/create/rotate/
  delete credentials with `ownerUserId = self`; list own grants (`userId = self`); issue and revoke tokens on own
  grants. Never another user's rows, never shared credentials' details beyond what a grant needs.
- Same CSRF and audit rules as P4-02; P2-12 matrix rows for "member acting on someone else's resource" on every
  route.

## Acceptance criteria
- [ ] A member can complete the BYO-key flow (add key, see grant, issue a device token) and cannot read or change any
      other user's credentials, grants or tokens (matrix).

## Security notes
T3 (cross-tenant), T13, T14.

## Docs to update
- `docs/guide/admin-access.md`, admin API reference (generated).

## Out of scope
- Screens (P4-04, P4-06).
