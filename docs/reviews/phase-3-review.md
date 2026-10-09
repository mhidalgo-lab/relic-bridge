# Phase 3 consolidation review

- **Scope:** all of Phase 3: `git diff task/P2-19-image-scan-healthcheck...task/P3-11-d1-master-key-rotation`
  (P3-01 … P3-11, 105 files, ~9k lines including the lockfile).
- **Branch:** `review/phase-3`, stacked on `task/P3-11-d1-master-key-rotation` (top of the Phase 3 PR stack).
- **Date:** 2026-10-03.
- **Method:**
  - Investigated first the P3-11 commit that pinned the fast-check seed of the D1 access-equivalence test (below).
  - Read the security-relevant source in full: `apps/worker/src` (entry, settings, rate limiter, cron purge),
    `packages/storage/src/d1.ts` and `access-records.ts`, `packages/auth/src/access/authenticate.ts`,
    `packages/auth/src/crypto/rotate.ts`, the rotation admin route and `keys rotate --remote`, `scripts/cloudflare-setup.ts`,
    the three workflows and `wrangler.jsonc`. Three parallel adversarial sub-reviews (Worker entry, D1 + rotation,
    setup/CI/docs/completeness) with probe tests in the workers pool (local workerd + D1 simulator), cross-checked.
  - Probes: cold-isolate boot storms, failing storage, a throwing Rate Limiting binding, foreign `Origin`/`null`
    Origin on `/health`, admin and MCP routes, weak admin tokens, bad-token spraying from one IP, rotate batches
    counted per D1 query, rotation without the previous key, mistyped new master key, `kv` TTL edge cases, non-finite
    limits, concurrent CAS and `setIfAbsent`.
  - Nothing was deployed; no Cloudflare account exists. Wrangler behaviour was checked with `wrangler deploy --help`
    and Cloudflare docs only.
- **Checks:** `pnpm lint && pnpm typecheck && pnpm test && pnpm test:workers && pnpm build` green before and after the
  fixes (1391 + 178 tests). The P2-12 authorization matrix (also run against the Worker) stays green. Each regression
  test added here fails with its fix reverted (checked).

## The pinned-seed "flaky" D1 test

**Root cause: a coverage check, not a divergence.** The property (`packages/auth/test/access-equivalence.ts`) asserts
two things: (a) for every query, the one-call path (`authenticateAccess` over `loadAccessRecords`) returns exactly
what `verifyAccessToken` + `resolveAccess` return, with the same touches and one storage call; (b) after all runs,
at least one decision was *allowed* and one *denied*. Every state in the generated worlds was "off" one time in six,
so only **4.7 % of runs** (SQLite, 1,000 runs) and 6.7 % (D1, 600 runs) reached any allowed decision. With the D1
suite's 30 runs, (b) failed with probability about 0.95^30 ≈ 21 %; with SQLite's 150 runs, about 0.1 %. Pinning the
seed made (b) deterministic but froze the D1 run to one set of 30 worlds.

**Evidence that there is no divergence:** with the seed removed and the coverage check turned into a counter, 6,000
SQLite runs and 1,200 D1 runs (two generators, random seeds) produced no counterexample for (a). The code path also
reads right: both paths share `checkTokenRecord`, `precheckAccess` and `decideAccess` → `computeAccess`; the SQL scopes
user/credential/owner to `p.slug = ? AND p.id = g.project_id` exactly where `resolveAccess` stops reading, and the
owner condition `(g.user_id IS NULL OR o.id <> g.user_id)` matches `ownerId !== grant.userId`.

**Fix (commit `test(auth): unpin …`):** half the generated worlds are now *live* (nothing revoked, disabled, expired
or unvalidated; only known tokens; disabled users still possible), so outcomes turn on the structural checks. About
20 % of runs reach an allowed decision (allowed queries 2 % → 16 %), and `credential_owner_disabled`, the one branch
where the SQL differs most from the repository path, went from 2 to 80 hits per 1,000 runs. The seed is random again;
D1 runs 60 (miss probability for (b) ≈ 1e-6, three consecutive green runs), SQLite stays at 150.

## Verdict

**Ready, with fixes in this branch.** No critical findings; the Worker keeps the Phase 2 security design intact.

- **Fixed here, with regression tests:** two high findings in `pnpm cf:setup` (dashboard settings wiped on every
  re-run; a second Worker name sharing the first one's config and D1), one medium (secrets lost to a failing backup
  file), the D1 equivalence test (unpinned, generator fixed), and the deploy guide's inaccuracies.
- **Holds under attack:** secrets only in secret bindings; `vars` validated and failing closed with a generic 503;
  no module-level request state; one-call access resolution equivalent to the old path; D1 writes the security model
  depends on are single statements (`setIfAbsent` via `ON CONFLICT DO NOTHING` + `changes`, credential CAS in the
  `UPDATE … WHERE`); migrations race-safe; every value bound; rotation endpoint admin-only, key checks before any row,
  CAS per row, counts and ids only in answers and audit; cron purge bounded and never throwing; `Origin` still
  validated with the `Host` check off; pass-through refused without a ≥ 32-byte fingerprint secret and the binding;
  workflows least-privilege and SHA-pinned, no `pull_request_target`, no secrets for fork PRs; no `nodejs_compat`.
- **Roadmap promise ("same server on Workers; MacBook, PC and W365 connect via Claude Code")** is met in code and
  offline tests: `pnpm cf:setup` → `relic-bridge … --remote` → `token create --client claude-code` prints a
  `claude mcp add --transport http …/p/<slug>/mcp` line. Not yet done:
  1. **Nothing has run on a real Cloudflare account**: `secret bulk` before the first deploy, automatic provisioning,
     `--keep-vars`, remote D1 accepting the migrations, the Rate Limiting binding, the Deploy button from a monorepo
     subdirectory. Owner checklist in `docs/pending-decisions/phase-3.md` (P3-05, P3-07, P3-11).
  2. **W365 (Windows)** works from PowerShell only if the user translates the bash snippets (P3-14).

## Per-task completeness

| Task | Status | Evidence / gap |
|---|---|---|
| P3-01 Worker entry | met | lazy per-isolate runtime, boot fails closed (503, variable named), `waitUntil`, `CF-Connecting-IP`, no `nodejs_compat`; criteria text still says "503 until P3-02" (historical) |
| P3-02 D1 adapter | met | contract suite in workerd, concurrent CAS/`setIfAbsent`, FK enforcement, concurrent boots; `PRAGMA foreign_keys` on remote D1 unverified (owner) |
| P3-03 plan presets | met | presets 45 / 1000 calls, 512 KiB / 8 MiB, concurrency ≤ 6; over-budget tools hidden and explained in `whoami` |
| P3-04 rate limit | met | layered binding + isolate limiter, pass-through gated; `fail:` per isolate and M6 lock-out still open (P3-13) |
| P3-05 deploy/setup | partially | CSPRNG, stdin, idempotent, dry run met; re-run safety was broken (H1, H2, M1 below, fixed here); README Deploy button missing (P3-14); real-account run outstanding |
| P3-06 Workers tests | met | P2-12 matrix runs against the Worker; staging smoke workflow skips cleanly; required check is an owner setting |
| P3-07 docs | partially | guides present; "behaviour matches the code" was not true for `--keep-vars`, the stale local config and rotation commands without `-c` (fixed here); fresh-account validation and v0.3.0 release outstanding |
| P3-08 audit purge | met | hourly cron, bounded batches, never throws, `audit.purge` row |
| P3-09 one-call access | met | one `batch()` / one read transaction, equivalence property (now unpinned), one-call test |
| P3-10 CPU benchmark | met | baseline, ratio gate, `bench.yml`; baseline from WSL2, to refresh from CI (owner) |
| P3-11 D1 key rotation | met | endpoint + `--remote` loop, authz entry, runbook; Free-plan batch-size ceiling and boot warning for unreadable rows are follow-ups (P3-15) |

## Findings

Severity: impact if exploited or hit × likelihood. Status: **fixed** (here, with tests), **task** (new task file),
**decision** (`docs/pending-decisions/phase-3.md`), **accepted** (documented residual).

### High

**H1. `pnpm cf:setup` re-runs deleted every dashboard variable.** `scripts/cloudflare-setup.ts` (deploy args) ran
`wrangler deploy` without `--keep-vars`; Wrangler then deletes dashboard variables before applying the config's.
The guide calls a re-run the update path and told operators to set `RB_ALLOWED_HOSTS` in the dashboard, claiming
"settings set in the dashboard survive redeploys".
*Impact:* every update silently reset security settings (`RB_ALLOWED_HOSTS`, `RB_AUDIT*`, `RB_RATE_LIMIT`,
`RB_PASSTHROUGH`) to defaults. *Fix:* `--keep-vars`, doc corrected; test asserts the flag. **fixed**

**H2. Every Worker name shared one local config and one D1 database name.** `scripts/cloudflare-setup.ts` copied
`wrangler.jsonc` to a single `wrangler.local.jsonc` (into which Wrangler writes provisioned ids) and `--name` changed
only the Worker name. The pending decisions recommend `pnpm cf:setup --name relic-bridge-staging`.
*Impact:* a staging Worker binds to the production D1 (shared data; with another master key, 503 `key_mismatch`, or
worse, staging registering its key check first on a fresh database). *Fix:* `wrangler.<name>.local.jsonc` and
`database_name` = Worker name for non-default names; `.gitignore` covers them; tests. The shared Rate Limiting
`namespace_id` (`1701`) is still per account (P3-14). **fixed**

### Medium

**M1. A failing `--backup-file` lost the new secrets.** `writeFileSync(…, {flag: 'wx'})` ran after `secret bulk` and
before the reveal; `EEXIST`/`EACCES` crashed the script. A re-run sees the secrets as existing and never shows them:
the owner is left without the master key and admin token. *Fix:* existing path refused before anything is generated;
reveal first; a write failure only warns; tests. **fixed**

**M2. The auth-failure throttle locks valid tokens out and is per isolate.** `packages/http-app/src/rate-limit-hooks.ts`
(`peek fail:<ip>`), `apps/worker/src/rate-limit.ts` (`fail:` not shared). Probe: 10 bad admin tokens from one IP, then
the valid `RB_ADMIN_TOKEN` gets 429 for 5 min; same on `/p/<slug>/mcp`. Distributed guessing gets the limit per
isolate and location. Phase 2 M6, still undecided. **task P3-13, decision**

**M3. The internet-facing admin token is checked for length only.** `packages/http-app/src/admin/token.ts`:
`'a'.repeat(32)` boots and is accepted. With M2's per-isolate throttle a hand-made token is guessable online, and the
admin API can create tokens and rotate keys. `cf:setup` generates 256-bit tokens; the Deploy button path takes typed
ones. **task P3-13**

**M4. Concurrent cold requests each boot.** `apps/worker/src/worker.ts` `runtimeFor`: 50 concurrent unauthenticated
`/health` requests ran 50 boots (migration and key-check queries); after a failure every request arriving when the 5 s
window expires boots again (retry storm against an already struggling D1), one log line each. Bounded per isolate, by
design to avoid cross-request I/O hangs. **task P3-12**

**M5. Local config never refreshed after `git pull`.** `cf:setup` copies `wrangler.jsonc` once; later bindings,
crons or compatibility dates are not deployed by the documented update path. Documented now. **task P3-14**

### Low

- **L1** `RB_ALLOWED_HOSTS` defaults to any on Workers. Safe: Cloudflare routes only the Worker's hostnames, and the
  `Origin` check (403 for foreign and `null` origins, probed) still blocks browser cross-origin calls. **accepted**
  (pending decision P3-01 kept).
- **L2** Boot failure retries every 5 s forever, no backoff (`worker.ts`). **task P3-12**
- **L3** Missing `RATE_LIMITER` binding or a throwing binding degrades to per-isolate limits with a warning (fail
  open by design, probed). **accepted**
- **L4** `keys/rotate` accepts `batchSize` 100 ≈ 106 D1 queries, over Free's 50 per invocation (fails mid-batch with
  500; CAS keeps data safe, rerun resumes). Documented "Paid only". **task P3-15**
- **L5** Booting once with a mistyped new-version master key registers its check value; rollback then fails
  `key_version_retired`. Recovery now documented (troubleshooting). **fixed (docs)**, guard in **P3-15**
- **L6** No boot warning when credentials sit under a key version the keyring lacks; runbook step 5 now says to remove
  the previous key only after step 4 reported 0 pending. **fixed (docs)**, warning in **P3-15**
- **L7** `kv.put` treats non-finite TTL as "never expires" (all adapters alike; `kv` unused on Workers today); D1
  `auditLog.list` / `purgeBefore` bind a NaN limit (callers validate). **task P3-15**
- **L8** Rotation runbook ran bare `wrangler secret bulk/delete` (wrong directory, no `-c`). **fixed (docs)**
- **L9** Windows: bash-only snippets in the deploy guide; `token create` prints a POSIX-quoted `claude mcp add`.
  **task P3-14**
- **L10** P3-05 "README button" criterion not met (button only in the guide). **task P3-14**
- **L11** `RB_MAX_RESPONSE_BYTES` up to 64 MiB on a 128 MB isolate (not measured); `RB_CALL_BUDGET` > 50 on Free only
  warns. Operator choices. **accepted**

### Info

- The Rate Limiting binding is a coarse 600/60 s ceiling per key and location; exact rules per isolate (documented).
- Cron purge failures are logged, not surfaced; alerting must use Workers Logs.
- The cron opens D1 with migrations, so it can migrate the schema before any request (harmless, same runner).
- `staging-smoke.yml` exits green when unconfigured, and its header file is not `chmod 600` (no checkout, protected
  environment).

## Phase 2 notes for Phase 3: honoured?

| Note | Outcome |
|---|---|
| 1. mount as a Worker with `waitUntil`, client IP, HSTS | done (`CF-Connecting-IP`, `ctx.waitUntil`, HSTS on https) |
| 2. rate limiting seam; decide M6 first | seam implemented; **M6 not decided** (M2 above, P3-13) |
| 3. D1 contract suite, atomic `setIfAbsent`, `ifKey` CAS, migration runner | done and tested in workerd; own runner kept (ADR-0006 update) |
| 4. per-request budget from ADR-0010 | done (plan presets, ADR-0010 addendum) |
| 5. cache consistency across isolates | documented (≤ TTL, default 30 s) |
| 6. pass-through needs a shared fingerprint secret | done (`RB_FINGERPRINT_SECRET`, boot refuses without it) |
| 7. master key from a secret binding, never D1 | done; rotation via the admin API (P3-11) |

## What Phase 4 (identity providers, admin sessions/CSRF, admin UI) must know

1. **The admin surface is internet-facing on Workers.** Until IdP login exists, `RB_ADMIN_TOKEN` is the only gate and
   the failure throttle is per isolate (M2, M3). Phase 4 should make the static token a bootstrap-only credential
   (single use or disabled once an owner signs in), as T14 already plans.
2. **Sessions and CSRF state cannot live in isolate memory.** Isolates are many and short-lived; per-isolate state
   (access cache, rate-limit buckets, boot runtime) is already a known weakness. Admin sessions, CSRF tokens and OAuth
   state belong in D1 or KV (the `kv` repo exists on D1; validate TTLs first, P3-15), with revocation effective on
   every isolate, not "within the cache TTL".
3. **Cookies change T13.** The admin REST API is bearer-only today, so CSRF does not apply; once the UI uses cookies,
   every state-changing admin route (including `keys/rotate`) needs CSRF protection and `SameSite`, and the
   `Origin` check must stay on (it is on by default on Workers even with the `Host` check off).
4. **Cloudflare Access does not fit MCP or `--remote` routes** (pending decision P3-07): scope it to the UI paths only.
5. **The setup flow sets `vars` with `--keep-vars` now**; new Phase 4 settings (IdP client ids) can live in the
   dashboard, client secrets must be Worker secrets added to `cf:setup` and `secrets.required` carefully (a required
   secret blocks every deploy until set).
6. **Authz matrix:** every new admin/UI route needs an entry in `packages/http-app/test/authz/matrix.ts`; the suite
   runs against the Worker too (`test:workers`).
