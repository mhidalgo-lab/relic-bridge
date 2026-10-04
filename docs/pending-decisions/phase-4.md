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

### P4-11 — Browser E2E runs manually, not in CI; Referrer-Policy changed to fix form posts
- **Context:** The P4-04 decision asked whether the Playwright run goes into CI. Actions is unavailable and minutes are scarce.
  Separately, the first real-browser run showed that every admin form POST (even sign-out) was refused with
  `forbidden_origin`: `Referrer-Policy: no-referrer` makes browsers send `Origin: null`. The HTTP-level tests could not see it.
- **Assumption made:** (1) `pnpm test:e2e` locally plus a `workflow_dispatch`-only workflow (`e2e.yml`); not on PRs. The
  workflow was never run. (2) HTML pages (the ones carrying the admin CSP) now send `Referrer-Policy: same-origin` (header
  and meta); API responses and redirects keep `no-referrer`. The server's strict Origin check is unchanged. THREAT_MODEL updated.
- **Options:** keep; add a CI job on release branches or a weekly schedule once billing works; or accept `Origin: null` with
  `Sec-Fetch-Site: same-origin` plus CSRF token instead (weaker, not chosen).
- **Needs:** owner: confirm the policy change, and choose when to run the browser job in CI. Screenshots show demo data
  only; regenerate with `pnpm e2e:screenshots` after UI changes.

### P4-04 — Reloading the one-time token page issues another token
- **Context:** A new token is rendered on the answer to the POST that created it (never in a redirect, URL or
  cookie). Reloading that page makes the browser re-send the form, which issues a second token (the first stays
  valid until revoked).
- **Assumption made:** Accepted, with a warning on the page ("Do not reload this page"); the extra token is listed and
  revocable.
- **Options:** (a) keep it; (b) Post/Redirect/Get with the token parked in KV for ~60 s under a random single-use
  handle that the GET page consumes (no re-issue on reload, but the token sits in storage briefly, encrypted or not).
- **Needs:** owner preference; (b) is a small follow-up.
- **Update (P4-07):** resolved without parking the token: every token form carries a single-use handle stored in
  `kv`; a re-sent form (reload, back button) issues nothing and returns to the token list with a notice. The token is
  still never stored. Nothing for the owner to decide unless (b)'s "show it again on reload" is wanted.

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

## P4-07 — Admin panel security review

### P4-07 — Admins manage other admins
- **Context:** Today an `admin` may promote a member to admin and demote or disable another admin; only owners touch
  owners (review I2).
- **Assumption made:** Kept: a personal or small-team instance has one or two owners who are also the admins.
- **Options:** (a) keep; (b) only owners make, demote or disable admins (admins manage members only).
- **Needs:** owner choice; (b) is a few lines in `PATCH /users/{id}` plus matrix rows.

### P4-07 — Non-ASCII email addresses are refused at sign-in
- **Context:** Lowercasing folds some non-ASCII characters onto ASCII ones (the Kelvin sign onto `k`), which could let
  an IdP account claim another user's unbound row (review L2).
- **Assumption made:** Sign-in requires a printable-ASCII email from every IdP (`email_missing` otherwise).
  Internationalised addresses (`user@bücher.example` in Unicode form) cannot sign in.
- **Options:** keep; or accept Unicode after NFKC normalisation and compare normalised forms everywhere (users table
  included, needs a migration of stored emails).
- **Needs:** nothing unless someone needs internationalised addresses.

### P4-07 — Sign-in rate limit default and Workers scope
- **Context:** New per-IP rule for `/auth/*` (review L4): 60 requests per 5 minutes (about 20 sign-ins), on top of the
  general per-IP limit. On Workers it is counted per isolate (not by the Rate Limiting binding), like the auth-failure
  throttle.
- **Assumption made:** The default fits personal and small-team use; `RB_RATE_LIMIT_SIGN_IN` tunes it on `serve`.
- **Options:** a tighter default; add `signin:` to the binding's shared prefixes (needs a second binding with its own
  limit, since the binding's limit is fixed per namespace).
- **Needs:** nothing now.

### P4-07 — A refused sign-in uses up a setup link
- **Context:** The setup link is consumed before the user decision, so a sign-in that is then refused (disabled user,
  identity conflict) burns it (review I1).
- **Assumption made:** Accepted: it fails closed, and the owner issues a new link.
- **Options:** consume only after a successful decision (still atomic `take`, two code paths to keep race-free).
- **Needs:** nothing unless it bites during the P4-01 owner run.

### P4-07 — ZAP baseline scan moved to P4-12
- **Context:** The original P4-07 scope included a ZAP baseline scan in CI; CI is unavailable (billing).
- **Assumption made:** Manual review plus probe suites now; the scan is task P4-12 (low priority).
- **Needs:** owner choice of CI job vs. manual run when CI is back.

## P4-09 — Sign-in operations

### P4-09 — Unbinding a user leaves the account claimable by email
- **Context:** Clearing `(idp, idp_subject)` lets the next verified sign-in with the same email bind the account, at
  whichever configured provider asserts it (P4-01's rule for unbound users). During that window anyone who controls the
  address at any configured provider (a generic OIDC provider can assert any address) can take the account.
- **Assumption made:** Accepted, with safeguards: owner only (admin token counts), never yourself through a session,
  the email must be retyped, sessions end, audited as `user.unbind`; the guide spells out the risk. No expiry on the
  unbound state and no way to name the provider the user may move to.
- **Options:** (a) keep it; (b) let the owner name the target provider (`bindTo: "github"`) and refuse binds from others
  until a deadline; (c) several identities per user (the P4-01 option c), which makes unbinding rare.
- **Needs:** owner choice; (b) is a small change in `decideLogin` plus one `kv` or user column.

### P4-09 — `cf:setup --sign-in` sets non-secret sign-in settings with `--var`
- **Context:** The client ids, issuer and `RB_PUBLIC_URL` are deployed as `wrangler deploy --var NAME:value`, like
  `RB_PLAN`, and re-runs use `--keep-vars`. Only the fake Wrangler runner was exercised (no real deploy is allowed).
- **Assumption made:** Wrangler keeps vars deployed this way on a later `--keep-vars` deploy. If it does not, a plain
  re-run without `--sign-in` would drop them and sign-in would turn off until `--sign-in` is run again.
- **Options:** keep; or write the vars into the git-ignored `wrangler.local.jsonc` `vars` (durable, still no secrets).
- **Needs:** owner: run `pnpm cf:setup --sign-in` and a plain re-run once against a staging Worker and check Settings,
  Variables.

### P4-09 — Local `setup-link` needs the provider variables in the CLI's environment
- **Context:** Locally the CLI builds the link itself, so it needs `RB_PUBLIC_URL` and the provider block (including the
  client secret, or its `_FILE`) as `serve` has them, only to learn the public URL and the provider ids.
- **Assumption made:** Accepted (same environment as `serve`; `--remote` needs only the admin token).
- **Options:** a `--public-url` flag plus provider id without secrets for local use.
- **Needs:** nothing unless that is awkward in practice.

### P4-09 — Expired `kv` purge writes no audit row and has no manual command
- **Context:** The Worker cron and `serve` purge expired `kv` rows hourly and log counts. Unlike `audit.purge`, no admin
  audit row is written (one per hour of a few rows would be noise), and `relic-bridge audit purge` does not touch `kv`.
- **Assumption made:** Logging is enough; expired rows are invisible anyway.
- **Needs:** nothing.

### P4-09 — Follow-ups split into tasks
- GitHub OAuth token revocation after the lookup: P4-13. Unbind in the admin panel: P4-14.

### P4-10 — Members cannot create their own grants; BYO keys are not switchable per project
- **Context:** The BYO-key flow needs a grant. Grants decide scope (project, tools, accounts, limits), so P4-10 leaves
  creating them to administrators; a member adds a key, then points an existing grant of theirs at it.
  Any member can switch their grant to their own key, and there is no per-project "BYO keys not allowed" switch.
- **Assumption made:** Administrators assign grants; members choose which of their own keys a grant uses.
- **Options:** (a) keep; (b) a project flag `selfService` letting members create a user grant on it with the project's
  defaults (tools/accounts capped by the project); (c) a project flag forbidding member key switches.
- **Needs:** owner choice; (b) and (c) are small follow-up tasks if wanted.

### P4-10 — Caps on self-service
- **Context:** 10 keys per user and 20 live tokens per grant are constants in `admin/api.ts`, not settings.
- **Assumption made:** Generous for personal use, and bound storage and New Relic validation calls.
- **Needs:** nothing unless a team hits them.

### P4-10 — Member screens split out
- Screens for members (P4-15) and a session list for members (not built) are follow-ups.

### P4-13 — Revocation does not retry
- **Context:** A failed revocation (GitHub down, 5xx) is logged at `warn` and not retried. The token then lives until GitHub expires or the user revokes the app authorization.
- **Assumption made:** One best-effort attempt is enough; the token is never stored, so a retry queue would need new state.
- **Needs:** nothing unless the warnings turn out to be frequent.

## P4-14 — Unbind in the admin panel

### P4-14 — No single-use handle on the unbind form
- **Context:** The task text mentions a single-use handle against re-sent forms. That handle (`_once`) exists to keep a
  re-sent form from issuing a second secret (device tokens). Unbind issues nothing, and the API is idempotent in effect: a
  re-sent form finds no identity and answers `409`, which the page shows as "This user has no sign-in identity to clear".
- **Assumption made:** The retyped email plus the API's `409` are enough; no handle was added.
- **Needs:** nothing unless a handle is wanted for consistency.

## P4-15 — Member screens

### P4-15 — Forged ids answer with a 404 page, also for form posts
- **Context:** The admin screens answer a missing row on an action with a redirect and a flash. For member screens the
  acceptance criteria ask for the `404` page when a form names another user's key, grant or token.
- **Assumption made:** On `/admin/me/*` every id that is not in the caller's own `/me` lists (or that the API refuses
  with `404`) renders the generic "Page not found" page with status 404, for GET and POST alike.
- **Needs:** nothing.

### P4-15 — No member screens for session lists or creating grants
- **Context:** The task keeps "members creating their own grants" out of scope, and P4-10 left a member session list
  unbuilt. The "My access" page therefore has no "new grant" and no "my sessions" section.
- **Needs:** owner choice on the P4-10 pending decision about self-service grants.

## P4-12 — ZAP baseline scan

### P4-12 — Scan is manual, not on every pull request
- **Context:** GitHub Actions was unavailable (billing) and the ZAP image is about 3.7 GB; a run takes several minutes.
- **Assumption made:** `.github/workflows/zap.yml` is `workflow_dispatch` only. It has not run on GitHub; the same command
  ran locally via Docker Desktop (WSL), with a relay container because the VM's localhost is not the host's.
- **Needs:** owner choice: keep manual, or add a weekly `schedule` (like `bench.yml`) once minutes allow.

### P4-12 — Only Medium/High alerts fail the run
- **Assumption made:** Low and Informational alerts are printed; the Informational ones seen are ignored with reasons.
- **Needs:** nothing unless a stricter gate (also Low) is wanted.

### P4-12 — API scan mutates a throwaway database
- **Context:** the OpenAPI scan sends generated requests to every operation (passive rules only, but the requests are real).
- **Assumption made:** fine on a temporary database with fake keys and a mock NerdGraph; never point it at a real instance.


## P4-08 — Docs and release v0.4

### P4-08 — Cut v0.4.0 and validate the guides on a clean deployment
- **Context:** like P1-15, P2-13 and P3-07, the task asks for a release and for a validation by a fresh agent session. The
  run was unattended: no publish, tag, GitHub release, image push or deploy was made, and no changeset or version bump was
  added (earlier phases left both to the owner; `.changeset/` holds no pending entries and the CLI is still 0.1.0).
- **Assumption made:** the new `docs/guide/admin-guide.md` and the fixes to the existing guides were checked against the
  source (routes, variables, defaults, warnings) and the built CLI (`--help`, `init --help`), not by a fresh session or a
  clean deployment. README and ROADMAP say "implemented, not released yet".
- **Needs (owner):** read the admin guide once on a phone, set up a real provider following it, fix what differs, then cut
  v0.4.0 (v0.2 and v0.3 are also still unreleased: decide whether to release them first or as one train, and whether the
  Phase 3 and Phase 4 pending decisions block it).

### P4-08 — Allow-list without auto-provisioning is silent
- **Context:** `RB_LOGIN_ALLOW_*` set with `RB_LOGIN_AUTO_PROVISION=off` admits nobody and logs no warning (the reverse
  case does warn). The guide says so plainly.
- **Needs:** owner choice: add a start-up warning in a follow-up task, or leave as is.
