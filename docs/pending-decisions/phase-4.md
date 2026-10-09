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

### ALL — GitHub Actions quota exhausted
- **Context:** From PR #60 onward, CI did not run: GitHub Actions jobs fail within seconds because of the account's
  billing / spending limit (failed payment).
- **Assumption made:** Every check (`pnpm lint && pnpm typecheck && pnpm test && pnpm test:workers && pnpm build`,
  `pnpm bench:cpu`, the Docker image build when available) was run locally only.
- **Options:** fix billing, then re-run CI on every PR from #60 onward (bottom of the stack first).
- **Needs:** owner: fix billing and re-run CI on all PRs from #60 onward.

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

## P4-04 — Admin screens

### P4-04 — HTTP form E2E instead of Playwright; browser run and screenshots moved to P4-11
- **Context:** The acceptance criterion asked for a Playwright E2E of the personal setup (2 keys US/EU, 2 projects,
  3 device tokens) and the guide asked for screenshots. The repo has no browser tooling; adding it means a new dev
  dependency, a browser download in CI and Actions minutes.
- **Assumption made:** The panel needs no JavaScript, so the same setup is driven through the HTML forms over HTTP
  in the P2-12 harness, on the HTTP app and on the Worker (`packages/http-app/test/authz/ui-screens.test.ts`): each
  token appears in exactly one response and works on its MCP endpoint, and the leak scan runs. A real-browser run
  (CSP and Trusted Types enforcement, copy button, 320 px layout) and the screenshots are task P4-11.
- **Options:** (a) keep it and do P4-11 as a manual/local run; (b) P4-11 with a CI job; (c) drop the browser run.
- **Needs:** owner choice for P4-11 (CI minutes vs. manual).

### P4-04 — Reloading the one-time token page issues another token
- **Context:** A new token is rendered on the answer to the POST that created it (never in a redirect, URL or
  cookie). Reloading that page makes the browser re-send the form, which issues a second token (the first stays
  valid until revoked).
- **Assumption made:** Accepted, with a warning on the page ("Do not reload this page"); the extra token is listed and
  revocable.
- **Options:** (a) keep it; (b) Post/Redirect/Get with the token parked in KV for ~60 s under a random single-use
  handle that the GET page consumes (no re-issue on reload, but the token sits in storage briefly, encrypted or not).
- **Needs:** owner preference; (b) is a small follow-up.

### P4-04 — Grants cannot be edited, and grant-level query limits are API-only
- **Context:** The admin API has no grant update (P2-09). The screen offers create, revoke and delete. The API's
  grant `limits` (narrowing the project's query limits per grant) are not on the form, to keep it short on a phone.
- **Assumption made:** "Revoke and recreate" is explained on the grant page; per-grant query limits stay API-only.
- **Options:** add `PATCH /grants/{id}` (label, tools, accounts, rate limit, expiry) and an edit form; add the limit
  fields to the grant form.
- **Needs:** owner choice; neither blocks P4-05/P4-06.

### P4-04 — Pickers and lookups load at most 1000 rows
- **Context:** Selects (keys, users, projects, grants) and name lookups in tables read whole lists through the admin
  API, which pages at 200.
- **Assumption made:** Up to 1000 rows per list (5 calls); beyond that, a picker is incomplete. Personal and small-team
  use is far below.
- **Options:** server-side search fields for large instances (later), or a higher cap.
- **Needs:** nothing now.

### P4-05 — Usage statistics aggregate the audit rows on demand
- **Context:** `GET /audit/stats` runs one `GROUP BY` over `tool_call` rows in the window (at most 90 days, 100
  groups). On SQLite that is cheap. On D1 every row in the window is a row read, so a 90-day view on a deployment
  recording very many calls costs that many reads per page view (only admins can ask; the screen defaults to 7 days).
- **Assumption made:** Accept it: bounded window and group count, documented in the audit and Cloudflare guides; no new
  table or migration in this task.
- **Options:** (a) keep; (b) a daily rollup table filled by the existing hourly cron (cheap reads, one more migration
  and a backfill story); (c) a covering index on `(kind, ts, action, status, duration_ms)` (faster scans, slower
  audit writes, which are D1's scarcer budget).
- **Needs:** owner choice only if a busy Workers deployment shows read-quota pressure.

### P4-05 — Members see their own audit rows (including admin changes they made)
- **Context:** The task note says members see only their own entries. The admin API now lets the `member` role call
  `GET /audit` with `userId` forced to their own id. Own rows can include `details` such as the request address of a
  refused request that named them.
- **Assumption made:** Allowed; usage statistics and name lookups stay admin-only, and members have no "own usage"
  view yet.
- **Options:** keep; hide `details` and `nrql` from members; add a member usage summary (small follow-up).
- **Needs:** owner preference; P4-10 (self-service) is the natural place for a member view.

### P4-05 — CSV export is capped at 5,000 rows without an on-page notice
- **Context:** The export pages through the admin API 200 rows at a time (25 in-process calls) and stops at 5,000
  newest rows; the cut is signalled by an `X-Export-Truncated` response header only (a browser download shows no
  notice, and a CSV has no place for a comment).
- **Assumption made:** Accept; the guide says to narrow the time range for more.
- **Options:** a "truncated" final row; a confirmation page showing the match count first; streaming export with a
  higher cap (needs a storage count or a streaming query).
- **Needs:** nothing now.

### P4-06 — Snippets are verified against documentation, not run in the clients
- **Context:** Claude Code and Cursor formats were checked against their current docs (`${VAR}` in `.mcp.json`,
  `${env:NAME}` in Cursor, `claude mcp add --transport http --header`). VS Code and Claude Desktop (`mcp-remote`) follow
  the clients guide. Nothing was run in a real client.
- **Assumption made:** Acceptable; the clients guide already says which snippets the maintainers have run.
- **Needs:** owner run through each client once with a real token and update `docs/guide/clients.md`.

### P4-06 — Claude Desktop needs the literal token in its config file
- **Context:** The `mcp-remote` bridge has no secret prompt in Desktop's config, so the token sits in
  `claude_desktop_config.json`.
- **Assumption made:** Accepted and warned about on the one-time page.
- **Options:** document an OS-keychain wrapper script; wait for Phase 5 OAuth (Desktop connectors).
- **Needs:** nothing now.
