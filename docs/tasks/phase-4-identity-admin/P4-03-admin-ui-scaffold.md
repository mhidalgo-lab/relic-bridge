---
id: P4-03
title: "Admin UI scaffold (Hono JSX, strict CSP)"
phase: 4
status: in-progress
priority: high
depends_on: [P4-02]
adr: [0004]
owner: "claude-agent"
---

# P4-03 — Admin UI scaffold (Hono JSX, strict CSP)

The frame every admin screen (P4-04 and later) is built in: server-rendered pages under `/admin`, authenticated by the
P4-02 session, with one strict Content Security Policy and no inline script or style anywhere.

## Scope
- **Package split.** `packages/admin-ui` (web-standard, ADR-0004) owns the views and the `/admin` routes:
  `createAdminUi(deps)` returns a Hono sub-app. It depends on `hono` only; what it needs from the server (sessions,
  calls to the admin API, audit) arrives through a small structural `AdminUiDeps` interface, so there is no package
  cycle. `packages/http-app` mounts it whenever sign-in is configured (the UI needs a session), on `serve` and the
  Worker alike.
- **Rendering.** Hono JSX (`.tsx`, `@jsxImportSource hono/jsx`), rendered to a string with `<!doctype html>`.
  Auto-escaping only: no `raw()`, `html` template helper or `dangerouslySetInnerHTML` in the UI sources, enforced by a
  lint script (`scripts/check-ui-escaping.ts`) and an XSS test that renders hostile strings through every component.
- **Components.** Layout (skip link, header, nav, main landmark, footer with sign-out), nav (current page marked with
  `aria-current`), flash banner (`role=status` / `role=alert`), form with the CSRF hidden field, labelled fields with
  hints and errors (`aria-describedby`, `aria-invalid`), button, data table with caption and `scope` headers,
  disclosure-based confirm (no JS), error page, message page, login page (lists the configured providers).
- **Design.** Design tokens as CSS custom properties, light and dark (`prefers-color-scheme`, `color-scheme`),
  responsive from 320 px (phone first: the owner manages from a phone), visible focus, ≥ 44 px touch targets, reduced
  motion. Token colour pairs meet WCAG AA 4.5:1 (tested).
- **Static assets** (`/admin/assets/<name>.<hash>.<ext>`): one stylesheet and one small script, authored as files and
  compiled into `assets.generated.ts` by `scripts/gen-admin-assets.ts` (content hash in the name, SHA-384 SRI;
  `--check` in lint). Served from the bundle on Node and Workers alike (no static-assets binding needed), `immutable`
  caching, `nosniff`, correct types; unknown names are 404. The script is optional: every page works without it
  (progressive enhancement: it only adds copy-to-clipboard buttons).
- **Headers** on every UI page, including the `/auth/*` sign-in pages, which move onto the same layout:
  `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src
  'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'`, plus
  `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy` (everything off), and the existing `nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, HSTS. The global security
  middleware keeps exactly this CSP (and the asset cache header) and replaces anything else.
- **Auth for pages.** `sessions.authenticate`; no session → `303 /auth/login?next=<path>` (a presented but dead
  cookie is cleared); bearer tokens never authenticate a page. Fetch metadata: same-origin, `none` and top-level
  cross-site *navigations* (links from mail or chat) are served; any other cross-site request (subresource, `fetch`,
  frame) is refused `403`. Page-level role gate `requireRole`; the admin API checks again.
- **Forms.** `readForm(c, principal)`: urlencoded only, 16 KiB cap, `Origin` / fetch-metadata check and the `_csrf`
  token (constant time); refusals are a `403` page and an `admin.forbidden` audit row. Post/Redirect/Get with flash
  messages (a short-lived HttpOnly cookie holding a message *code* from a fixed catalogue, never text).
- **Calling admin services.** `callAdmin(c, principal, request)` runs the admin API in-process with the caller's
  session (same validation, roles, audit). Unsafe methods need the `VerifiedForm` that `readForm` returned, so a UI
  handler cannot skip the CSRF check.
- **Pages in this task:** `GET /admin` (overview: who you are, role, session expiry, sign out / sign out everywhere,
  and for admins a user count through `callAdmin`), the asset route, and the authenticated `/admin/*` 404. Errors: a
  generic 500 page with the request id only (no stack, no message).
- **P2-12 matrix:** the new routes (Node + Worker): bearer tokens, admin token, MCP token, query credentials and every
  broken session are redirected to sign-in; cross-site subresource requests refused; assets public.

## Acceptance criteria
- [ ] CSP has no `unsafe-inline` / `unsafe-eval`; a test asserts the full header set on every UI route (Node and
      Worker), including error, 404 and sign-in pages.
- [ ] axe-core accessibility checks (WCAG 2.1 A/AA rules) pass on every page and component state in CI; colour
      tokens meet 4.5:1 in light and dark.
- [ ] Snapshot/DOM tests for the layout, flash, forms, tables, error and login pages; hostile strings are escaped
      everywhere; the escaping lint guard fails on `raw()` / `dangerouslySetInnerHTML`.
- [ ] Unauthenticated, bearer-only and broken-session requests to `/admin*` never render a page (redirect to sign-in);
      `next` stays same-origin; cross-site subresource requests are refused; matrix guard lists the new routes.
- [ ] `readForm` refuses missing/wrong CSRF tokens, foreign `Origin`, cross-site fetch metadata and oversized bodies;
      `callAdmin` refuses unsafe methods without a verified form.
- [ ] Assets: hashed names, SRI on the tags, immutable caching, served by `serve` and the Worker; the Worker CPU
      benchmark still passes.

## Security notes
T13 (XSS, CSRF, clickjacking), T14 (session use on pages).

## Docs to update
- `docs/dev/admin-ui.md` (new: conventions for screens), `docs/guide/admin-access.md`, `docs/THREAT_MODEL.md`,
  `docs/ARCHITECTURE.md`, `apps/worker/README.md` if behaviour differs.

## Out of scope
- Screens (P4-04), audit viewer (P4-05), connect page (P4-06).
- A session list UI and member self-service (P4-10).
