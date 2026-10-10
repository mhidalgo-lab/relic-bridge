---
id: P4-02
title: "Admin sessions, CSRF and roles"
phase: 4
status: done
priority: high
depends_on: [P4-01]
adr: [0009]
owner: "claude-agent"
---

# P4-02 — Admin sessions, CSRF and roles

Turns the P4-01 sign-in (a verified, allowed user handed to `IdentityOptions.onLogin`) into a browser session that
the admin API accepts next to the bootstrap admin token, with CSRF protection and role enforcement.

## Scope
- **Sessions** (`packages/auth/src/identity/session.ts`, web-standard): server-side, in storage `kv` (D1 / SQLite,
  never isolate memory). Session secret = 256-bit CSPRNG value; the cookie carries `<userId>.<secret>`, storage keeps
  only SHA-256(secret) in the key (`sess:<userId>:<hash>`). Idle timeout (separate `sess-seen:` row, touched at most
  once a minute, so a revocation can never be undone by a concurrent touch) and absolute timeout, both checked
  against the app clock; `kv` expiry is only a clean-up backstop. Logout (server-side delete), revoke-all for a user
  (prefix list + delete), a per-session synchronizer CSRF token.
- **Cookie** `__Host-rb_session` (plain `rb_session` on http loopback, like `rb_login`): `Secure`, `HttpOnly`,
  `SameSite=Lax`, `Path=/`, no `Domain`, `Max-Age` = absolute timeout. Lax (not Strict) because sign-in ends in a
  redirect chain started by the IdP (cross-site): Strict would withhold the cookie on the first page after sign-in and
  on every link into the admin. Unsafe methods are covered by the CSRF token and Origin checks; cross-site API reads
  by `Sec-Fetch-Site`.
- **Login** (`onLogin`, wired by `createHttpApp` whenever sign-in is configured, so `serve` and the Worker get it):
  revoke the session the browser already had (rotation, no fixation), create a new one, set the cookie, `303` to
  `next`. Audited `session.create`.
- **Logout**: `POST /auth/logout` (form field `_csrf` or `X-CSRF-Token`, same-origin), `everywhere=1` revokes every
  session of the user. Audited `session.revoke` / `session.revoke_all`.
- **Admin API accepts session or admin token**: a request with an `Authorization` header is authenticated by the
  bearer token only and its cookies are ignored; without one, the session cookie is used. Failed sessions get the
  admin API's single `401` (reasons `session_malformed`, `session_unknown`, `session_expired`, `session_idle`,
  `session_user_disabled`) through the same failure hooks and throttle as bad tokens.
- **CSRF** for cookie-authenticated admin requests: unsafe methods need `X-CSRF-Token` equal to the session's token
  (constant time) **and** `Origin` equal to `RB_PUBLIC_URL`'s origin (or, without `Origin`, `Sec-Fetch-Site:
  same-origin`); any method with `Sec-Fetch-Site` other than `same-origin` / `none` is refused. `403 forbidden`.
- **Roles** (every admin route, cookie sessions): `owner` > `admin` > `member`. Bearer admin token = `owner`
  (break-glass). `owner` only: `keys/rotate`, `setup-links`. `admin`: everything else, but may not create, promote to,
  modify or revoke an `owner`. Nobody changes their own role or disables themselves through a session. `member`:
  `GET /session` and revoking their own sessions only. Refusals `403 forbidden`, audited `admin.forbidden`.
- New admin routes: `GET /api/admin/v1/session` (who am I, role, CSRF token, expiries) and
  `POST /api/admin/v1/users/{id}/sessions/revoke`.
- Role change or disable of a user revokes all their sessions; a disabled or deleted user's session fails on the next
  request (user record read per request, cached ≤ 5 s per isolate and cleared on admin changes).
- Settings `RB_SESSION_IDLE_MINUTES` (default 30, 5–1440) and `RB_SESSION_MAX_HOURS` (default 12, 1–168) in
  `identitySettingsFromEnv` (serve and Worker).
- Admin API mounted when an admin token **or** sign-in is configured.
- P2-12 matrix: session principals (malformed, unknown, expired, idle, revoked, revoked-all, disabled user, wrong
  role, missing/invalid/foreign CSRF token, cross-origin, missing Origin, cross-site fetch metadata, cookie next to a
  bearer header) on every admin route; session cookies confer nothing on MCP and pass-through routes; Node + Worker.

## Acceptance criteria
- [x] Unit tests for the session store: hashing, idle/absolute expiry, touch, revoke, revoke-all, malformed cookies.
- [x] Tests for CSRF rejection (token and Origin / fetch metadata), role enforcement and session expiry on every admin
      route, on the HTTP app and the Worker (P2-12 matrix).
- [x] Login sets `__Host-rb_session` with the right attributes and rotates an existing session; logout revokes
      server-side; revoke-all and role change / disable end sessions.
- [x] Bearer requests ignore cookies; cookie sessions never authenticate MCP or pass-through routes.
- [x] Audit rows for login, logout, revocations, role refusals.

## Notes for P4-03 (admin UI)
- Authenticate UI pages with the same session: `createSessionManager` (`packages/http-app/src/session.ts`) is built
  by `createHttpApp` when sign-in is on; call `sessions.authenticate(c)` (→ `SessionPrincipal` with `user`, `role`,
  `session.record.csrf`) and redirect to `/auth/login?next=<path>` on failure. Use `ROLE_RANK` / `requiredRole` for
  page-level role checks; the API enforces them again.
- Embed `session.record.csrf` in every form as `_csrf` (`CSRF_FIELD`) or send it as `X-CSRF-Token` (`CSRF_HEADER`)
  from scripts; check unsafe form posts with `sessions.checkFetchOrigin(c, true)` and `sessions.csrfMatches(...)`.
- Sign-out is `POST /auth/logout` (form with `_csrf`, optional `everywhere=1`). `GET /api/admin/v1/session` gives
  scripts the role and token.
- UI routes are new entries in the P2-12 matrix (guard test) and must never accept bearer tokens as page auth.

## Security notes
T13 (CSRF), T14 (session theft / fixation / privilege escalation).

## Docs to update
- `docs/guide/admin-access.md` (new: sessions, roles, CSRF for API clients), `docs/guide/identity-providers.md`,
  `docs/guide/self-hosting.md`, `apps/worker/README.md`, `docs/reference/admin-api.md` (generated),
  `docs/THREAT_MODEL.md`, `docs/ARCHITECTURE.md`, README.

## Out of scope
- Member self-service on credentials, grants and tokens (P4-10).
- The admin UI and its form handling (P4-03+); a session list UI.
- Purging expired `kv` rows (P4-09).
