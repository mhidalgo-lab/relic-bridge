---
id: P7-32
title: "Owner-only re-enable of users who hold write grants"
phase: 7
status: done
priority: low
depends_on: [P7-28]
adr: [ADR-0015]
owner: claude-agent
---

# P7-32 — Owner-only re-enable of users who hold write grants

## Goal
P7-28 made widening a write-enabled project or grant owner-only. An admin can still re-enable a user an owner disabled
(`PATCH /users/{id}` with `disabled: false`), which brings back that user's write grants and their tokens.

## Scope
- Re-enabling a user whose grants name a write tool needs an owner (or the admin token), through `guardWriteScope` and
  a rule in `packages/auth/src/access/write-scope.ts`.
- Check any other user change that restores write access (none known today).

## Acceptance criteria
- [x] Negative authz test: admin session re-enabling a user with a write grant gets 403; owner and admin token pass.
- [x] Re-enabling a user without write grants stays open to admins.
- [x] THREAT_MODEL T31 updated.

Checked other user changes: role and display name do not reach tools, unbinding is owner-only, revoked grants and
keys cannot be restored, config import never re-enables users. Only `disabled: false` needed the guard.

## Security notes
T31, T14.

## Docs to update
- `docs/THREAT_MODEL.md`, `docs/guide/admin-guide.md`, ADR-0015 P7-28 addendum (residual).

## Out of scope
- Per-field narrowing rules for limits and key rotation (pending decision P7-28).
