---
id: P8-73
title: Re-authentication for sensitive admin actions
phase: 8
status: review
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-73 — Re-authentication for sensitive admin actions

## Goal
An admin session cookie is enough today for every action its role allows (`requiredRole` in
`packages/http-app/src/admin/api.ts`), including the most damaging ones. A stolen or left-open session (or an XSS that
slipped past the CSP) can rotate the master key, create owners and administrators, or import a configuration without any
second proof. Sensitive actions should require a fresh login or an explicit step-up.

## Scope
- Define the sensitive set from the real routes in `packages/http-app/src/admin/api.ts`, at least: `POST /keys/rotate`,
  `POST /config/import`, user creation and role changes to `admin`/`owner` (`/users`, `/users/{id}`), disabling users,
  `POST /users/{id}/sessions/revoke` for other users, `POST /oauth/clients/remove`, `POST /oauth/registration`,
  credential rotation (`/credentials/{id}/rotate`) and token creation with long expiry. Confirm the list with the owner
  before building (pending decision).
- Mechanism (decide in an ADR if it changes the session model): either (a) the action requires the session's
  authentication to be younger than N minutes (the session record already has `createdAt`; add a "last authenticated at"
  that only a real sign-in sets), or (b) a step-up confirmation through the same identity provider. A refused action
  returns a distinct error (`reauth_required`) and the admin UI sends the user through sign-in with `next` back to the page.
- The admin bearer token principal (`admin_token`, used by the CLI) has no session: define its behaviour explicitly
  (exempt, since it is itself a secret, or governed by a separate setting) and document it.
- The in-process calls the admin UI makes as the session must pass the same check.
- Audit: a refused action writes an `admin.forbidden` (or a dedicated) row; a successful step-up writes one.

## Refinement (2026-10-15, before building)
Checked against main:
- Sign-in methods: Google, GitHub, generic OIDC (redirect + PKCE/state/nonce) and Cloudflare Access (header JWT). There are
  no passkeys. Every successful sign-in creates a **new** session (`SessionManager.login` rotates), so the session record's
  `createdAt` is set only by a real sign-in and is the "last authenticated at". No new session field and no ADR are
  needed. The session model is unchanged.
- Mechanism (a): an action is allowed when `now - session.createdAt < RB_SESSION_REAUTH_MINUTES` (default 10, range
  1-60), decided server-side from storage. The step-up is a normal sign-in through the same provider and routes, so
  PKCE, state and nonce are untouched.
- Refusal: `403 {"error":{"code":"forbidden","detail":"reauth_required",…}}`, the same on every route. Keeping
  `forbidden` as the code means existing clients still read it as a refusal; `detail` makes it distinct. It is audited:
  `admin.forbidden` with `reason: reauth_required`, or for a check that depends on the body, the action's own `denied`
  row with `details.reason`.
- The admin token (`admin_token`, CLI) is exempt. It is a long secret held outside the browser, so the risks this task
  covers (a stolen or left-open session cookie) do not apply to it. Recorded as an owner decision.
- Final sensitive set (session principals only):
  path only: `POST /keys/rotate`, `POST /config/import` (dry run included), `POST /setup-links` (mints an owner),
  `POST /users/{id}/unbind`, `POST /oauth/clients/remove`, `POST /oauth/registration`, `POST /credentials/{id}/rotate`,
  `DELETE /projects/{id}` (revokes every token of a project);
  body or target dependent: `POST /users` with role `admin`/`owner`, `PATCH /users/{id}` changing `role` or `disabled`,
  `POST /users/{id}/sessions/revoke` for another user, `POST /tokens` with `ttlSeconds` `never` or above 90 days.
- `/me/*` is out: those routes act on the caller's own rows and reach nothing beyond the caller's own access.
- Admin UI: `kit.callAdmin` turns the refusal into a 303 to `/auth/login?next=<page>&reauth=1` (the page comes from the
  same-origin `Referer`, else `/admin`). The sign-in page explains why. A sign-in that replaces a live session of the
  same user is audited `session.create` with `stepUp: true`.

## Acceptance criteria
- [x] Each sensitive route refuses a session whose last authentication is older than the window, with the same status and
      body for every route, and the refusal is audited (negative authorization tests, one per route).
- [x] After a fresh sign-in the same action succeeds; the window and the sign-in time cannot be altered by the client.
- [x] Non-sensitive routes are unaffected (test).
- [x] The admin UI shows the re-authentication flow and returns to the page (browser/axe test where the UI has one).
- [x] Member self-service routes (`/me/*`) are classified explicitly (in or out) with a test.
- [x] `docs/THREAT_MODEL.md` rows updated (T13, T14).

## Security notes
T13, T14, T8. The check must be server-side and based on stored session data, never a cookie or form field the client sends.
Step-up through the identity provider must not weaken PKCE/state/nonce handling in `packages/auth/src/identity`. Default
window must be safe (short) and configurable only downward or within a bounded range.

## Docs to update
- `docs/guide/admin-access.md`, `docs/guide/admin-panel.md`, `docs/reference/admin-api.md` (generated; regenerate),
  `docs/THREAT_MODEL.md`, `docs/dev/admin-ui.md`, possibly a new ADR, changeset.

## Outcome
- `RB_SESSION_REAUTH_MINUTES` (default 10, 1-60) on `serve` and the Worker; `sessionIsFresh` in `@relic-bridge/auth`,
  `SessionManager.isFresh`, `sensitiveRoute` and `requireFresh` in the admin API.
- Tests: `packages/http-app/test/authz/reauth.test.ts` (P2-12 suite, Node and workerd): one negative case per sensitive
  action with an identical body and an audit row, positive controls (fresh session, admin token), the window boundary,
  client-supplied hints ignored, non-sensitive routes, `/me/*`, and the admin UI round trip (form to sign-in and back,
  Referer fallback). Auth unit tests for the setting and `sessionIsFresh`; a11y for the sign-in notice; `stepUp` audit.
- Owner decisions (defaults taken): window 10 minutes (1-60); the admin token is exempt; `/me/*` is out; the
  "fresh" proof is the relic-bridge sign-in, without forcing the IdP to prompt again.
- Possible follow-up: ask the IdP to re-prompt on a step-up (`prompt=login` / `max_age=0` with an `auth_time` check for
  OIDC; support differs for the other providers; Cloudflare Access cannot be forced from here).

## Out of scope
- Multi-factor enrolment inside relic-bridge (the identity provider owns MFA).
