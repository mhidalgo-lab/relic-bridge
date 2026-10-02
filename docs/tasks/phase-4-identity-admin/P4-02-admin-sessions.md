---
id: P4-02
title: "Admin sessions, CSRF and roles"
phase: 4
status: todo
priority: high
depends_on: [P4-01]
adr: [0009]
owner: ""
---

# P4-02 — Admin sessions, CSRF and roles

## Scope
- Session cookie `__Host-rb_session` (HttpOnly, Secure, SameSite=Lax), server-side sessions in storage, idle + absolute timeout, logout everywhere.
- CSRF: synchronizer token on all state-changing forms; `Origin` check.
- Roles: owner, admin, member (member can only manage own credentials, see own grants/tokens, connect devices).
- Admin API accepts session **or** admin token.

## Acceptance criteria
- [ ] Tests for CSRF rejection, role enforcement, session expiry.

## Security notes
T13, T14.

## Docs to update
- Admin guide.

## Out of scope
- —
