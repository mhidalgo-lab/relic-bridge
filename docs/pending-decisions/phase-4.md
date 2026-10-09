# Phase 4 — pending decisions

Decisions that agents could not make alone during the autonomous run (2026-10-03). Each entry says what was
assumed so work could continue. Review, then answer in place or move the outcome into an ADR / task file.

Format: `### <task id> — <short title>` then **Context**, **Assumption made**, **Options**, **Needs**.

## Workflow

### ALL — stacked PRs instead of merging to `main`
- **Context:** The owner was away. Every task PR targets the previous task's branch (the first one targets
  `phase/4-identity-admin` (itself stacked on the tip of Phase 3, `task/P3-15-rotation-guards`)), so nothing is merged into `main`.
- **Assumption made:** A dependency counts as satisfied when its task is `review` and its branch is lower in the
  stack. Tasks stay `review`, not `done`, until their PRs are merged.
- **Options:** merge the stack bottom-up (retarget each PR to `main` after its parent merges), or squash-merge the
  tip into `main` in one go.
- **Needs:** owner's merge strategy; then mark merged tasks `done` and run `pnpm tasks index`.

## P4-01 — Identity providers

### P4-01 — Real provider apps and an end-to-end run
- **Context:** Everything is tested against a mock IdP (self-generated keys): unit tests, the HTTP app, `serve` over a
  real loopback redirect, and workerd on D1. No real Google or GitHub OAuth app and no Cloudflare Access application
  was created, because the run may not register apps or handle real credentials.
- **Assumption made:** Provider endpoints and claims follow current documentation (RESEARCH §16). The acceptance
  criterion "real apps exercised end to end" is left unticked.
- **Options / owner steps:** (1) Google: create a Web OAuth client with redirect `<RB_PUBLIC_URL>/auth/callback/google`.
  (2) GitHub: create an OAuth app with callback `<RB_PUBLIC_URL>/auth/callback/github`. (3) Optionally, a Cloudflare
  Access self-hosted application on `/auth/cf-access`, then copy its AUD tag. Set the variables
  (`docs/guide/identity-providers.md`), issue a setup link with `POST /api/admin/v1/setup-links`, and sign in once per
  provider. Check the audit log for `login.ok`.
- **Needs:** owner run (about 20 minutes); report any claim or endpoint mismatch as a bug.

### P4-01 — One provider identity per user (no email-based linking across IdPs)
- **Context:** `users` has a single `(idp, idp_subject)`. An owner who signs in with Google on one device and GitHub
  on another would need two identities on one user.
- **Assumption made:** A verified email binds only a user with **no** binding yet. A user already bound to another
  subject or provider is refused (`identity_conflict`). This prevents takeover through a second IdP that asserts the
  same email (for example, a generic OIDC provider that can assert any address). Re-binding on purpose is tracked in
  P4-09.
- **Options:** (a) keep it (safe default); (b) allow login by verified email across providers without re-binding,
  which is convenient and trusts every configured IdP's email verification; (c) add a `user_identities` table, with
  several identities per user linked from a signed-in session (a new migration; probably P4-02/P4-09).
- **Needs:** owner choice; (c) is the clean long-term answer if multi-IdP use matters.

### P4-01 — The allowlist governs self-sign-up only
- **Context:** The task asks for allowlists of emails, domains and GitHub orgs, with deny by default.
- **Assumption made:** A pre-created (or already bound) enabled user may always sign in, because the user row is the
  explicit allow. `RB_LOGIN_ALLOW_*` admits **unknown** identities, and only when `RB_LOGIN_AUTO_PROVISION` is
  `member` or `admin` (default `off`). A setup link bypasses the allowlist to make the owner. Consequence: leaving a
  GitHub org does not lock out an existing user. Disable the user instead.
- **Options:** (a) keep it; (b) also re-check the allowlist for existing users when it is set (stricter, but the owner
  must be on it too or is locked out).
- **Needs:** owner confirmation.

### P4-01 — Cloudflare Access emails count as verified
- **Context:** Access assertions carry `email` with no `email_verified` claim.
- **Assumption made:** Access authenticated the user through its own IdP for that email, so relic-bridge treats it as
  verified. The assertion is verified against the team JWKS and AUD, and service tokens (no email) are refused.
- **Options:** keep it, or require the Access policy to use specific IdPs only (a documentation recommendation).
- **Needs:** owner confirmation.

## P4-02 — Admin sessions, CSRF and roles

### P4-02 — The bootstrap admin token acts as `owner`
- **Context:** The admin API now takes a session (with a role) or `RB_ADMIN_TOKEN`. The token had no role before.
- **Assumption made:** The token is break-glass and automation (`keys rotate --remote`, setup links, CI): it counts
  as `owner` on every route and needs no CSRF token (browsers can't attach an `Authorization` header cross-site, and
  cookies are ignored on any request that has one).
- **Options:** (a) keep it; (b) a lesser role, with owner-only actions needing a session (safer if the token leaks,
  but the first owner and recovery then depend on sign-in working); (c) a separate, optional owner token.
- **Needs:** owner confirmation.

### P4-02 — `SameSite=Lax`, 30 min idle / 12 h absolute
- **Context:** The task allowed Lax or Strict. Strict withholds the cookie on the first page after the IdP redirect
  chain and on every link into the admin from mail or chat (RESEARCH §17).
- **Assumption made:** Lax, with every unsafe request needing the CSRF token **and** `Origin` = `RB_PUBLIC_URL`, and
  cookie requests with `Sec-Fetch-Site` other than `same-origin` (or `none` for reads) refused. Defaults 30 min idle,
  12 h absolute (`RB_SESSION_IDLE_MINUTES`, `RB_SESSION_MAX_HOURS`).
- **Options:** Strict plus a same-origin bounce page after sign-in; shorter defaults (OWASP suggests 4-8 h absolute
  for high-value apps).
- **Needs:** owner confirmation of the defaults.

### P4-02 — What each role may do
- **Context:** ROADMAP names owner, admin, member; nothing said where the lines are.
- **Assumption made:** `owner`: everything; only owners rotate the master key, issue owner setup links and create,
  change or sign out owners. `admin`: every other admin route. `member`: `GET /session` and their own sign-out only;
  self-service on their own keys, grants and tokens is P4-10. Nobody changes their own role or disables themselves
  through a session (so a session can't lock the last owner out). A role change or disable ends all the user's
  sessions.
- **Options:** let admins manage other admins only by owners; let members read the project list; allow an owner to
  step down when another owner exists.
- **Needs:** owner confirmation; P4-10 refines members.

### P4-02 — User records cached ≤ 5 s per isolate
- **Context:** "Disabled users lose sessions immediately (checked per request, cached briefly)".
- **Assumption made:** Disabling (or a role change) through the admin API deletes the user's sessions in storage, so
  it is immediate everywhere. The per-request user check (for a user disabled some other way) reads the user record
  through a 5 s per-isolate cache, cleared on that isolate by any admin change.
- **Options:** no cache (one more D1 read per admin request).
- **Needs:** nothing unless the owner prefers no cache.

## P4-03 — Admin UI scaffold

### P4-03 — Cross-site links into the panel open the page
- **Context:** The admin API refuses every cookie request whose `Sec-Fetch-Site` is not `same-origin` (or `none` for
  reads). Applied to pages, a link to `/admin/...` from mail, chat or another site would fail.
- **Assumption made:** Pages also accept cross-site **top-level document navigations** (`Sec-Fetch-Mode: navigate`,
  `Sec-Fetch-Dest: document`, GET/HEAD); any other cross-site or same-site request (subresource, `fetch`, frame) is
  `403` before the session is read. A navigation only shows the page to the user (no CORS, COOP `same-origin`,
  `frame-ancestors 'none'`), and forms still need the CSRF token and our `Origin`.
- **Options:** (a) keep it; (b) same-origin and `none` only (links from elsewhere land on a "continue" page).
- **Needs:** owner confirmation.

### P4-03 — The UI calls the admin API in-process
- **Context:** Screens need the same validation, role rules and audit as the API.
- **Assumption made:** `kit.callAdmin` sends an internal request through the whole app as the signed-in user, with
  the session cookie, the CSRF token, our own `Origin` and the client-address headers attached. Each page that loads
  data therefore counts as two requests against the per-IP limit, and the admin call writes its own access-log line.
- **Options:** (a) keep it; (b) call the domain services directly from the UI (fewer requests, but a second copy of the
  checks and audit to keep in sync).
- **Needs:** nothing unless the owner prefers (b).

### P4-03 — No admin panel without sign-in
- **Context:** The admin API also works with only `RB_ADMIN_TOKEN`; the panel needs a session.
- **Assumption made:** `/admin` exists only when a sign-in provider is configured. With the token alone, `/admin` is
  the ordinary 404 and the CLI or the API is the way in. Pasting the admin token into a browser form was not added
  (it would turn a break-glass secret into a phishable login).
- **Options:** keep it, or add a token login page with its own session (role `owner`).
- **Needs:** owner confirmation.
