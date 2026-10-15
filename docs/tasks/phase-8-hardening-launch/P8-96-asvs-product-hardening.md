---
id: P8-96
title: ASVS product open items - end all sessions, Clear-Site-Data, outbound redirect policy, metadata host allow-list
phase: 8
status: todo
priority: medium
depends_on: []
adr: []
owner: ""
---

# P8-96 — ASVS product open items: end all sessions, Clear-Site-Data, outbound redirect policy, metadata host allow-list

## Goal
Close the product items still open in `docs/security/asvs-l2.md`:
- V7.4.5: an "end every user's sessions" admin operation
- V7.5.2: users can list their active browser sessions
- V14.3.1: `Clear-Site-Data` on logout
- V15.3.2: an explicit redirect policy on every outbound client
- V13.2.4: an optional operator allow-list for OAuth client metadata-document hosts

## Scope
- Owner-only `POST /users/sessions/revoke-all` (admin API and panel, recent sign-in per P8-73, CSRF, typed
  confirmation, audited as `session.revoke_all_users`). It doesn't end the caller's own session, or else it says so.
- `/me/sessions`: list active sessions (created, last seen, coarse user agent; never the token) and end one.
- `Clear-Site-Data: "cookies", "storage"` on logout responses.
- One outbound `fetch` wrapper (or audit of every call site) that sets `redirect: "manual"` or `"error"` everywhere
  (NerdGraph, IdP, JWKS, metadata documents, OTLP, doctor), with a lint or test that finds raw `fetch` calls.
- `RB_OAUTH_CIMD_HOSTS` (name to be confirmed against existing config naming): optional host allow-list for
  metadata-document fetches. When it is unset, behaviour stays the same. Validated at startup, listed in the config
  reference.

## Acceptance criteria
- [ ] Negative authorization tests for the new routes (member, wrong CSRF, stale sign-in, other user's session id).
- [ ] Tests: the logout header; no outbound client follows a redirect; an allow-list miss refuses the client with an
      audited reason.
- [ ] ASVS rows V7.4.5, V7.5.2, V14.3.1, V15.3.2 and V13.2.4 updated with evidence.

## Security notes
T9/T10 (sessions), T13 (SSRF via metadata documents). Update THREAT_MODEL.

## Docs to update
- `docs/security/asvs-l2.md`, admin guide, configuration reference (generated if applicable), audit-log action list,
  changeset (minor).

## Out of scope
- MFA claims (`acr` / `amr`), recorded as a limit.
