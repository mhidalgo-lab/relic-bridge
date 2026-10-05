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
