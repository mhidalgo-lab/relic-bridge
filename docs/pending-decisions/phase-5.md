# Phase 5 — pending decisions

Decisions that agents could not make alone during the autonomous run (2026-10-03). Each entry says what was
assumed so work could continue. Review, then answer in place or move the outcome into an ADR / task file.

Format: `### <task id> — <short title>` then **Context**, **Assumption made**, **Options**, **Needs**.

## Workflow

### ALL — stacked PRs instead of merging to `main`
- **Context:** The owner was away. Every task PR targets the previous task's branch (the first one targets
  `phase/5-oauth` (itself stacked on the tip of Phase 4, `task/P4-20-test-docs-ui-hygiene`)), so nothing is merged into `main`.
- **Assumption made:** A dependency counts as satisfied when its task is `review` and its branch is lower in the
  stack. Tasks stay `review`, not `done`, until their PRs are merged.
- **Options:** merge the stack bottom-up (retarget each PR to `main` after its parent merges), or squash-merge the
  tip into `main` in one go.
- **Needs:** owner's merge strategy; then mark merged tasks `done` and run `pnpm tasks index`.

## P5-01 — OAuth authorization server

### P5-01 — provider state in D1 (storage `kv`) instead of Workers KV
- **Context:** ADR-0009 put the provider's state in Workers KV on Workers. Workers KV is eventually consistent with no
  atomic take, so a code could be redeemed twice; Free allows 1,000 KV writes/day.
- **Assumption made:** ADR-0011 — the provider's `OAUTH_KV` is an adapter over the storage `kv` table on both runtimes
  (D1 on Workers), plus a single-use code marker consumed with `kv.take`.
- **Options:** keep ADR-0011; or go back to Workers KV for tokens (cheaper reads at scale) and keep only code markers in D1.
- **Needs:** owner confirmation of ADR-0011.

### P5-01 — the `OAUTH_KV` binding is now unused
- **Context:** `apps/worker/wrangler.jsonc` still declares `kv_namespaces: OAUTH_KV`; Wrangler provisions it on deploy.
- **Assumption made:** left declared (marked reserved) so existing deployments' local configs don't drift.
- **Options:** remove the binding (and the namespace in deployed accounts) in P5-07; or keep it for a future cache.
- **Needs:** owner decision.

### P5-01 — no way to turn OAuth on in a deployment yet
- **Context:** P5-01 ships the server and a consent seam, not the sign-in/consent screen.
- **Assumption made:** OAuth is a programmatic option only (`createHttpApp({ oauth })`, `createWorker({ oauth })`); the
  `RB_OAUTH` switch arrives with the consent screen (P5-04). An auto-approving consent would let any registered client
  obtain codes for a signed-in browser.
- **Needs:** nothing unless the owner wants an earlier switch.

### P5-01 — rate limits of the unauthenticated OAuth endpoints on Workers
- **Context:** the Rate Limiting binding has one fixed 600/min rule (P3-04/P4-20).
- **Assumption made:** a per-IP `oauth` rule (60 per 5 min) in the isolate bucket plus the shared binding under `ip:`;
  a registration cap shared across isolates (D1-backed counter) is left to P5-03.
- **Options:** D1 counter for DCR only (P5-03); a second Rate Limiting binding with a stricter rule for `/oauth/*`.
- **Needs:** owner choice for P5-03.

### P5-01 — strict single use of authorization codes
- **Context:** the marker is consumed before the provider checks PKCE; a client whose exchange fails on the network
  (or sends a wrong verifier) must authorize again, and a replay revokes the grant.
- **Assumption made:** strict (OAuth 2.1 §4.1.3 behaviour); real clients exchange once.
- **Needs:** revisit only if P5-06 finds a client that retries code exchanges.

### P5-01 — scope name `mcp:read`
- **Context:** grants, not scopes, decide what a token may do; the provider needs at least one scope.
- **Assumption made:** every token carries `mcp:read` (plus `offline_access` when asked), as in the spike. Write tools
  (Phase 7) may add `mcp:write` with step-up.
- **Needs:** owner confirmation before clients cache the scope (P5-02 publishes it in PRM).

## P5-02 — Protected Resource Metadata and audience binding

### P5-02 — `resource` required on refresh requests too
- **Context:** MCP 2026-07-28 says clients MUST send `resource` in token requests; the provider would accept a refresh
  without it (falls back to the grant's resource). Some clients may omit it on refresh only.
- **Assumption made:** required on code **and** refresh grants (`invalid_target` otherwise). A client that omits it on
  refresh must re-authorize when its access token expires.
- **Options:** keep strict; or accept a missing `resource` on refresh only (the provider still pins the grant's
  resource, so it can't retarget — the risk is compatibility, not audience).
- **Needs:** revisit if P5-06 finds a client (claude.ai, mobile, Desktop) that refreshes without `resource`.

### P5-02 — discovery details clients may care about
- **Context:** PRM and the `401` challenge are built from the path only (known/unknown slugs indistinguishable, T19).
- **Assumption made:** no root `/.well-known/oauth-protected-resource`, no OIDC discovery document, `scope="mcp:read"`
  in every challenge, no `resource_name`, no CORS on `/.well-known/*` (same as `/oauth/*` in P5-01).
- **Options:** add any of these if a real client needs it (P5-06 compatibility matrix).
- **Needs:** nothing unless P5-06 finds a gap.

## P5-03 — Client registration: CIMD and DCR

### P5-03 — CIMD resolved by relic-bridge instead of the provider (ADR-0012)
- **Context:** the provider's CIMD needs the Workers flag, uses the global `fetch` (no guard on Node) and follows
  redirects; ADR-0009 wanted CIMD on both runtimes with a connect-time guard on Node.
- **Assumption made:** ADR-0012 — our own resolver and policy, per-runtime fetcher (`node:https` + guarded `lookup` on
  Node, `global_fetch_strictly_public` + `redirect: 'manual'` on Workers), documents cached as provider client records.
- **Needs:** owner confirmation of ADR-0012.

### P5-03 — CIMD redirect URIs only on the client id's own host
- **Context:** the draft lets the AS restrict `redirect_uris` relative to the `client_id`. Claude (claude.ai,
  `https://claude.ai/api/mcp/auth_callback`) and Claude Code (loopback) fit.
- **Assumption made:** https redirect URIs on another host than the document's are dropped; loopback http always kept.
  This makes the client host shown on the consent screen the host that receives the code.
- **Options:** keep; relax to the same registrable domain; allow any https host (show both hosts on consent).
- **Needs:** revisit if P5-06 finds a client whose callback is on another host than its metadata document.

### P5-03 — CIMD details: port 443 only, JSON media type required, 5 min floor on the cache
- **Context:** the draft allows ports and other content types (`application/<x>+json`), and says to respect
  `no-store`.
- **Assumption made:** client ids with an explicit port are refused (defence in depth against port probing);
  `application/json` or `application/*+json` only; documents are cached at least 5 minutes (even with `no-store`) so a
  record survives one authorization; at most 24 h.
- **Needs:** revisit if a real client's document is refused for one of these (P5-06 logs the reason).

### P5-03 — DCR stays open to any redirect host by default, capped at 30 registrations per hour per deployment
- **Context:** DCR is anonymous by nature. An allow-list of redirect hosts (`registrationRedirectHosts`, e.g.
  `claude.ai`) exists but would break other DCR clients (Cursor, VS Code, Inspector) unless listed.
- **Assumption made:** no allow-list by default; one deployment-wide cap (30/hour, shared storage counter:
  `kv.increment` on the existing `kv` table, one D1 write per registration); unused registrations expire after 24 h.
  An attacker can exhaust the cap and delay new DCR clients for up to an hour (CIMD clients and existing registrations
  are unaffected).
- **Options:** default allow-list `claude.ai` + loopback; a lower/higher cap; DCR off by default once P5-06 shows every
  client the owner uses supports CIMD.
- **Needs:** owner choice when the `RB_OAUTH` switch lands (P5-04 exposes `registration`, `registrationLimit`,
  `registrationRedirectHosts` as settings).

### P5-03 — no global cap on CIMD fetches
- **Context:** every authorize/token request with a new https `client_id` triggers one outbound fetch (cache misses
  only), bounded by the per-IP `oauth` rule (60 per 5 min, per isolate on Workers) — a low-rate reflector to public
  https URLs.
- **Assumption made:** no deployment-wide fetch cap (it would let one caller block CIMD for new clients).
- **Options:** a `kv.increment` cap on fetch misses (e.g. 120/hour); a second Rate Limiting binding for `/oauth/*`.
- **Needs:** owner decision.

### P5-03 — admin client list, revoke and runtime DCR switch split to P5-08
- **Context:** P5-03's scope listed "client list in admin with revoke"; it needs admin API routes, a UI screen, OpenAPI
  and negative authz tests.
- **Assumption made:** new task P5-08 (depends on P5-03). Until then DCR is turned off by configuration only.
- **Needs:** owner to order P5-08 relative to P5-04/P5-05.

## P5-04 — Login and consent screen

### P5-04 — provider consent helpers not used
- **Context:** the task said to build on `beginConsent` / `approveConsent` / `isConsentRemembered`. They need `__Host-`
  cookies (no `http://localhost` instance), write a KV transaction per unauthenticated authorize request, and the
  remembered-consent cookie can't carry the chosen grant nor be revoked server-side.
- **Assumption made:** stateless consent (the request is re-validated from the URL on every step, CSRF from the admin
  session) and remembered approvals in our own `kv` rows (`oauth-consent:<user>:<hash>`). Documented in RESEARCH §20.
- **Options:** keep; or adopt the provider's transaction for the page step only.
- **Needs:** owner confirmation.

### P5-04 — remembered approvals: opt-in, 30 days, per client + redirect URI + resource
- **Context:** the scope asked to "remember approval per client". Remembering answers a later authorize navigation
  without a click (the code still goes only to that client's registered redirect URI).
- **Assumption made:** a checkbox, off by default; 30 days; ≤ 50 per user; forgotten on `/oauth/approvals`, on Deny, or
  when the grant stops resolving. Not linked from the admin navigation yet (the consent page links it).
- **Options:** default on; another lifetime; a nav entry / merge into the P5-05 device list.
- **Needs:** owner preference; P5-05 should delete a device's remembered approval when the device is revoked.

### P5-04 — sign-in `next` cap raised to 2048 characters
- **Context:** an authorize URL (CIMD client id, redirect URI, state, PKCE challenge, resource) can exceed the old
  512-character cap, and the consent flow returns to it after sign-in.
- **Assumption made:** `safeNextPath` accepts up to 2048 (same-origin checks unchanged); longer authorize URLs get a
  `400` page instead of a sign-in redirect.
- **Needs:** nothing unless a real client sends longer authorize URLs (P5-06).

### P5-04 — consent page CSP widens `form-action`
- **Context:** Chromium applies `form-action` to the redirect after the consent post (measured).
- **Assumption made:** the consent page's CSP is the UI policy plus the redirect URI's origin in `form-action` (`http:`
  for an IPv6 loopback redirect); every other page keeps `form-action 'self'`.
- **Options:** answer the post with a 200 page that links/meta-refreshes to the client instead (needs a click or a meta
  refresh, and the same origin must still be navigable).
- **Needs:** nothing unless the owner prefers the interstitial page.

### P5-04 — device label stored as provider grant metadata
- **Context:** T25 said grant metadata stays `{}`; the device label is needed for P5-05's device list and props are
  encrypted with the token (unreadable without it).
- **Assumption made:** `metadata: { label }` (checked plain text ≤ 60 characters, typed by the user), else `{}`.
- **Needs:** owner confirmation (or P5-05 keeps labels elsewhere).

### P5-04 — `RB_OAUTH` variables
- **Context:** P5-03 left the DCR settings to the host switch.
- **Assumption made:** `RB_OAUTH` (off), `RB_OAUTH_DCR` (on), `RB_OAUTH_DCR_LIMIT` (30/hour or `off`),
  `RB_OAUTH_DCR_REDIRECT_HOSTS` (unset = any). Token lifetimes stay at the defaults until P5-05's plan presets.
- **Needs:** owner review of the defaults (see the P5-03 DCR entry).


## P5-05 — Token lifecycle

### P5-05 — no per-plan access-token preset (1 h everywhere)
- **Context:** the task asked for 8 h access tokens on `RB_PLAN=free` because of the Workers KV write quota (1,000/day,
  ADR-0009). Since ADR-0011 the state is in D1 (100,000 row writes/day on Free); a refresh costs about five row writes.
- **Assumption made:** 1 h access tokens and an absolute 30-day refresh lifetime on every plan, overridable with
  `RB_OAUTH_ACCESS_TTL` / `RB_OAUTH_REFRESH_TTL`.
- **Options:** keep; or reintroduce a longer Free default if D1 quotas become a problem in practice.
- **Needs:** owner confirmation.

### P5-05 — strict refresh reuse detection, no grace window
- **Context:** the provider accepts the previous refresh token once more (for clients that lost a refresh response).
  P5-05 makes refresh tokens single use: any second use, including two concurrent refreshes by the same client, revokes
  the whole device (RFC 9700 §4.14.2).
- **Assumption made:** strict; the client must re-authorize after a lost refresh response or a double refresh.
- **Options:** a short grace (e.g. 30 s, same client id, at most once) at the cost of a window for a stolen token.
- **Needs:** revisit if P5-06 finds a client that retries or parallelises refreshes (claude.ai, Claude Code, mobile).
- **Update (P5-09):** P5-06 found the SDK client parallelises refreshes; superseded by ADR-0013 (30 s reuse interval by
  default, strict with `RB_OAUTH_REFRESH_REUSE_WINDOW=0`). See the P5-09 entry below.

### P5-05 — every refusal at token issuance revokes the device
- **Context:** the code exchange and each refresh re-run `resolveAccess`. Some refusals are permanent (grant revoked or
  expired, user deleted), others may be temporary (project disabled, key refused by New Relic, unvalidated key).
- **Assumption made:** any refusal answers `invalid_grant` and revokes the device (the provider's behaviour for
  `invalid_grant` from the callback); the person approves the app again once the problem is fixed. Disabling a user also
  revokes their devices for good (re-enabling does not restore them), like their sessions.
- **Options:** answer `temporarily_unavailable` without revoking for the temporary reasons.
- **Needs:** owner preference.

### P5-05 — access grant id in provider grant metadata
- **Context:** revoke-all needs to know which access grant a device was approved with; the props holding it are
  encrypted with the token. T25 keeps grant metadata minimal.
- **Assumption made:** metadata `{ label?, grant: "grt_…" }` (an opaque id). Devices approved before P5-05 lack it: they
  are still revoked by user disable and project delete, and their refresh is refused once the grant is revoked.
- **Needs:** owner confirmation (T25).

### P5-05 — `/oauth/approvals` kept next to the device list
- **Context:** P5-04 suggested merging remembered approvals into the device list.
- **Assumption made:** two lists: "Apps connected with OAuth" on My access (tokens) links to `/oauth/approvals`
  ("don't ask again" rows); disconnecting an app also forgets its approval for that project.
- **Options:** merge both into one table in the admin UI.
- **Needs:** owner preference (UI only).

## P5-06 — Client compatibility matrix

### P5-06 — real clients not verified (autonomous run had no accounts)
- **Context:** the agent could not use claude.ai, Claude mobile, Claude Desktop, Cursor, VS Code or ChatGPT. The matrix in
  `docs/reference/client-compatibility.md` rests on an automated suite (the official SDK client shaped like each client
  family) plus vendor docs. The task's real-client acceptance criteria stay unticked.
- **Assumption made:** vendor docs are right that web, Desktop, mobile and Cowork share one hosted OAuth client and callback
  (`https://claude.ai/api/mcp/auth_callback`), so a pass on claude.ai web is strong evidence for mobile; the phone check is
  still worth doing once because the in-app browser and sign-in cookies behave differently.
- **Needs:** the owner (or a community tester) to run the checklist below and record dated results in the matrix.

### P5-06 — manual verification checklist (phone + claude.ai)
Prerequisites: a deployed relic-bridge reachable from the internet over https (Anthropic connects from `160.79.104.0/21`;
`localhost`/LAN never works), `RB_PUBLIC_URL` set to that exact public URL, sign-in configured (GitHub or Cloudflare
Access), `RB_OAUTH=on`, one project with a grant for your user. Keep `RB_OAUTH_DCR=on` for the first run.
1. In a desktop browser: claude.ai > Settings > Connectors > Add custom connector > URL
   `https://<public-host>/p/<slug>/mcp` (no OAuth client fields: leave advanced settings empty). Add.
2. Claude opens your sign-in. Sign in, then check the consent page: client name "Claude" with "identified by claude.ai"
   (CIMD) or the "not verified" badge (DCR), "Sends you back to claude.ai", your project and grant. Approve (optionally
   name the device "claude.ai web"). Expect: connector shows Connected.
3. New chat > enable the connector > ask "run whoami with the relic tool". Expect a result; check Admin > My access >
   "Apps connected with OAuth" lists the app, and the audit log has `oauth.consent.approve` plus MCP calls with the
   OAuth client id.
4. Note in the server log (stderr) whether registration was CIMD (no `/oauth/register`) or DCR.
5. **Phone** (iOS and/or Android Claude app, same account): Settings > Connectors: the connector added on web should
   already be listed (connectors sync across surfaces). If it asks to connect, do so and approve again. Start a chat,
   enable it, run the same prompt. Note whether the consent page opens in an in-app browser and is usable (320 px layout,
   sign-in session, buttons). Then leave the phone idle for more than `RB_OAUTH_ACCESS_TTL` (set it to 5 min for the test),
   ask again: expect it to keep working with no new consent (refresh). Check the audit log for `oauth.token.reuse`: there
   must be none. An `oauth.token.replay` row means the client refreshed concurrently and the P5-09 reuse interval saved
   the connection (record it: it answers the P5-09 decision). To see what strict mode would do, repeat with
   `RB_OAUTH_REFRESH_REUSE_WINDOW=0`.
6. Disconnect on the phone, then reconnect: should require consent again and work. Then in Admin > My access click
   "Disconnect" for the app and ask again in Claude: expect an error and a prompt to reconnect, not a loop.
7. Repeat 1-3 with `RB_OAUTH_DCR=off` to confirm CIMD alone works for claude.ai, and with the project's slug in the URL
   typed in a different case to see how Claude reports the mismatch (expected: refused).
8. Claude Desktop (remote connector, not stdio): confirm it shows the same connector from your account, run a prompt.
9. Claude Code: `claude mcp add --transport http relic https://<public-host>/p/<slug>/mcp`, `/mcp` > authenticate, call a
   tool; leave it past the access TTL and call again. Optionally `--callback-port 8080`.
10. Cursor and VS Code: add the URL as a remote server and sign in; record whether they use DCR, which redirect URI the
    consent page shows, and any error. Also try MCP Inspector (`npx @modelcontextprotocol/inspector`, Streamable HTTP,
    OAuth).
Record per client: date, client version, registration path (CIMD/DCR), result, anything odd. Put the results in
`docs/reference/client-compatibility.md` (change **M** cells) and tick the P5-06 criteria.

### P5-06 — parallel refresh vs strict rotation (finding)
- **Context:** the SDK client (2.2.0) does not coalesce refreshes: three parallel calls over an expired access token sent
  six refresh requests; with P5-05's strict single use the device is revoked and the person must approve again. Claude
  refreshes both proactively (up to 5 min before expiry) and on `401` (vendor docs), so an overlap is plausible but unproven.
- **Assumption made (P5-06):** server left strict; new task P5-09 decides.
- **Implemented (P5-09, ADR-0013):** the "short same-client replay window returning the already issued pair" option,
  **on by default (30 s)**, because a server that disconnects the phone on ordinary concurrent use blocks Phase 5's goal.
  The SDK's parallel refreshes now all succeed and the device stays; strict mode (`0`) still revokes. See the P5-09 entry.
- **Needs:** owner confirmation of the default (P5-09 entry).

### P5-06 — CIMD redirect host rule vs ChatGPT and a possible `claude.com` callback
- **Context:** ChatGPT documents `https://chatgpt.com/connector_platform_oauth_redirect`; a web search result mentions a
  `https://claude.com/api/mcp/auth_callback` for Claude (not in Claude's own docs, which name only `claude.ai`). A CIMD
  document drops https redirect URIs on a host other than the client id's (P5-03), so those redirects would be refused for
  CIMD clients (DCR still works).
- **Assumption made:** keep the rule; claude.ai's documented callback fits.
- **Options:** allow the same registrable domain; an allow-list of (client id host -> extra redirect hosts) for known clients.
- **Needs:** revisit only if the checklist or ChatGPT shows a refused redirect (the log says `redirect` / `no_usable_redirect_uri`).

### P5-06 — scope tolerance
- **Context:** claude.ai was reported (anthropics/claude-ai-mcp#1092) sending `scope=mcp offline_access` to another server.
  relic-bridge accepts any scope names and grants `mcp:read` (+ `offline_access` when asked), so that connects.
- **Assumption made:** keep (grants, not scopes, decide access). Tested.
- **Needs:** nothing.

## P5-09 — Concurrent refreshes

### P5-09 — refresh reuse interval on by default (30 s)
- **Context:** the MCP SDK client does not coalesce refreshes (P5-06): three parallel calls over an expired token
  revoked the device under P5-05's strict single use. Real Claude clients are unmeasured but refresh proactively and on
  `401`. The owner's main use (Claude on the phone, claude.ai) can't tolerate being disconnected on normal use.
- **Assumption made:** ADR-0013 — `RB_OAUTH_REFRESH_REUSE_WINDOW` default **30 s** (0-120; `0`/`off` = strict). Within
  the window the token just rotated, presented again by the same client (same client authentication, resource and
  scope) gets the **same** successor pair (no new family); concurrent requests wait (≈ 3 s max) for the rotation in
  progress. Reuse after the window, of an older generation, by another client or after revocation still revokes the
  device and is audited `oauth.token.reuse` (`details.replayRefused` says why); replays are audited
  `oauth.token.replay`. Accepted risk: for 30 s a stolen copy of the *previous* refresh token yields the same tokens
  the client got (public clients have no secret, so "same client" is no proof of possession).
- **Options:** keep 30 s; shorter (5-10 s: enough for parallel requests, not for a client retrying a lost response
  after a timeout); strict by default (`0`) and opt-in per deployment; up to 120 s.
- **Needs:** owner confirmation, ideally after the manual checklist (step 5: does an `oauth.token.replay` row appear?).

### P5-09 — replay sealed with a token-derived key, not the master keyring
- **Context:** the task suggested storing the replayed pair encrypted with the keyring, bound by AAD to the family.
- **Assumption made:** AES-256-GCM under HKDF-SHA-256 of the presented refresh token (AAD: user, provider grant, token
  hash), stored only for the window. Only a holder of the old refresh token can open it; a database copy can't (it has
  hashes only); the OAuth runtime gets no keyring dependency; it matches how the provider protects props.
- **Options:** add keyring encryption on top (defence in depth if the token leaks *and* the database leaks within 30 s).
- **Needs:** owner confirmation (ADR-0013).

### P5-09 — confidential clients authenticated by our own check on replays
- **Context:** a replay bypasses the provider, so relic-bridge checks client authentication itself (`none`, or the
  registered secret by its SHA-256, with the provider 1.2.x leniency between basic and post for registrations that did
  not name a method). A provider upgrade that changes those rules would need the same change here.
- **Assumption made:** mirror the provider (unit-tested); a failed check is treated as reuse (revokes).
- **Needs:** nothing unless the provider is upgraded (note for Renovate PRs of `@cloudflare/workers-oauth-provider`).

## P5-08 — OAuth clients admin

### P5-08 — registration switch semantics: runtime setting can only narrow `RB_OAUTH_DCR`
- **Context:** the task asks for a runtime switch stored in settings. `RB_OAUTH_DCR=off` is a deployment decision.
- **Assumption made:** effective = deployment on **and** setting not off. The switch can't turn on what the deployment
  disabled (the panel says so). Default on, so nothing changes until an owner flips it. Cross-isolate propagation: a
  5 s per-process cache (`OAUTH_REGISTRATION_CACHE_MS`), unreadable setting = off.
- **Options:** let the setting override the environment in both directions; a longer cache (fewer D1 reads on Workers: one
  read per 5 s per isolate on `/oauth/register` and metadata only).
- **Needs:** owner confirmation.

### P5-08 — turning registration off, not on, is one click
- **Assumption made:** off needs no confirmation (it only narrows); on shows a confirmation page.
- **Needs:** nothing unless the owner wants both confirmed.

### P5-08 — client removal scans all grants
- **Context:** the provider keys grants by `grant:<userId>:<grantId>`, so finding every grant of one client means
  listing all of them (no index by client). Bounded at 20,000 (the operation fails closed beyond it).
- **Assumption made:** fine for a personal or small-team deployment; a secondary index would be a new task if the
  number of grants grows.
- **Needs:** nothing now.
