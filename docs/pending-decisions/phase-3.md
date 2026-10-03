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
