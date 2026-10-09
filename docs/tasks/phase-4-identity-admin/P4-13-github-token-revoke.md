---
id: P4-13
title: "Revoke the GitHub OAuth token after the identity lookup"
phase: 4
status: todo
priority: low
depends_on: [P4-01]
adr: [0009]
owner: ""
---

# P4-13 — Revoke the GitHub OAuth token after the identity lookup

## Goal
GitHub sign-in exchanges the code for a user access token, reads the id, primary email and organization membership, and
then forgets the token. GitHub keeps such tokens valid until revoked, so the token should be revoked as soon as the lookup
is done (least privilege, nothing lingers at GitHub). Split out of P4-09 because it adds a provider call with its own
failure modes.

## Scope
- After a successful or refused GitHub identity lookup, call `DELETE /applications/{client_id}/token` (Basic auth with the
  client id and secret, body `{"access_token": …}`) through the injected `fetch` (10 s timeout, no redirects, bounded).
- A failed revocation never fails the sign-in: log the status code only (never the token), at `warn`.
- Mock-IdP tests: the revoke call happens once, carries no token in logs, and a revoke failure does not block sign-in.

## Acceptance criteria
- [ ] The token is revoked after the lookup on success and on refusals that happen after the exchange.
- [ ] A revoke failure is logged without the token and sign-in still follows the policy decision.
- [ ] `docs/RESEARCH.md` cites the GitHub endpoint and its auth.

## Security notes
T14, T8: the token and client secret never reach logs or audit rows; no new stored state.

## Docs to update
- `docs/guide/identity-providers.md`, `docs/THREAT_MODEL.md`, `docs/RESEARCH.md`.

## Out of scope
- Other providers (Google and OIDC tokens are not kept after the ID token is verified).
