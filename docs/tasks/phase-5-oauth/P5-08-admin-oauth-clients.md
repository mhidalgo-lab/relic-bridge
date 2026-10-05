---
id: P5-08
title: "Admin: OAuth client list, revoke and DCR switch"
phase: 5
status: todo
priority: medium
depends_on: [P5-03]
adr: [0011, 0012]
owner: ""
---

# P5-08 — Admin: OAuth client list, revoke and DCR switch

## Goal
Owners see which OAuth clients exist (dynamically registered and cached metadata-document clients), remove one with
every grant and token issued to it, and turn dynamic client registration off without a redeploy. Split out of P5-03.

## Scope
- Admin API (owner only): list `oauth:client:*` records (id, kind, name as untrusted text, redirect hosts, registration
  date, expiry), delete a client (registration + every provider grant of that client, all users; CIMD clients may
  re-authorize with consent).
- Runtime setting `oauth.registration` (settings table) read per registration request; admin UI toggle.
- Admin UI screen with the list, remove (CSRF, single-use form handle) and the toggle; OpenAPI regenerated.
- P2-12 negative authorization tests for the new routes (members, admins, device and OAuth tokens refused).

## Acceptance criteria
- [ ] Removing a client ends its tokens on the next request (access cache TTL bound) and its refresh tokens at once.
- [ ] DCR off via the admin switch → `/oauth/register` 404 and no `registration_endpoint` in metadata.
- [ ] Routes in the authz matrix with negative tests.

## Security notes
T10 (admin can revoke clients), T13/T14 (admin UI CSRF), T19.

## Docs to update
- `docs/dev/oauth.md`, admin guide, OpenAPI.

## Out of scope
- Per-device (grant) revocation and revoke-all on grant revoke (P5-05).
