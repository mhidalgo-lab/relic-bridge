---
id: P8-86
title: The one-time setup code never travels in a URL
phase: 8
status: in-progress
priority: high
depends_on: []
adr: []
owner: claude-agent
---

# P8-86 — The one-time setup code never travels in a URL

## Goal
The first-owner setup link carries its one-time code in the query string
(`/auth/login/<provider>?setup=rb_setup_<64 hex>`, valid 1 h by default and up to 7 days; the first sign-in through it
becomes `owner`). Query strings are recorded by request logs on every host (access logs, proxies, platform request logs
such as Cloudflare Workers Logs), browser history, and can leak through `Referer`. Keep one-time codes out of URLs, logs
and `Referer`: the link carries the code in the URL **fragment**, which browsers never send to a server.

## Design
- **Link:** `<RB_PUBLIC_URL>/auth/setup[?provider=<id>]#setup=rb_setup_<64 hex>` (admin API `POST /setup-links`, CLI
  `setup-link` local and `--remote`). Only the non-secret provider id stays in the query.
- **`GET /auth/setup`:** a small admin-UI page (UI CSP, no inline script) with a form that posts to `/auth/setup`: a
  code field plus hidden `provider` / `next`. The admin script (`admin.js`, `script-src 'self'` + SRI, already loaded by
  every page) reads `#setup=…`, removes the fragment from the address bar (`history.replaceState`) and submits the form.
  Without script the person pastes the code into the field.
- **`POST /auth/setup`:** form-encoded, capped body, same-origin only (the session routes' Fetch-metadata/`Origin`
  check: no session exists yet, so there is no CSRF token; the code itself is the unguessable value). A well-formed,
  live code is **not** consumed here (as before, only the completed sign-in consumes it): its SHA-256 goes into a
  short-lived `HttpOnly; SameSite=Lax` cookie (`__Host-rb_setup` on https, 10 min) and the browser is sent (`303`) to the
  sign-in chooser. A bad, used or expired code answers `400` with the generic "invalid or expired" page.
- **Sign-in:** `GET /auth/login/<provider>` and `GET /auth/cf-access` take the setup from that cookie (instead of
  `?setup=`), move it into the login transaction / consume it as before, and clear the cookie. The chooser shows the
  "becomes the owner" card when the cookie is there, and lists only the link's provider when it named one.
- **Old links refused:** any `/auth/*` request with a `setup` query parameter answers `400` with a page that says setup
  links changed and how to get a new one. Nothing is read from storage, the code is not echoed, logged or audited.
  **No transition window:** links live 1 hour by default (7 days at most) and the owner issues a new one with one
  command, so an old link fails closed with a clear message; accepting both forms for a while would keep the leak open
  for exactly the links it is about.
- **Referrer policy:** UI pages keep `Referrer-Policy: same-origin` (not `no-referrer`: with it browsers send
  `Origin: null` on form posts, which the same-origin check rightly refuses). A fragment is never part of a `Referer`
  (Fetch spec), and `same-origin` sends nothing to other sites.
- **Why a cookie and not a redirect to the IdP from the POST:** the UI CSP has `form-action 'self'`, which browsers
  apply to the redirects that follow a form post, so a post cannot end at the provider. The chooser link is a plain
  navigation.

## Scope
- `packages/http-app/src/identity.ts` (routes), `packages/http-app/src/admin/api.ts` (link format),
  `packages/http-app/src/session.ts` (shared same-origin check).
- `packages/admin-ui`: `SetupPage`, `LoginPage` text, `assets/admin.js` (fragment → form), generated assets.
- CLI `setup-link` output and help; e2e helpers (`e2e/server.ts`, `e2e/zap.ts`) for the new flow.
- Tests: link format; `?setup=` refused without a storage read or a logged code; POST works once, replay, expired and
  malformed refused; cross-site / missing-Origin refused; the code in no log line or audit row; Worker runtime test;
  authz suite rows for the new routes.

## Acceptance criteria
- [ ] `POST /setup-links` and `relic-bridge setup-link` (local, `--remote`) return `…/auth/setup[?provider=…]#setup=rb_setup_…`;
      no setup code in any query string.
- [ ] `GET /auth/setup` serves the setup form under the UI CSP (`script-src 'self'`, no inline script, no CSP change);
      `admin.js` fills the form from the fragment, clears it with `history.replaceState` and submits.
- [ ] `POST /auth/setup`: same-origin only (cross-site, foreign `Origin`, missing `Origin` refused), form-encoded and
      capped; a live code sets the setup cookie and redirects to the chooser; malformed, unknown, used or expired codes
      are refused; the code is consumed only by the completed sign-in (single use, replay refused).
- [ ] Any `/auth/*` request with `?setup=` is refused (`400`) with a "request a new link" page, reads no storage and
      logs, echoes and audits no code.
- [ ] The setup code (and its cookie value) appears in no log line, audit row or error page in the tests; the audit
      log still records `setup_link.create` and the `owner_bootstrap` sign-in.
- [ ] Worker runtime test: setup link → POST → OIDC sign-in → owner, on D1.
- [ ] Negative authorization rows for `GET`/`POST /auth/setup` in the authz suite.
- [ ] Docs: identity providers, admin guide, Cloudflare guide, CLI reference/help, admin API reference regenerated;
      THREAT_MODEL row; changeset with the upgrade note.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass.

## Security notes
T14 (admin takeover), T8 (secrets in logs). Bearer secrets stay out of URLs: the code is in the URL fragment, never sent
to or logged by any server; between the setup form and the provider choice it lives only as a hash in an `HttpOnly`
cookie scoped to this origin for 10 minutes. The setup POST is same-origin only (login CSRF). Old-format links fail
closed.

## Docs to update
- `docs/guide/identity-providers.md`, `docs/guide/admin-guide.md`, `docs/guide/cloudflare-deploy.md`,
  `docs/reference/cli.md`, `docs/reference/admin-api.md` (generated), `docs/THREAT_MODEL.md`, `docs/ARCHITECTURE.md`
  (sign-in flow line), changeset.

## Out of scope
- Other one-time values (OAuth codes and `state` are protocol-defined query parameters with their own protections).
