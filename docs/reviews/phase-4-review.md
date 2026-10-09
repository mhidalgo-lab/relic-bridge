# Phase 4 consolidation review

- **Scope:** all of Phase 4 (identity providers and admin panel): `git diff task/P3-15-rotation-guards...task/P4-08-admin-guide-release`
  (P4-01 … P4-15, 48 commits, 227 files, about 28k lines including screenshots and the lockfile).
- **Branch:** `review/phase-4`, stacked on `task/P4-08-admin-guide-release` (top of the Phase 4 PR stack).
- **Date:** 2026-10-04.
- **Method:**
  - Read P4-07's review (`phase-4-admin-security-review.md`), the pending decisions and THREAT_MODEL rows first, then
    went beyond them: P4-07 only covered P4-01 … P4-06, so P4-09, P4-10, P4-13, P4-14 and P4-15 got their first
    adversarial pass here.
  - Three parallel sub-reviews, cross-checked: (1) identity and sessions (OIDC, GitHub, Cloudflare Access, binding,
    unbind, setup links, cookies, CSRF, roles, Worker state), (2) admin API, UI and member self-service (IDOR, role
    escalation, CSRF, XSS/CSP, one-time pages, CSV, connect snippets, audit, authz matrix), (3) completeness against
    every acceptance criterion, docs against code, hard rules, workflows.
  - Probe tests (vitest, in-process HTTP app and the workers pool) for each claimed finding; probes that only confirmed
    that something holds were removed, findings fixed here keep a regression test that fails with the fix reverted
    (checked).
  - Nothing was deployed, published or tagged. GitHub Actions has not run since PR #60 (billing), so every check was run
    locally (see [Local CI](#local-ci)).

## Verdict

**Ready to merge as a stack, with the fixes on this branch.** No critical findings. One high finding is fixed: an admin
could act on an owner's data plane (issue a token on an owner's grant and query New Relic with the owner's personal
key, re-point or plant keys). The rest are medium or low, fixed when trivial and otherwise tracked in P4-16 … P4-20.

The design holds under attack. OIDC is strict (state, nonce and PKCE in `kv` behind a browser-bound cookie, `iss`/`aud`/
`azp`/`exp`/`nbf`/`iat` checked, `none` and HS* refused, RFC 9207 `iss`), sessions are server-side, hash-only, rotated at
sign-in and stored in D1/SQLite (`kv`), not isolate memory. Roles are re-read per request; CSRF is a synchronizer token
plus `Origin` plus fetch metadata; every page is auto-escaped under a strict CSP with Trusted Types; one-time secrets
are never stored or re-rendered; connect snippets use `RB_PUBLIC_URL` only (Host and `X-Forwarded-Host` are ignored).
Every route is in the authz matrix (enforced against the router), on Node and workerd. No `node:*` import in `core`,
`auth`, `http-app` or `admin-ui`.

**The roadmap promise** ("Google/GitHub/Cloudflare Access login, manage everything in the browser, phone-friendly") is
met in code and tests against mock identity providers. Not met yet: a sign-in with a real Google, GitHub or Cloudflare
Access application (pending decision P4-01, owner action). Browser gaps, all deliberate: setup links and master-key
rotation are CLI/API only, there is no session list and no grant edit (revoke and recreate).

## Per-task completeness

| Task | Result | Notes |
|---|---|---|
| P4-01 identity providers | Met, except real IdPs | Mock-IdP negative cases, replay, single-use setup links (`kv.take` atomic on SQLite and D1). Real Google/GitHub/Access unticked and logged. Local `setup-link` with a named OIDC provider printed a dead link: fixed (L3). |
| P4-02 sessions, CSRF, roles | Met | Cookie flags, rotation, idle/absolute limits server side, role change and disable end sessions. Owner boundary incomplete on the data plane: fixed (H1). |
| P4-03 UI scaffold | Mostly met | CSP tests compare against the same constant, axe contrast is off in jsdom, the CPU benchmark has no admin scenario (P4-20). Task text said `no-referrer`; code uses `same-origin` for a reason: task text fixed. |
| P4-04 admin screens | Met | |
| P4-05 audit viewer | Met | The `EXPLAIN` test runs hand-copied SQL (P4-20). |
| P4-06 connect page | Met | Snippets checked against client docs only (decision logged). |
| P4-07 security review | Met | Covered P4-01 … P4-06; this review covers the rest. Line references drifted (P4-20). |
| P4-08 admin guide | Mostly met | Fresh-session validation and v0.4.0 correctly unticked. `audit-log.md` and the sign-in limit docs were wrong: fixed (M2, L4). |
| P4-09 sign-in operations | Met | Unbind, setup links, `cf:setup --sign-in`, `*_CLIENT_SECRET_FILE`, `kv` purge. |
| P4-10 member self-service | Met | Strong IDOR tests (foreign rows answer 404). CSRF/Origin refusals explicit for `POST /me/tokens` only, the matrix covers the rest generically (P4-20). Key-switch edges (P4-18). |
| P4-11 browser e2e | Met | One desktop run timed out under load during the review and passed on rerun (see Local CI). |
| P4-12 ZAP baseline | Met | No Medium/High. A report with a leaked secret was kept and uploadable: fixed (L5). |
| P4-13 GitHub token revoke | Met | Revoked in `finally`, failures logged without the token. |
| P4-14 unbind in UI | Met | Owner-only, typed-email confirmation, single-use handle. |
| P4-15 member screens | Met | Forged-POST IDOR tests, 14 `/admin/me/*` matrix rows. |

## Findings

Severity: impact if exploited or hit × likelihood. Status: **fixed** (here, with tests), **task** (new task file),
**decision** (`docs/pending-decisions/phase-4.md`), **accepted** (documented residual).

### High

**H1. Admins could act on an owner's data plane.** `packages/http-app/src/admin/api.ts` (`createToken`, `revokeToken`,
`createGrant`, `revokeGrant`, `deleteGrant`, `createCredential`, `updateCredential`, `deleteCredential`,
`rotateCredential`, `createProject`, `updateProject`). The "only owners touch owners" rule (`actsAsOwner`,
`denied('owner')`) guarded the `/users` routes only. Probe, as an admin session against an owner with a personal key on
a grant: `POST /tokens` for the owner's grant → 201, and the token answered on `/p/<slug>/mcp`, so the admin queried
New Relic with the owner's key (whatever accounts it reaches); `POST /credentials/{ownerKey}/rotate` with the admin's
key → 200 (the owner's grant now queries an account the admin controls); `POST /credentials` with
`ownerUserId=<owner>` → 201; `DELETE /grants/{ownerGrant}` → 204; `PATCH /projects/{id}` could make the owner's key the
project default for everyone.
*Impact:* privilege escalation from `admin` to the owner's New Relic access, and silent redirection of the owner's
queries. *Fix:* `guardOwnerAssets` refuses (`403`, `detail: owner`, audited as denied) any of those changes when the
grant's user, the credential's owner, the owner of the key a grant names, or the new project default key belongs to an
owner, unless the caller is an owner or the bootstrap token. A project whose default an owner set to their own key
stays grantable by admins (the owner shared it; decision logged). Guides updated. Regression tests:
`packages/http-app/test/p4-consolidation-owner-assets.test.ts` (3 of 4 fail without the fix; the fourth pins what admins
may still do). **fixed, decision**

### Medium

**M1. First-login binding is check-then-act.** `packages/auth/src/identity/policy.ts` (`resolveLoginUser`): read by
email, then `users.update(id, {idp, idpSubject})` by id only. Probe: two concurrent first sign-ins for one unbound
email at two configured providers both returned `ok` and both got sessions; the last writer keeps the binding, the
other session lives up to 12 h. Needs a verified email at a second configured provider. **task P4-16**

**M2. `RB_RATE_LIMIT_SIGN_IN` documented as a Worker setting.** The Worker uses the default rules
(`apps/worker/src/worker.ts`, `DEFAULT_RATE_LIMITS`) and `signin:` is not a shared prefix
(`apps/worker/src/rate-limit.ts`): the limit is fixed and per isolate there. The admin guide and the identity guide
presented it as tunable everywhere. Docs fixed; sharing the prefix is in P4-20. **fixed (docs), task P4-20**

**M3. Unbounded sessions per user; revocation costs 2N+1 storage calls.** `packages/auth/src/identity/session.ts`
(`revokeUserSessions`). A compromised IdP account can create many sessions; *sign out everywhere*, unbind and role
changes then make hundreds of D1 calls and may fail half-way (retries converge; disable still bites per request). The
1,005-session unit test exceeds 5 s under load. Also, `docs/RESEARCH.md` and the Worker/THREAT_MODEL comments disagree on
whether D1 calls count against a 50-per-invocation limit on Free. **task P4-17**

### Low

- **L1** No last-owner guard: two owners demoting or disabling each other concurrently can leave zero owners (recovery:
  CLI or `RB_ADMIN_TOKEN`). **task P4-16**
- **L2** A member can reset an administrator-pinned key on their grant to the project default (`PATCH /me/grants/{id}`
  `credentialId: null`, `api.ts` `setMyGrantCredential`), possibly widening accounts. **task P4-18, decision**
- **L3** Local `setup-link --provider <oidc name>` printed `/auth/login/<name>` while the route is `oidc-<name>`
  (`apps/cli/src/manage/local.ts`), and `--remote` wanted the route id: a dead link. Now one `providerRouteId` in
  `packages/auth/src/identity/config.ts` serves both; help and CLI reference say `oidc|oidc-<name>`. Regression test in
  `apps/cli/test/sign-in-ops.test.ts`. **fixed**
- **L4** `docs/guide/audit-log.md` said admin changes carry `via = "admin_token"` "until Phase 4". Now documents
  `admin_token`, `session` and `cli`. **fixed**
- **L5** `e2e/zap.ts` said it refused to keep a report containing a secret but left it on disk, and `zap.yml` uploads
  reports with `if: always()`. Both report files are now deleted on a hit (the scan's secrets are throwaway fakes).
  **fixed**
- **L6** `kit.issueOnce` writes a `ui-once:` row on every GET and HEAD of a token-form page: any member can spend D1
  writes at the per-IP rate (600/min, rows live 2 h). **task P4-19**
- **L7** Self-service caps (10 keys, 20 live tokens per grant) are list-then-create; parallel requests exceed them
  slightly. **task P4-19**
- **L8** A member whose personal key an administrator made a project default can rotate or rename the key the whole
  project uses (`credentialPermitted` accepts any default). **task P4-18**
- **L9** After H1 the panel still shows admins the change controls on an owner's keys, grants and devices; they now
  lead to the 403 page instead of acting. **task P4-20**

### Quality (low, P4-20)

- **Q1** admin-ui CSP tests compare the header to `UI_CSP` itself; cannot catch a regression.
- **Q2** SQLite `EXPLAIN` test runs hand-copied SQL.
- **Q3** P4-03's CPU benchmark criterion has no admin/asset scenario; axe contrast is off in jsdom.
- **Q4** Role rank duplicated between `admin-ui/src/components.tsx` and `http-app/src/session.ts`; no parity test.
- **Q5** Explicit unauthenticated/CSRF/Origin tests for one `/me` route only (the matrix covers all generically).
- **Q6** `cloudflare-deploy.md` does not list the sign-in variables `cf:setup --sign-in` leaves to the dashboard;
  `apps/worker/src/env.ts` omits `RB_SESSION_*`.
- **Q7** `projects-{light,dark}.png` generated but unreferenced; `docs/dev/admin-ui.md` omits `snippets.ts(x)`.
- **Q8** Drifted line references in the P4-07 review; `.zap/rules.tsv` 10027 reason cites the wrong line.
- **Q9** The login-transaction cookie reader takes the first duplicate cookie; the session reader refuses duplicates.
- **Q10** P4-03 task text said `Referrer-Policy: no-referrer`; fixed here (text only).

### Info

- **I1** `login.denied` rows carry provider and reason only: no way to correlate repeated probes by one identity
  (keyed hash proposed in P4-16). `login.ok` is written before the session is created.
- **I2** No audit row for reads, including the CSV export (P4-20 considers `audit.export`).
- **I3** A second `/auth/login/:provider` tab overwrites the login cookie and burns the first tab's state (nuisance).
  A cross-site GET to `/auth/cf-access` rotates an Access user's session (same user; inherent to header login).
- **I4** A Cloudflare Access session outlives removal from the Access policy by up to the idle/absolute limits.
- **I5** The sign-in limit and the auth-failure throttle are per isolate on Workers (accepted in P4-07, documented).

### Probed and holding (beyond P4-07)

- **Binding:** ASCII-only lowercase emails; Google, OIDC and Access require verified email, GitHub the primary verified
  one; Google `hd` enforced from the token; a row bound elsewhere gives `identity_conflict`; `(idp, idp_subject)` unique.
- **Setup links:** 256-bit, SHA-256 stored, 1 min … 7 days, consumed atomically only by the completed callback (a GET,
  prefetch or scanner does not burn it), redacted from logs and audit, owner-only; links always mean owner.
- **Unbind/move:** owner-only, never self, ends sessions first, typed-email confirmation in the UI, single-use handle.
- **IDOR:** every `/me` id goes through `ownCredential`/`ownGrant`; foreign rows answer 404 like missing ones; strict
  schemas refuse `ownerUserId`/`userId`; the admin token gets `403 no_user` on `/me`.
- **XSS:** a `"><img onerror><script>` payload in every user-controlled label, name and filter, as member and owner,
  was escaped on 21 pages; no `raw()`; hrefs and actions through `localHref`.
- **CSV:** formula prefixes (including LF and space-then-sign), fixed filename, 5,000-row cap with header, member
  scope, cross-site navigation redirected.
- **Connect snippets / host header:** `Host`, `X-Forwarded-Host` and `RB_ALLOWED_HOSTS=*` do not change any URL shown.
- **Secrets:** no IdP client secret, OAuth code, setup code, session id or NR key in logs, audit or responses (T8 scan
  in every authz test); IdP client secrets are Worker secrets via `secret bulk` on stdin.

## Local CI

GitHub Actions has not run since PR #60 (billing). Results on this branch, WSL2 Linux, Node 24, Docker 28:

Final run on the fixed tree (sequential, quiet machine), plus earlier runs:

| Command | Result |
|---|---|
| `pnpm lint` | pass (biome, runtime-import, NRQL, UI-escaping, SPDX, tasks, generated docs/migrations/assets, version sync) |
| `pnpm typecheck` | pass |
| `pnpm test` (run 1) | pass: 118 files, 1,971 passed, 13 skipped (143 s) |
| `pnpm test` (run 2) | pass: 118 files, 1,971 passed, 13 skipped (144 s) |
| `pnpm test:workers` | pass: 17 files, 266 passed, 5 skipped (workerd + D1 simulator) |
| `pnpm test:authz` | pass: 8 files, 153 passed (authorization matrix; also inside `test:workers` on the Worker) |
| `pnpm build` | pass |
| `pnpm bench:cpu` | pass, within baseline (0.83x … 1.23x; `cold.first-request` 1.23x, noisy, unchanged code path) |
| `pnpm test:e2e` (Playwright) | pass: desktop and mobile-320 (2 tests) |
| `pnpm scan:zap` | pass: no unreviewed Medium/High; 118 passive rules PASS; two reviewed informational notes |
| Docker image build + `scripts/docker-smoke.sh` | pass (health, foreign Host refused, backup, CLI setup, 13 MCP tools, uid 65532, read-only rootfs), before and after the fixes |
| actionlint 1.7.12 (Docker) on `.github/workflows/*` | pass, no findings |

**Flakiness.** On the fixed tree, one of four `pnpm test` runs (before the timeout fix) failed one test: the keyring property test
"round-trips arbitrary ids and keys, with a fresh IV every time" (Phase 2) hit Vitest's 5 s default (200 AES-GCM
round trips take 2–10 s under load). An earlier run, with three review sessions running tests in parallel, also timed out
the CLI `--version and --help` e2e and four HTTP-app MCP tests; those passed in every quiet run. The keyring test and
the 1,005-session revoke test (about 5 s, P4-17) now have explicit 30 s timeouts. One sub-review saw the Playwright desktop
run time out once under the same load; it passed on rerun and in the final run. No logic flake was found.

## What Phase 5 (OAuth 2.1 authorization server for MCP clients) must know

1. **Reuse the identity layer, do not fork it.** Consent pages sign users in through the existing session
   (`createSessionManager`), so a Phase 5 authorization request needs a live admin-panel session; redirect targets
   derived from input go through `isLocalPath`/`localHref` after parsing (P4-07 M1).
2. **State lives in `kv` (D1/SQLite), never isolate memory:** authorization codes, PKCE verifiers, client
   registrations and refresh tokens follow the login-transaction pattern (hashed key, TTL, `kv.take` for single use).
   Plan purge cost (P4-09 cron) and per-user caps from the start (P4-17, P4-19 lessons).
3. **Owner boundary (H1) applies to OAuth grants too:** an OAuth access token is a grant; an admin must not mint or
   approve one that acts for an owner, and consent must bind to the signed-in user only.
4. **Rate limits on Workers are per isolate** for anything not in `SHARED_KEY_PREFIXES`; `/oauth/token` and dynamic
   client registration are unauthenticated write paths and need the shared binding or the Durable Object limiter (P7-10).
5. **Real-IdP sign-in has never run.** claude.ai web and mobile depend on it end to end; validate a real Google or
   GitHub app (pending decision P4-01) before building on it.
6. **One-time secrets** (client secrets, if any) use `kit.issueOnce`/`claimOnce` and the `no-store` one-time page.
7. **Authz matrix:** every OAuth route needs matrix rows; the guard test fails on unlisted routes, on Node and workerd.
