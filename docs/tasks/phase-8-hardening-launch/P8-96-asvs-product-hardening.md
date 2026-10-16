---
id: P8-96
title: ASVS product open items - end all sessions, Clear-Site-Data, outbound redirect policy, metadata host allow-list
phase: 8
status: done
priority: medium
depends_on: []
adr: []
owner: claude-agent
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
- [x] Negative authorization tests for the new routes (member, wrong CSRF, stale sign-in, other user's session id).
- [x] Tests: the logout header; no outbound client follows a redirect; an allow-list miss refuses the client with an
      audited reason.
- [x] ASVS rows V7.4.5, V7.5.2, V14.3.1, V15.3.2 and V13.2.4: evidence recorded below and in the PR description.
      `docs/security/asvs-l2.md` is not edited here (P8-95 / PR #281 rewrites it); update the rows after both merge.

## Security notes
T9/T10 (sessions), T13 (SSRF via metadata documents). Update THREAT_MODEL.

## Docs to update
- `docs/security/asvs-l2.md` (after P8-95 merges, from the evidence below), admin guide, configuration reference
  (generated if applicable), audit-log action list, changeset (minor).

## Out of scope
- MFA claims (`acr` / `amr`), recorded as a limit.

## Outcome
- **Routes:** `POST /api/admin/v1/users/sessions/revoke-all` (owner, recent sign-in, body `confirm: "end all sessions"`,
  optional `includeSelf`), `GET /api/admin/v1/me/sessions`, `POST /api/admin/v1/me/sessions/{id}/revoke`. Admin panel:
  "My browser sessions" under My access (`POST /admin/me/sessions/:id/revoke`), "End all sessions" under Users
  (`GET|POST /admin/users/sessions/revoke-all`).
- **Audit actions:** `session.revoke_all_users` (new), `session.revoke` with `reason: self_service` (existing action),
  `oauth.client.refused` (new, capped like other refusal rows).
- **Config:** `RB_OAUTH_CIMD_HOSTS` (name follows `RB_OAUTH_DCR_REDIRECT_HOSTS`): comma-separated exact host names,
  validated at startup by `oauthSettingsFromEnv`; unset = unchanged. The deprecated-config registry (P8-67) ships empty
  and the new name is not a rename, so there is no entry.
- **No schema migration:** the session list reads the existing `sess:<userId>:` kv prefix; the coarse browser label is
  an optional `client` field in the session JSON (older sessions show as "Unknown browser").
- **Decisions taken (also in `docs/pending-decisions/phase-8.md`):** ending a session needs no recent sign-in
  (protective; `/me/*` stays out of P8-73's set); the allow-list is exact hosts, no wildcards; revoke-all keeps the
  caller's session unless `includeSelf`.
- Not done: screenshots in `docs/guide/images` are not regenerated (the My access and Users pages gained a section and
  a button).

## ASVS evidence
For the rows of `docs/security/asvs-l2.md` (update them after P8-95 merges). All paths relative to the repo root.

| Row | Change | Code | Tests |
|---|---|---|---|
| V7.4.5 (admins can end sessions of one user or all) | `partial` -> `met`: `POST /users/sessions/revoke-all` | `packages/http-app/src/admin/api.ts` (`revokeAllUserSessions`, `requiredRole`, `sensitiveRoute`), `packages/auth/src/identity/session.ts` (`revokeAllSessions`), `packages/http-app/src/session.ts` (`revokeEverySession`) | `packages/http-app/test/authz/session-hardening.test.ts` (member, administrator, CSRF, cross-site, no session, stale sign-in, wrong phrase, keeps caller, `includeSelf`, admin token), `reauth.test.ts` (listed as a sensitive action), `routes.test.ts` (matrix, owner-only), `ui-sessions.test.ts`, `packages/auth/test/session-list.test.ts` |
| V7.5.2 (users can view and end their sessions) | `partial` -> `met` for listing and ending; re-authentication before ending is a decision: not required (ending only reduces access), residual noted in THREAT_MODEL | `api.ts` (`mySessions`, `revokeMySession`), `session.ts` (`listUserSessions`, `revokeUserSessionByRef`, `coarseClientLabel`), `packages/admin-ui/src/screens/me.tsx` | `session-hardening.test.ts` (own rows only, another user's id and a prefix of it are 404, no secret in the response, wrong CSRF, admin token `no_user`, idle sessions not listed), `ui-sessions.test.ts`, `packages/admin-ui/test/me.test.ts` (escaping, axe), `session-list.test.ts` |
| V14.3.1 (client storage cleared at logout) | `partial` -> `met`: `Clear-Site-Data: "cookies", "storage"` | `packages/http-app/src/identity.ts` (`CLEAR_SITE_DATA`, `toLogin`) | `packages/http-app/test/authz/routes.test.ts` "sign-out (P4-02)": present on a sign-out and on an expired-session sign-out, absent on a refused one and on a cookie-less cross-site form |
| V15.3.2 (outbound calls do not follow redirects) | `partial` -> `met`: one policy, `redirect: 'manual'` (or `error`) forced everywhere | `packages/core/src/outbound.ts` (`outboundFetch`, `noRedirects`); defaults changed in `nerdgraph/client.ts`, `auth/src/identity/{github,oidc,cf-access}.ts`, `http-app/src/telemetry.ts`, `apps/cli/src/manage/host.ts`, `apps/cli/src/test-hooks.ts`, `apps/worker/src/cimd-fetch.ts`, `scripts/nerdgraph-schema.ts`; IdP calls already set it (`identity/http.ts`, `jwt.ts`); Node metadata fetcher uses `node:https` | `scripts/test/outbound-redirects.test.ts` (fails on any source file that calls the global `fetch`; wrapper behaviour; a 302 stays unfollowed), `oauth-suite.ts` CIMD "redirect" case, `apps/cli/test/cimd-fetch.test.ts` |
| V13.2.4 (allow-list of external resources) | `partial` -> `met` when `RB_OAUTH_CIMD_HOSTS` is set (opt-in; default stays guarded "any public host") | `packages/http-app/src/oauth/settings.ts`, `server.ts` (`clientMetadataHosts`, `resolveClient`), `apps/worker/src/env.ts`, `apps/cli/src/args.ts` | `oauth-suite.ts` "RB_OAUTH_CIMD_HOSTS (P8-96)" and "narrowing ... cached" (nothing fetched, audited `oauth.client.refused` with host only, token endpoint too, listed host works), `apps/cli/test/serve-identity.test.ts` (parsing and bad values) |
