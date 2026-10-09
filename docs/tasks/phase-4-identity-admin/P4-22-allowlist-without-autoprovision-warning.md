---
id: P4-22
title: Warn at startup when an allowlist is set but auto-provisioning is off
phase: 4
status: in-progress
priority: low
depends_on: [P4-08]
adr: []
owner: claude-agent
---

# P4-22 — Warn at startup when an allowlist is set but auto-provisioning is off

## Goal
Owner decision (pending-decisions phase 4, P4-08, 2026-10-09): `RB_LOGIN_ALLOW_*` with
`RB_LOGIN_AUTO_PROVISION=off` silently does nothing for unknown identities. Warn, as the reverse case already does.

## Scope
- `packages/auth/src/identity/config.ts`: push a warning when `autoProvision === 'off'` and an allowlist is set,
  explaining that only users who already exist can sign in.

## Acceptance criteria
- [ ] Warning emitted for that combination, not for the others; unit test.

## Security notes
None (diagnostic only; no behaviour change).

## Docs to update
- `docs/guide/identity-providers.md`.

## Out of scope
- Changing auto-provisioning semantics.
