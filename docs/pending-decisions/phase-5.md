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
