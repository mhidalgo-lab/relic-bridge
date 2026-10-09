---
id: P4-21
title: Only owners create, demote, disable or unbind administrators
phase: 4
status: in-progress
priority: medium
depends_on: [P4-16]
adr: []
owner: claude-agent
---

# P4-21 — Only owners create, demote, disable or unbind administrators

## Goal
Owner decision (pending-decisions phase 4, P4-07, 2026-10-09): administrators stop being peers of each other. Only an
owner (or the bootstrap admin token, which acts as owner) may change another administrator, which closes the
rogue-admin path (THREAT_MODEL threat actor 5) and matches Review H1.

## Scope
- `packages/http-app/src/admin/api.ts` `updateUser`: refuse (`denied('owner')`-style) when the target's current role
  is `admin`, or the requested role is `admin`, and the caller does not act as owner. Same rule for revoking a
  user's sessions, unbinding their identity and creating a user with role `admin`.
- Admin UI user screens: hide or disable the controls an admin may no longer use on another admin.
- Members are unaffected; an admin still manages members.

## Acceptance criteria
- [ ] An admin session gets 403 for promote-to-admin, demote, disable/enable, unbind and session revoke of another
      admin; an owner session and the bootstrap token succeed.
- [ ] Negative authorization tests in the authz matrix (P2-12 suite) for every route above.
- [ ] Admin UI does not render those controls for an admin viewer.

## Security notes
Threat actor 5 (rogue admin); Review H1. Update `docs/THREAT_MODEL.md` role lines.

## Docs to update
- `docs/guide/admin-guide.md`, `docs/reference/admin-api.md` (403 cases), `docs/THREAT_MODEL.md`.

## Out of scope
- Several owners managing each other (unchanged: owners touch owners).
