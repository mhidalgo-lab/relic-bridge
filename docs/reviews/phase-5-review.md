# Phase 5 consolidation review

- **Scope:** all of Phase 5 (OAuth 2.1 authorization server for MCP clients):
  `git diff task/P4-20-test-docs-ui-hygiene...task/P5-07-oauth-connect-docs` (P5-01 … P5-09, 32 commits, 126 files,
  about 13k lines).
- **Branch:** `review/phase-5`, stacked on `task/P5-07-oauth-connect-docs` (top of the Phase 5 PR stack).
- **Date:** 2026-10-05.
- **Method:**
  - Read the task files, ADR-0011 … 0013, `docs/dev/oauth.md`, the client compatibility matrix, the THREAT_MODEL rows
    and the pending decisions first.
  - Three parallel sub-reviews, cross-checked: (1) protocol core (authorize, token, PKCE, codes, resource binding,
    refresh rotation and the ADR-0013 reuse interval, revocation, storage), (2) clients and consent (CIMD SSRF, DCR,
    consent CSRF/clickjacking/CSP, remembered approvals, owner boundary, admin OAuth APIs, discovery oracles), (3)
    completeness against every acceptance criterion, docs against code, hard rules, Worker wiring.
  - Adversarial probe tests (vitest, in-process HTTP app with memory storage) for each claimed issue. Probes that only
    confirmed that something holds were deleted; fixed findings keep a regression test that fails with the fix
    reverted (checked).
  - Nothing was deployed, published or tagged, and no real external service was contacted (CIMD fetches are mocked).
    GitHub Actions is unavailable (billing), so every check was run locally (see [Local CI](#local-ci)).

## Verdict

**Ready to merge as a stack, with the fixes on this branch.** No critical findings. One high finding is fixed: with a
remembered approval, any web page could disconnect a user's live app with one cross-site navigation (no click, no
audit row). Two medium findings and the low ones are tracked in P5-10 … P5-12 or fixed when trivial.

The protocol core holds under attack. PKCE is S256-only for every client and checked at authorize; codes are single
use through an atomic `kv.take` (SQLite and D1 `DELETE … RETURNING`) before the provider sees them, bound to client,
resource and PKCE, and a replay revokes the grant; redirect URIs match exactly (loopback port flexibility only;
userinfo, `127.0.0.1.evil`, `localhost` vs `127.0.0.1`, trailing slash, query and fragment variants refused); every
authorization response carries `iss` from configuration, never `Host`; the resource is exactly one
`{issuer}/p/{slug}/mcp` on authorize, code and refresh, cross-checked against the token's props on every request, and
OAuth tokens are not admin credentials. Refresh rotation is elected by the same atomic marker; the ADR-0013 replay is
sealed under a key derived from the presented token (a database copy can't open it) and refuses other clients,
resources, scopes, older generations and revoked devices. CIMD is resolved by our own fetcher: canonical https names
only, connect-time public-address check on Node (no rebinding window), no redirects, 5 s / 5 KiB / JSON only; about 45
private-address encodings were tried without a bypass. Consent needs session + CSRF + `Origin` + fetch metadata, the
request is re-validated on post, the page is `frame-ancestors 'none'` + `X-Frame-Options: DENY`, and errors before the
redirect URI is validated are JSON pages, never redirects. PRM, the `401` challenge and the authorize page answer the
same for unknown, disabled and forbidden projects (no oracle). No secret reached logs or audit in any suite.

**The roadmap promise** ("claude.ai web and Claude mobile connect; per-device OAuth sessions") is met in code and in
tests against the official MCP SDK client in every client shape (memory, SQLite, Worker + D1). Not met yet, owner
action: a real connection from claude.ai, Claude mobile, Desktop, Cursor, VS Code (P5-06 manual checklist), the
"connect phone and 3 computers from the docs alone" check and v0.5.0 (P5-07). Per-device sessions were broken by H1
for an attacker-triggered case and still are by design for installations that share a client id and callback (M2,
decision logged).

## Per-task completeness

| Task | Result | Notes |
|---|---|---|
| P5-01 OAuth server | Met | Provider state in storage `kv` (ADR-0011); `OAUTH_KV` binding unused and still declared (decision logged). |
| P5-02 PRM and audience | Met | `resource` required on refresh too (decision logged). |
| P5-03 CIMD and DCR | Met | Global DCR cap can be exhausted by one IP (M1, P5-10); CIMD rows uncapped (L4, P5-10). |
| P5-04 consent screen | Met, H1 fixed | Remembered approvals plus the provider's revoke-at-issuance made a zero-click disconnect (H1). `prompt=none` shows the page (L7, P5-12). |
| P5-05 token lifecycle | Mostly met | Revoke-all reads at most 100 devices and issuance has no cap (M2, P5-11). |
| P5-06 compatibility matrix | Mostly met | Real Claude web/mobile/Desktop, Cursor, VS Code, Inspector unticked: owner action, logged. |
| P5-07 docs | Mostly met | Owner-run validation and v0.5.0 unticked, logged. `ARCHITECTURE.md` still said OAuth used Workers KV: fixed (L10). |
| P5-08 admin OAuth clients | Mostly met | List truncated before sorting (L3, P5-10); removal not resumable (L6, P5-11). |
| P5-09 refresh concurrency | Met | ADR-0013 awaits owner confirmation. Worker env typing lacked the three TTL/window variables: fixed (L10). |

## Findings

Severity: impact if exploited or hit × likelihood. Status: **fixed** (here, with tests), **task** (new task file),
**decision** (`docs/pending-decisions/phase-5.md`), **accepted** (documented residual).

### High

**H1. Any web page could disconnect a user's connected app (zero click).**
`packages/http-app/src/oauth/server.ts` (`approve()`, the `helpers.completeAuthorization` call, now line 1628), reached
through the remembered-approval branch of `packages/http-app/src/oauth/consent.ts`. The OAuth provider's
`completeAuthorization` defaults to `revokeExistingGrants: true`: when a code is **issued** it revokes every other grant
of the same user, client and resource (for CIMD clients, same redirect URI). With a remembered approval ("don't ask
again"), a top-level `GET /oauth/authorize` with the public `client_id`, redirect URI and project slug issues a code at
once. Probe: user connects with "remember", an attacker page navigates the browser to the authorize URL → `303` with a
code to the client's redirect URI (the attacker never sees it), and the user's live access token then answered `401`
and its refresh token `400 invalid_grant`. Repeatable, no audit row (the provider revokes on its own), and no tombstone,
so a refresh in flight could also write the old grant back.
*Impact:* any site the user visits can keep their phone or claude.ai connection disconnected; defeats Phase 5's goal.
*Fix:* `approve()` passes `revokeExistingGrants: false`; after a **successful code exchange** `replaceEarlierDevices`
(line 779) revokes the user's earlier grants of the same client and resource (plus redirect URI for CIMD clients, the
provider's rule) through `revokeFamily` (tombstone first) and audits `oauth.device.replace`. Only the holder of the
code and its PKCE verifier can now end a connection. Regression test "review H1: a silent re-authorization disconnects
nothing; redeeming its code replaces the earlier device" in `packages/http-app/test/authz/consent-suite.ts` (memory,
SQLite via `apps/cli`, D1 via `pnpm test:workers`); fails without the fix (`expected 401 to be 200`). Docs:
`docs/dev/oauth.md` §Devices, `docs/guide/oauth.md`, THREAT_MODEL. **fixed**

### Medium

**M1. One source can lock everyone out of dynamic registration.** `server.ts` `register()` (lines 1355-1380): the cap
is one deployment-wide fixed window (`RB_OAUTH_DCR_LIMIT`, 30 per hour) behind a per-IP rule of 60 per 5 minutes.
Probe: 30 anonymous registrations → `201`; the next legitimate one → `429` until the window ends. CIMD clients are
unaffected. **task P5-10**

**M2. Per-device sessions are not complete.** (a) Installations that share a client id and callback (two Claude
accounts of one person on one project; a CIMD client with a fixed https callback on two machines) are one device:
connecting the second ends the first (the provider's rule, now applied at redemption). (b) Devices per user are not
capped at issuance, while listing and revoke-all read at most `MAX_OAUTH_DEVICES_PER_USER` (100, `server.ts` line 251,
`revokeAll` line 1168): "disconnect all" misses devices beyond 100 while the user and grant stay usable. **task P5-11,
decision**

### Low

- **L1** The token endpoint accepted any `code_verifier` (a client that hashed `"a"` got a code redeemed with `"a"`).
  Now refused unless 43-128 unreserved characters (RFC 7636 §4.1), before the code is consumed (line 1436). Regression
  test "review: a code_verifier outside RFC 7636 …" in `packages/http-app/test/authz/oauth-suite.ts`. **fixed**
- **L2** `redirect_uri` is optional on the code exchange when PKCE is used (provider leniency; OAuth 2.1 allows it).
  **decision, task P5-12**
- **L3** The owner's client list stops at 500 records in key order and then sorts newest first (line 1240): a
  registration flood can hide a real client. **task P5-10**
- **L4** Each distinct CIMD URL on unauthenticated `/oauth/authorize` or `/oauth/token` is fetched and stored
  (`resolveClient`, line 701) with no global cap; failures are not cached (about 12 outbound requests per minute per
  IP to public hosts). **task P5-10**
- **L5** The `oauth` rate rule is per isolate on Workers (`oauth:` not in `SHARED_KEY_PREFIXES`,
  `apps/worker/src/rate-limit.ts` line 20); documented in `docs/dev/oauth.md`, still weaker than the guide implies.
  **task P5-10**
- **L6** `clients.remove` (line 1259) deletes the record, then scans every grant sequentially and throws past 20,000;
  a partial run on D1 leaves devices of a removed client and a retry finds no record. **task P5-11**
- **L7** `prompt=none` shows the consent page instead of `consent_required`. **task P5-12**
- **L8** An `http://[::1]` redirect widens the consent page's CSP to `form-action 'self' http:`
  (`packages/admin-ui/src/headers.ts` line 28); not exploitable without an HTML injection (none found; the escaping
  lint holds). **task P5-12**
- **L9** Mixed-script client names (Cyrillic look-alikes) pass `safeClientName`; the consent page still shows the
  vouching host or "not verified". **task P5-12**
- **L10** Docs and typing drift: `apps/worker/src/env.ts` lacked `RB_OAUTH_ACCESS_TTL`, `RB_OAUTH_REFRESH_TTL`,
  `RB_OAUTH_REFRESH_REUSE_WINDOW` (read through a cast, so it worked); `docs/ARCHITECTURE.md` said Cloudflare keeps OAuth
  in KV (ADR-0011: D1); THREAT_MODEL had no explicit mix-up (RFC 9207) entry. **fixed**
- **L11** Flaky test from Phase 3: `admin-token.test.ts` "accepts and does not warn about generated tokens" bounds
  warnings at 10 per 1,000 samples, but `base64url(24)` warns about 4.4 per 1,000 (measured over 200,000), so it failed
  about once in 170 runs (it failed in the first run of this review). Bound raised to 20 (about once in ten million).
  **fixed**

### Informational (accepted)

- A holder of a stolen code (or refresh token) can burn it with a wrong client or verifier, which revokes the grant on
  the legitimate redemption. Requires the secret; ordering is deliberate (single use before anything else).
- ADR-0013 residual: for 30 s after each rotation the previous refresh token plus the public `client_id` yields the
  same pair the client got. Confirmed as documented; owner confirmation of ADR-0013 pending.
- An admin can list (not revoke) an owner's OAuth devices.

## What was verified to hold

- **PKCE:** S256 required at authorize for every client; `plain`/missing refused with an error redirect carrying
  `state` and `iss`; grants always carry a challenge, so an omitted or wrong verifier is refused.
- **Codes:** single use (atomic `kv.take`), 600 s, bound to client, resource and (when sent) redirect URI; replay
  revokes; a forged secret for a known grant revokes nothing.
- **Audience:** one resource on every request; case-folding on scheme and host only; trailing slash, query, extra path,
  encoded slash refused; token audience and props cross-checked per request; OAuth tokens refused on the admin API.
- **Refresh:** rotation elected atomically; replay sealed (AES-256-GCM, HKDF from the presented token, AAD user + grant
  + hash); other client / auth / resource / scope / older generation / revoked device → family revoked and audited;
  forged tokens do not wait.
- **Revocation (RFC 7009):** client authenticated per type; only the caller's own tokens; empty `200` otherwise.
- **Storage:** codes and tokens hashed; props hold only `grantId`, `projectSlug`, `userId`, `clientId` (encrypted);
  metadata only the device label and access grant id (T25); no NR key in OAuth state.
- **Owner boundary:** `resolveAccess` at approval, every issuance and every MCP request (disabled user, revoked grant,
  owner-key move, project deletion, slug reuse all deny).
- **CIMD:** id checks (IP literals, decimal/hex/fullwidth hosts, percent-encoding, ports, userinfo, trailing dot,
  uppercase, dot segments, internal TLDs, own host); `isPublicIp` (mapped, NAT64, 6to4, Teredo, ULA, link-local,
  100.64/10, zone ids); Workers uses `global_fetch_strictly_public` or falls back to DCR only.
- **DCR:** `javascript:`, `data:` and custom-scheme redirects refused; no `software_statement` / `jwks_uri` fetch.
- **Consent:** CSRF, `Origin`, fetch metadata, re-validation of a tampered form, clickjacking headers, own grants only,
  owner boundary, no open redirect (`next` is a local path).
- **Admin OAuth routes:** owner-only client management and registration switch (fail closed, 5 s cache); every route in
  the authz matrix on Node and workerd.
- **Hard rules:** no `node:*` in `core`, `auth`, `http-app`; no module-level request state in `oauth/*` (the server map
  is per app instance); logs through the injected redacting logger.

## Local CI

GitHub Actions is unavailable (billing). Results on this branch, WSL2 Linux, Node 24, Docker 29.8:

Final run on the fixed tree (sequential), plus the baseline run on the unchanged stack tip:

| Command | Result |
|---|---|
| `pnpm lint` | pass (biome, runtime imports, NRQL, UI escaping, SPDX, tasks, generated docs/migrations/assets, version sync) |
| `pnpm typecheck` | pass |
| `pnpm test` (run 1) | pass: 157 files, 2,728 passed, 14 skipped (240 s) |
| `pnpm test` (run 2) | pass: 157 files, 2,728 passed, 14 skipped (241 s) |
| `pnpm test:workers` | pass: 31 files, 493 passed, 6 skipped (workerd + D1 simulator) |
| `pnpm test:authz` | pass: 20 files, 368 passed (authorization matrix and OAuth suites) |
| `pnpm build` | pass |
| `pnpm bench:cpu` | pass, within baseline (0.59x … 1.17x; `cold.first-request` 0.86x) |
| `pnpm test:e2e` (Playwright) | pass: admin and OAuth flows, desktop and mobile-320 (4 tests) |
| Docker image build + `scripts/docker-smoke.sh` | pass (health, foreign Host refused, backup, CLI setup, 13 MCP tools, uid 65532, read-only rootfs) |
| `pnpm scan:zap` | pass: no unreviewed Medium/High; 118 passive rules PASS; two reviewed informational notes |
| actionlint 1.7.12 (Docker) on `.github/workflows/*` | pass, no findings |

**Flakiness.** The baseline `pnpm test` on the unchanged stack tip failed one test: `admin-token.test.ts` "accepts and
does not warn about generated tokens" (`expected 11 to be less than or equal to 10`), a statistical bound that fails
about once in 170 runs (L11, fixed). Lint, typecheck and `test:workers` passed on the baseline too. No other flake was
seen in the two full runs on the fixed tree.

## What Phase 6 (tool parity) must know

1. **An OAuth token is a grant.** It resolves to the same access grant and per-request `ToolContext` as a device token
   (`props.grantId`), with `resolveAccess` on every request. New tools need nothing OAuth-specific, but each tool and
   route still needs negative authorization tests (P2-12 suite) and the matrix rows.
2. **Scope is `mcp:read` only.** OAuth tokens cannot carry write intent. Any Phase 6 tool with side effects (muting
   alerts, acknowledging issues, deployment markers) needs `mcp:write` first: a new scope in PRM, AS metadata and the
   consent page, an ADR and THREAT_MODEL rows. Keep Phase 6 tools read-only with correct annotations.
3. **Audit rows of OAuth requests** carry `tokenId = oauth_<grant>`; per-device rate limits apply. Expensive tools
   (logs, NRQL-heavy APM views) are reachable from phones: keep the existing deadline and result-size limits.
4. **Revocation lag:** up to the access cache TTL (≤ 60 s) on other isolates; do not cache tool results across grants.
5. **Open Phase 5 work** (P5-10 … P5-12) does not block Phase 6; the owner's real-client checklist (P5-06) does gate
   the v0.5.0 release.
