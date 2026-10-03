# Phase 3 — pending decisions

Decisions that agents could not make alone during the autonomous run (2026-10-03). Each entry says what was
assumed so work could continue. Review, then answer in place or move the outcome into an ADR / task file.

Format: `### <task id> — <short title>` then **Context**, **Assumption made**, **Options**, **Needs**.

## Workflow

### ALL — stacked PRs instead of merging to `main`
- **Context:** The owner was away. Every task PR targets the previous task's branch (the first one targets
  `phase/3-cloudflare` (itself stacked on the tip of Phase 2, `task/P2-19-image-scan-healthcheck`)), so nothing is merged into `main`.
- **Assumption made:** A dependency counts as satisfied when its task is `review` and its branch is lower in the
  stack. Tasks stay `review`, not `done`, until their PRs are merged.
- **Options:** merge the stack bottom-up (retarget each PR to `main` after its parent merges), or squash-merge the
  tip into `main` in one go.
- **Needs:** owner's merge strategy; then mark merged tasks `done` and run `pnpm tasks index`.

## P3-01 — Worker entry

### P3-01 — `Host` check off by default on Workers
- **Context:** `serve` refuses a non-loopback bind without `RB_ALLOWED_HOSTS` (DNS-rebinding protection, T24). A Worker's
  hostname (`<name>.<subdomain>.workers.dev` or a custom domain) isn't known at build time, and Cloudflare only routes
  the Worker's own hostnames to it, so DNS rebinding against a private network does not apply.
- **Assumption made:** `RB_ALLOWED_HOSTS` defaults to "any" on Workers; `Origin` is still validated (loopback default),
  and operators can pin hostnames.
- **Options:** keep; or require `RB_ALLOWED_HOSTS` and have the P3-05 setup script fill it in with the workers.dev name.
- **Needs:** owner's call (P3-05 can set it either way).

### P3-01 — committed `wrangler.jsonc` without ids instead of a `.example` file
- **Context:** the task asked for `wrangler.jsonc.example`. Wrangler's automatic provisioning (wrangler ≥ 4.45, open
  beta) accepts D1/KV bindings without ids, uses local resources in `wrangler dev` and creates them on the first
  deploy. Tests and `wrangler dev` need a real config file.
- **Assumption made:** `apps/worker/wrangler.jsonc` is committed with no account or resource ids; nothing secret.
  A deploy writes the created ids back into that file, which would show up as a local change.
- **Options:** (a) keep, and have P3-05 deploy from a git-ignored copy (`wrangler.deploy.jsonc`) or tell users not to
  commit the ids; (b) rely on provisioning (resources stay linked without ids) and discard the write-back; (c) use
  explicit `wrangler d1 create` + ids in a git-ignored file only.
- **Needs:** decide with P3-05 (deploy button / setup script).

### P3-01 — `RB_ADMIN_TOKEN` listed as a required secret
- **Context:** on Node the admin API is optional. On Workers there is no local CLI with database access, so the admin
  API is the only way to create projects, credentials and tokens until Phase 4 identity login.
- **Assumption made:** `secrets.required` lists both `RB_MASTER_KEY` and `RB_ADMIN_TOKEN` (deploy fails without them);
  the code still runs with the admin API off when the token is absent.
- **Options:** keep; or make the admin token optional and document the consequence.
- **Needs:** owner's call.

### P3-01 — Workers tests not in the coverage gate; new CI job not yet required
- **Context:** V8 coverage cannot attach to workerd, so `pnpm test:coverage` runs `--project=!worker`, and a new CI
  job **Workers runtime tests** runs `pnpm test:workers`.
- **Assumption made:** P3-06 makes the job a required check (branch protection is an owner setting).
- **Needs:** add "Workers runtime tests" to the required checks once P3-06 lands.

## P3-02 — D1 adapter

### P3-02 — migrations run by the Worker at boot, not `wrangler d1 migrations apply`
- **Context:** the original task said "same migrations applied with `wrangler d1 migrations apply`". Our runner
  (checksums, `schema_migrations`, forward-only) already ships the SQL embedded in the bundle; a wrangler migrations
  directory would track a second history (`d1_migrations`) that can drift from ours.
- **Assumption made:** the Worker applies pending migrations on the first request of each isolate (concurrent boots
  race safely). Recorded as an update in ADR-0006.
- **Options:** keep; or also generate a `wrangler d1 migrations` folder for operators who want to migrate before
  traffic (would need a check that both histories agree).
- **Needs:** owner's call; P3-05/P3-07 document whichever is kept. A failed migration shows up as 503 + a log line
  after deploy rather than as a failed `wrangler deploy`.

### P3-02 — `PRAGMA foreign_keys` skipped on D1; not verified against remote D1
- **Context:** migration `0001_audit_auth_kind` (drizzle-kit table rebuild) contains `PRAGMA foreign_keys=OFF/ON`.
  Local D1 accepts it; whether remote D1 accepts it is unverified (no deploys in this run). Inside a transaction SQLite
  ignores the pragma anyway.
- **Assumption made:** the D1 migration driver skips `PRAGMA foreign_keys` statements (checksums unchanged).
- **Needs:** a first real deploy (P3-05) to confirm migrations apply cleanly on remote D1.

### P3-02 — single-query access resolution split out (P3-09)
- **Context:** the task's "access resolution = 1 D1 call on miss" needs a new `Storage` capability and changes in
  `@relic-bridge/auth`. Today a miss costs 5 reads in 3 round trips; a hit costs 0 (tested).
- **Assumption made:** moved to the new task P3-09 (medium priority).
- **Needs:** nothing unless the owner wants it before v0.3.

## P3-03 — Workers plan presets

### P3-03 — Free budget is 45 external calls, not 50, and D1 no longer counts
- **Context:** Cloudflare's current docs (changelog 2026-02-11) say Free allows 50 *external* subrequests and 1,000 to
  Cloudflare services (D1/KV), so the ADR-0010 assumption "D1 lookups eat the 50" is outdated. Paid defaults to 10,000.
- **Assumption made:** the budget counts NerdGraph calls only; Free = 45 (5 spare for redirect hops), Paid = 1000
  (deliberately far below 10,000). Presets: response ceiling 512 KiB / 8 MiB, concurrency 5 / 5. ADR-0010 got an addendum
  instead of a new ADR since it refines its own provisional table.
- **Options:** Free = 50 exactly; or Paid = 10,000 to match the platform.
- **Needs:** owner's call only if they want different numbers (they are one line in `apps/worker/src/settings.ts`).

### P3-03 — no new real-account measurement; CPU benchmark deferred to P3-10
- **Context:** the task asked to run `spikes/workers-limits/deploy-and-measure.md` on a real Free account. That was done
  in P0-06 (cold 17-35 ms, no kills up to 61 ms), and this run may not deploy or log in.
- **Assumption made:** P0-06's production numbers stand as the evidence; the CI CPU benchmark is moved to P3-10 because
  workerd timers don't advance during CPU work, so the approach needs a decision.
- **Needs:** optionally re-measure after P3-05 deploys, to confirm cold-start CPU with D1 migrations in the boot path.

### P3-03 — a tool dearer than the budget is hidden, not partially served
- **Context:** `cost` is a single expected number (run_nrql = 4, get_golden_metrics = 11), not a minimum.
- **Assumption made:** hide when `cost > RB_CALL_BUDGET`, even though some of those tools can return partial results
  with less. Never triggers with the presets (45 / 1000).
- **Options:** add a `minCost` to tool metadata so partial-capable tools stay available at small budgets.
- **Needs:** only if someone runs with a budget below 11.
