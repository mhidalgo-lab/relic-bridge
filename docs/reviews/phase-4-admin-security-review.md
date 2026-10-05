# Phase 4 admin panel security review (P4-07)

- **Scope:** everything Phase 4 added up to the connect page: `git diff phase/4-identity-admin...task/P4-06-connect-page`
  (P4-01 identity providers, P4-02 sessions / CSRF / roles, P4-03 UI scaffold and CSP, P4-04 screens, P4-05 audit
  viewer and usage statistics, P4-06 connect page; 136 files, about 19k lines including the lockfile).
- **Branch:** `task/P4-07-admin-security-review`, stacked on `task/P4-06-connect-page`.
- **Date:** 2026-10-03.
- **Method:** I read the security-relevant source in full. Three parallel adversarial sub-reviews each wrote probe tests
  against the real code:
  - **A, sign-in:** `packages/auth/src/identity`, `packages/http-app/src/identity.ts`.
  - **B, sessions, CSRF, roles and authorization:** `packages/http-app/src/session.ts`, `app.ts`, `admin/api.ts`, and
    the audit statistics in storage.
  - **C, admin UI:** `packages/admin-ui`, the UI mounting, and the CSV export.

  The probes ran against the mock IdP, the P2-12 authorization harness (Node and workerd), and the UI kit with a
  scripted admin API. The probes became permanent tests:
  - `packages/auth/test/p4-review-signin.test.ts`
  - `packages/http-app/test/p4-review-{signin,sessions,ui}.test.ts`
  - `packages/admin-ui/test/p4-review-ui.test.ts`
  - `packages/storage/test/p4-review-stats.test.ts`

  Tests named `fix: …` are the regression tests. Each one failed with its fix reverted (checked file by file). The
  other tests record what holds.
- **Checks (local; GitHub Actions is unavailable, billing):** these all pass: `pnpm lint && pnpm typecheck && pnpm test &&
  pnpm test:workers && pnpm build && pnpm bench:cpu`, plus the Docker image build. The P2-12 matrix is green on Node and
  on the Worker.
- **Not done:** the ZAP baseline scan (CI is unavailable, and the scan needs a running instance and a scanner image;
  moved to task P4-12), and any test against real IdPs or a real browser (P4-01 owner run, P4-11).

## Verdict

**Ready, with the fixes on this branch.** There are no critical or high findings. One medium finding, an open
redirect after sign-in, is fixed. The rest are low or informational.

The design holds under attack. Every redirect goes through one local-path check. CSRF is a synchronizer token plus
`Origin` plus fetch metadata on every change. Sessions are server-side and hash-only, and they rotate at sign-in. Roles
are re-read on every request. Every page has auto-escaping only and a strict CSP. Secrets are never re-rendered.

## Findings

Severity is the impact if exploited, weighed by likelihood. Status is one of:
- **fixed**: fixed on this branch, with a regression test.
- **task**: tracked as a new task file.
- **decision**: logged in `docs/pending-decisions/phase-4.md`.
- **accepted**: a documented residual risk.

| Id | Severity | Location | Impact | Fix / status |
|---|---|---|---|---|
| M1 | medium | `packages/http-app/src/identity.ts:145` (`safeNextPath`), `packages/http-app/src/session.ts` (`login`) | **Open redirect after sign-in.** The input check refused `//host` and `/\host`, but the returned value was the *re-serialised* URL. WHATWG parsing removes dot segments, so `next=/.//evil.example/x` (also `/..//x`, `/%2e//x`, `/a/..//x`) became `//evil.example/x`. After a genuine IdP login the 303 sent the freshly signed-in owner to the attacker's site, which is a convincing phishing step ("session expired, sign in again"). | The result is checked as well as the input (`isLocalPath`: one leading `/`, not followed by `/` or `\`). `sessions.login` re-checks `next` before the `Location` header and falls back to `/admin` (defence in depth). **fixed** |
| L1 | low | `packages/auth/src/identity/jwt.ts:44` (`remoteKeySource`) | **The JWKS body was not size-capped.** jose read it whole, while every other IdP answer goes through the 256 KiB cap. A hostile or broken `jwks_uri` (from configured discovery) could stream 64 MiB into an isolate on a login request. | The `customFetch` wrapper reads through the same `readCapped` (256 KiB) and fails `idp_unavailable`. **fixed** |
| L2 | low | `packages/auth/src/identity/types.ts:72` (`canonicalEmail`), used in `oidc.ts`, `github.ts` and `cf-access.ts` | **Case folding of non-ASCII emails.** Emails were only lowercased, so `Kevin@…` (the Kelvin sign) became `kevin@…`. A user with no IdP binding yet binds by verified email, so an IdP that treats the two addresses as different accounts could claim that ASCII row. | Emails must be printable ASCII, then they are lowercased; other addresses are refused as `email_missing`. Internationalised addresses are not supported (documented). **fixed** |
| L3 | low | `packages/admin-ui/src/screens/audit.tsx:437` (`csvCell`) | **CSV formula injection gaps.** The OWASP prefix list (`= + - @ \t \r`) missed a leading line feed and white space before a sign (`" =1+1"`), which some importers still evaluate. Audit rows carry tool names, error messages and NRQL that come from agents. | A leading `'` is now added for `\n` too, and for white space followed by `= + - @`. **fixed** |
| L4 | low | `packages/auth/src/identity/login.ts:70` (`startLogin`), `packages/http-app/src/rate-limit-hooks.ts:126` | **Unauthenticated storage writes.** Every `GET /auth/login/:provider` stores a login state (10 min TTL). The only bound was the general per-IP limit (600/min), so one IP could keep about 6,000 rows alive, and distributed clients could keep more, all as D1 writes. | A separate per-IP sign-in rule `signIn` (default 60 per 5 min for `/auth/*`) and `RB_RATE_LIMIT_SIGN_IN` on `serve`. On Workers it is counted per isolate (like `fail:`). Expired `kv` rows are purged by P4-09. **fixed** |
| L5 | low | `packages/admin-ui/src/screens/audit.tsx:362` (`GET /admin/audit.csv`), `packages/admin-ui/src/kit.ts` (`pageFetchProblem`) | **Download started by a cross-site link.** Pages accept cross-site top-level navigations (pending decision P4-03), so a link on another site made a signed-in admin's browser save up to 5,000 audit rows to disk. The attacker could not read the file. | The export accepts only `Sec-Fetch-Site` values `same-origin` and `none` (or no header). A cross-site navigation is sent to `/admin/audit` with the same filters. **fixed** |
| L6 | low | `packages/http-app/src/session.ts:168` (`authenticate`), `packages/http-app/src/admin/api.ts:1288` | **Sessions survived a disable made outside the API.** The API ends sessions when it disables a user. A disable made directly in the database left the session rows in place: they failed while the user was disabled, then worked again after re-enabling, for up to 12 h. A stolen cookie from before the disable came back to life. | A session refused because its user is disabled is deleted. Re-enabling a user through the API also ends their sessions (audited as reason `enabled`). The matrix records the second reason (`reasonAfterFirst: session_unknown`). **fixed** |
| L7 | low (latent) | `packages/storage/src/audit-stats.ts:24` | **Inherited keys in the group-by lookup.** `GROUP_EXPR[query.groupBy]` was a plain object lookup, so `constructor` or `__proto__` put inherited text into the SQL statement (it then failed as SQL). The API enum blocks this today, but any new caller of `auditLog.stats` could reach it. | Only own keys are looked up (`Object.hasOwn`). **fixed** |
| L8 | low | `packages/admin-ui/src/screens/tokens.tsx:353`, `kit.ts` (`issueOnce` / `claimOnce`) | **Reloading the one-time token page created a second token** (known since P4-04). The reload re-sent the form with a still-valid CSRF token. The extra token stayed valid but was never noted, and the same happened from the back button and from the Connect page form. | Each token form carries a single-use handle (128-bit, stored in `kv` for 2 h under the user's id). The POST takes the handle atomically before calling the API. A re-sent, expired, forged or other user's handle issues nothing and goes back to the token list with a notice. The token itself is still never stored or redirected. **fixed** |
| I1 | info | `packages/http-app/src/identity.ts:253` | A setup link is used up before the user decision, so a sign-in refused afterwards (disabled user, `identity_conflict`) burns it. This fails closed, and the owner issues a new link. | **accepted** (test records it) |
| I2 | info | `packages/http-app/src/admin/api.ts` (`PATCH /users/{id}`) | Admins may promote members to admin and may demote or disable other admins (only owners touch owners). Whether this is intended is the owner's call. | **decision** |
| I3 | info | `GET /audit?order=slowest`, `GET /audit/stats` | The slowest-first order and a 90-day statistics window read every row in the window (no index on `duration_ms`). Both are admin-only for statistics and bounded to 90 days and 100 groups. | **accepted** (pending decision P4-05 already covers it) |
| I4 | info | `scripts/check-ui-escaping.ts` | The escaping lint is regex-based: it does not see spread props or a re-exported `html` helper. Escaping is still enforced by the tests, by `localHref` on every `href`/`action`, and by Trusted Types in the CSP. | **accepted**; the real-browser run in P4-11 adds CSP violation checks |
| I5 | info | `packages/admin-ui/src/flash.ts` | The flash cookie is an unsigned code. A cookie injection (for example from a sibling subdomain) can only show one of the fixed catalogue messages. | **accepted** |
| I6 | info | `GET /admin/audit.csv` | One export makes up to 25 in-process admin API calls (5,000 rows). It is bounded and charged to the per-IP limit through the in-process calls. | **accepted** |
| I7 | info | ZAP baseline | The ZAP baseline scan from the original task scope was not run, because CI is unavailable. | **task P4-12** |

## Probed and holding

**Sign-in (A)**
- State is single use under 10 parallel callbacks, and is bound to the browser by the `__Host-rb_login` cookie
  (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`, cleared on callback).
- The state of provider A presented at provider B's callback is refused, and the state is burnt. Replay, expiry after
  10 min, and an `error=` callback all consume the state. A malformed state never reaches the token endpoint.
- **RFC 9207 mix-up:** a foreign `iss` is refused, and so is a missing `iss` when the IdP advertises it. A discovery
  `issuer` mismatch (even a trailing slash) is refused.
- Plain-http endpoints in discovery are refused, and discovery and JWKS redirects are not followed. The JWKS fetch has
  a timeout. 15 tokens with unknown `kid`s caused at most 2 JWKS fetches (cooldown).
- **ID token checks:** a missing nonce is refused, as are an `aud` array without `azp`, a wrong `azp` or `aud`, `nbf` in
  the future, a stale or missing `iat`, a past or missing `exp`, and an empty `sub`.
- **Algorithm and key confusion:** `none`, `HS256`, an unknown or traversal `kid`, the same `kid` with a foreign key,
  embedded `jwk` / `jku` / `x5u` headers, and a missing `kid` are all refused.
- An unverified email (`false`, `"false"`, `"1"`, `1`, absent) is refused, and so is a userinfo `sub` mismatch.
- **GitHub:** only the verified primary email counts, and a pending org invitation is not membership.
- **Cloudflare Access:** service tokens, a wrong `aud` or `iss`, a `none` header and a cookie-only assertion are
  refused. The team name is regex-checked, so the JWKS host cannot be injected.
- `redirect_uri` is built from `RB_PUBLIC_URL` only: `Host`, `X-Forwarded-Host`, `Forwarded` and
  `X-Forwarded-Proto` have no effect.
- `next=` with `//host`, `/\host`, absolute and `javascript:` URLs, CRLF (raw and encoded), tab or space, non-ASCII,
  `%2F%2F` or `%5C` is refused or stays on our origin. The dot-segment forms are the M1 fix.
- **Setup links:** 6 concurrent completions produced exactly one owner, and a malformed code is refused before any
  storage read.
- No code, state, binding cookie or JWT appears in logs, audit rows or pages. The sign-in pages are `no-store` with
  `no-referrer`.

**Sessions, CSRF and roles (B)**
- **Cookie:** on https it is `__Host-rb_session` (`Secure`, `HttpOnly`, `Lax`, `Path=/`). Storage holds only the
  SHA-256 hash of the 32-byte secret.
- **Fixation and tossing:** sign-in revokes any planted or previous cookie. A session cookie sent twice is treated as
  malformed. The session is never read from the query, another cookie name, or the admin token.
- **Timeouts:** idle and absolute timeouts are enforced, and activity never extends the absolute lifetime. Logout,
  a role change and a disable end the sessions everywhere.
- **CSRF on every session write:** the token is required as a header (not in the query, the body or a cookie), together
  with `Origin` = public origin and same-origin fetch metadata. These are refused: an `Origin` of `null`, in upper case,
  with a trailing slash, userinfo, another port or another scheme.
- **Method and content-type tricks:** method-override headers and `?_method` do nothing, HEAD and OPTIONS never
  mutate, and a cross-site `text/plain` JSON post gets 403 with nothing created.
- **Bearer and cookie:** a bad `Authorization` header never falls back to a valid cookie.
- **Role escalation:**
  - An admin cannot create or promote an owner, touch an owner, create setup links or rotate keys.
  - Nobody changes their own role or disables themselves through a session.
  - Mass-assignment fields (`id`, `email`, `idp`, `disabledAt`, `__proto__`, an upper-case role, an array role) are
    400.
- **Members:** a member gets 403 on every admin route, including path-normalisation variants. A member never sees
  another user's audit rows, whatever they do with `userId` (override, duplicates, arrays, case, encodings), with
  `order`, or with the CSV export.
- **Audit and statistics bounds:** a window over 90 days, a limit over 100, a bad `groupBy`, and injection-shaped
  filters and cursors are 400, never 500, and no error carries SQL or a stack trace.
- **kv:** prefix listing compares exact prefixes (no `LIKE` wildcards).

**Admin UI (C)**
- **Stored XSS:** payloads in every audit field, label, name, email, provider name, slug, key hint and in the viewer's
  own name render as text on 18 screens. There is no `raw()` or `dangerouslySetInnerHTML`, and every `href` and
  `action` goes through `localHref`.
- **Reflected XSS:** filters are allow-listed, flash messages are catalogue codes, and error pages show fixed text plus
  the request id.
- **CSP:**
  - `default-src 'none'`
  - no `unsafe-inline`
  - `form-action 'self'`
  - `frame-ancestors 'none'`
  - `base-uri 'none'`
  - Trusted Types

  It is present on pages, 403, 404, 500, the CSV, sign-in pages and redirects, together with `X-Frame-Options: DENY`,
  `no-store`, `no-referrer` and `nosniff`.
- **Asset route:** only the assets themselves are cacheable. Traversal, NUL and `?callback=` variants are 404.
- **Secrets in pages:** a New Relic key is a `type=password`, `autocomplete=off` field and is never re-rendered. A
  device token appears only in `<code>` on the `no-store` one-time page, and Connect snippets never contain one.
- **CSV:** every cell is quoted, and quotes, CR and LF cannot split rows or columns (an RFC 4180 parse finds exactly
  3 × 20 cells). The filename is generated by the server.
- **Host header:** snippets and endpoints use `RB_PUBLIC_URL` only, and an unknown `Host` is 403.
- **Methods and redirects:** no GET route mutates. A UI change cannot call the admin API without the verified form of
  the same request. Hostile ids never produce an off-site or header-splitting `Location`.
- **Leak scan:** no secret appeared in any response, log line or audit row after the probes.

## ZAP baseline (P4-12)

The passive scan that P4-07 deferred ran locally with `pnpm scan:zap` (OWASP ZAP stable, pinned by digest, Docker) against
a throwaway server on localhost: `/auth/login` signed out, `/admin` as the owner (session cookie, spidered through the
panel), and `/api/admin/v1` through its OpenAPI document with the admin token (passive, safe mode).

- **Medium / High:** none.
- **Low, fixed:** `Permissions-Policy` missing on the script asset (rule 10063) and `Cross-Origin-Embedder-Policy` missing
  on HTML pages (90004). Both headers are now set (`packages/http-app/src/security.ts`, `packages/admin-ui/src/headers.ts`)
  with regression tests in `packages/http-app/test/authz/ui.test.ts`.
- **Informational, accepted** (`.zap/rules.tsv`, each with a reason): 10049 cache notes, 10112 session cookie noted, 10027
  the word "admin" in our script's first comment, 10024 filter parameter names `user`/`token` (they carry ids, never
  secrets), 10031 filter values echoed into escaped attributes, 100000 expected 4xx from generated API requests.
- **Limits:** passive only (no active scan, by scope); the scan is manual, so rerun it after changing headers, cookies or
  sign-in. Reports are kept out of git and checked not to contain the cookie, admin token or test key.

## What the next tasks must know

1. **Every new redirect target derived from input goes through `isLocalPath` / `localHref` *after* URL parsing**,
   never only before it. This applies to OAuth for MCP clients in Phase 5, consent pages and return URLs.
2. **A form whose effect must not repeat on a re-send uses `kit.issueOnce` / `kit.claimOnce`.** One-time secrets
   (Phase 5 client secrets, setup links in the UI) belong there.
3. **Any new download or side-effect-free GET that writes to the user's disk** refuses cross-site fetch metadata
   like the audit export.
4. P4-09's `kv` purge now also covers expired `ui-once:` handles.
5. P4-10 (member self-service) must keep the member rules probed here: forced `userId`, no lookups, own sessions
   only.
