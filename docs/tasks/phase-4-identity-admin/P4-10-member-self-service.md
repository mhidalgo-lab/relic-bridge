---
id: P4-10
title: "Member self-service API: own credentials, grants and device tokens"
phase: 4
status: review
priority: medium
depends_on: [P4-02]
adr: [0008, 0009]
owner: "claude-agent"
---

# P4-10 — Member self-service API: own credentials, grants and device tokens

## Goal
P4-02 enforces roles but gives `member` sessions only `GET /session` and their own session revocation. ROADMAP and
ADR-0008 also expect members to manage their own New Relic keys (BYO-key), see their own grants and tokens, and
connect devices, without seeing anyone else's data.

## Scope
- A `/api/admin/v1/me/*` namespace, open to every signed-in role (`requiredRole` = `member` for `/me/*`) and refused for
  the admin token (it is nobody: `403 forbidden`, `detail: no_user`, audited). Every handler takes the user from the
  session; no route accepts a user, owner or project id, and the strict schemas refuse `ownerUserId` / `userId`.
  - `GET|POST /me/credentials`, `PATCH|DELETE /me/credentials/{id}`, `POST /me/credentials/{id}/rotate|revalidate`:
    keys with `ownerUserId = self`. A created key is always owned by the caller (never shared); at most 10 per user.
  - `GET /me/grants`: grants with `userId = self`, each with its project (`slug`, `name`, `disabled`).
  - `PATCH /me/grants/{id}` `{ credentialId }`: point a live grant of the caller at one of their own valid keys, or
    back at the project default (`null`). Scope (tools, accounts, limits) is not touchable.
  - `GET /me/tokens[?grantId]`, `POST /me/tokens`, `POST /me/tokens/{id}/revoke`: device tokens on the caller's own live
    grants; at most 20 live tokens per grant. The plaintext appears once, in the create response.
- A row that is someone else's answers exactly like a missing one (`404 not_found`), so ids cannot be probed.
- Same CSRF, origin and audit rules as P4-02. Audit rows reuse the admin action names (`credential.create`,
  `token.create`, ...) with `details.self = true`; the new `grant.set_credential` records which key id.
- P2-12 matrix rows for every route; `member-self-service.test.ts` covers the flow and the cross-user attempts.
- Grants are still created by administrators (see the pending decision about self-service grants).

## Acceptance criteria
- [x] A member can complete the BYO-key flow (add key, see grant, issue a device token) and cannot read or change any
      other user's credentials, grants or tokens (matrix).
- [x] Every `/me` route is in the P2-12 matrix (HTTP app and Worker): unauthenticated, admin token (`no_user`), CSRF and
      origin refusals, and a member acting on another member's, an admin's, a shared or a service resource.
- [x] Refusals and changes are audited with the member as actor; no key or token plaintext appears in any response
      (beyond the one-time token), audit row or log.

## Security notes
T3 (cross-tenant), T13, T14.

## Docs to update
- `docs/guide/admin-access.md`, admin API reference (generated), `docs/THREAT_MODEL.md`.

## Out of scope
- Screens for members (P4-15). Members creating their own grants (pending decision).
