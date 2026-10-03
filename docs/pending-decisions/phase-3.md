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

## P3-04 — Rate limiting on Workers

### P3-04 — auth-failure throttle stays per isolate
- **Context:** the Rate Limiting binding has no `peek`, and the auth-failure throttle must refuse an IP without
  consuming. D1/KV counters would work but add a write per failed request (D1 quota on Free) or KV's 1 write/s/key limit.
- **Assumption made:** `fail:` keys use the isolate bucket only (documented weakness: more guesses across isolates, mitigated
  by 256-bit tokens); `ip:`, `token:`, `grant:`, `key:` also go through the binding. Phase 2 review M6 (a shared IP
  locks out valid tokens) is unchanged and still open.
- **Options:** a D1 counter table (atomic single statement); wait for the Durable Object limiter (P7-10).
- **Needs:** owner's call whether the D1 counter is worth it before P7-10.

### P3-04 — one binding with a fixed 600 per 60 s ceiling; exact rules enforced per isolate
- **Context:** a binding has a single limit/period, but rules vary (grant `rateLimit`, token 120/min, key 120/min).
- **Assumption made:** the binding (600/60 s per key per location) is a coarse shared ceiling; the exact rule is enforced by
  the isolate bucket, so the true global limit is somewhere between the rule and isolates x rule. A refusal by the binding
  answers `Retry-After: 60`.
- **Options:** one binding per rule class (10 s and 60 s windows) in `wrangler.jsonc`; DO limiter (P7-10).
- **Needs:** only if tighter global limits are wanted.

### P3-04 — pass-through on Workers needs `RB_FINGERPRINT_SECRET`
- **Context:** P3-01 refused pass-through; P3-01 did not add a shared secret binding.
- **Assumption made:** `RB_PASSTHROUGH=on` boots only with `RB_FINGERPRINT_SECRET` (at least 32 bytes) and the `RATE_LIMITER`
  binding; the secret is optional in `secrets.required` (not needed unless pass-through is on). P3-05 setup should offer to
  generate it.
- **Needs:** nothing, unless the secret should be generated automatically.

## P3-05 — Deploy button and setup script

### P3-05 — setup is `pnpm cf:setup`, not a `relic-bridge cloudflare setup` command
- **Context:** the task named a CLI subcommand; the published CLI is a Node host that shouldn't depend on Wrangler.
- **Assumption made:** a Node script in the monorepo (`scripts/cloudflare-setup.ts`), so it needs a clone; the Deploy
  button covers the no-clone case. Wrangler is the version pinned in `apps/worker`.
- **Options:** ship the script in the npm package and spawn `npx wrangler` (cross-platform shell issues, unpinned Wrangler).
- **Needs:** nothing unless clone-free setup from npm is wanted.

### P3-05 — real-account verification is outstanding (nothing here deployed)
- **Context:** this run could not log in or deploy. The script is tested with a fake Wrangler runner only.
- **Needs (owner, ~15 min):**
  1. `pnpm install && pnpm --filter @relic-bridge/worker exec wrangler login`, then `pnpm cf:setup --dry-run`, then
     `pnpm cf:setup`. Check: (a) `wrangler secret bulk` accepts the JSON on stdin and creates the not-yet-deployed Worker
     (if it refuses, the order must become deploy-then-secrets, which `secrets.required` blocks: fallback is
     `wrangler deploy --secrets-file` or temporarily removing `secrets.required`); (b) the first deploy auto-provisions D1
     and KV and `wrangler.local.jsonc` receives the ids while `wrangler.jsonc` stays unchanged; (c) a failed
     `secret list` for a missing Worker matches the not-found pattern (`10007`) so the first run doesn't need `--assume-new`;
     (d) `curl <url>/health` answers and the first request creates the schema (migrations incl. any `PRAGMA foreign_keys`
     statements accepted by real D1: RESEARCH §12 says the D1 driver skips them, confirm no boot error);
     (e) re-run `pnpm cf:setup`: it keeps the secrets and redeploys.
  2. Deploy button: open `https://deploy.workers.cloudflare.com/?url=https://github.com/matiashidalgo/relic-bridge/tree/main/apps/worker`
     (needs the repo public; use a fork before). Check that the build can reach `../../packages/*` (monorepo; the
     alias in `wrangler.jsonc`) and that the root `pnpm install` runs. If not, the subdirectory build needs a build command
     such as `pnpm install --frozen-lockfile && npx wrangler deploy` in the setup page, or the button should be dropped.
  3. RESEARCH §13 Rate Limiting binding: confirm the binding is created from `ratelimits` on deploy and `limit()` calls don't
     count as subrequests (assumed not).
  4. Time the whole flow to two working devices against the < 10 minute criterion and tick it in the task file.

### P3-05 — secrets are revealed once on stdout
- **Context:** the owner needs the admin token to continue, and the master key to back up; the task allowed a backup file.
- **Assumption made:** print once (stdout; progress goes to stderr) and offer `--backup-file` (0600, no overwrite).
- **Options:** never print and always require `--backup-file`; integrate with a password manager CLI.
- **Needs:** owner's call whether a printed secret is acceptable (scrollback), or the backup file should be mandatory.


### P3-06 — staging smoke and the required check need the owner
- **Context:** this run has no Cloudflare account, and repo settings are out of bounds.
- **Done:** the whole P2-12 suite runs against the Worker on local D1 in the existing "Workers runtime tests" job;
  `.github/workflows/staging-smoke.yml` (nightly + manual) skips cleanly without its configuration.
- **Needs (owner):**
  1. Branch protection: add **Workers runtime tests** (and **Authorization suite**) to the required checks (repo setting).
  2. Staging: deploy a second Worker (`wrangler deploy --name relic-bridge-staging`, own D1/KV via `pnpm cf:setup`), create
     the GitHub environment `staging` (required reviewers), set variable `STAGING_URL` and secret `STAGING_ADMIN_TOKEN`.
  3. Decide whether the nightly job should also deploy (needs a scoped `CLOUDFLARE_API_TOKEN` in `staging`); it only
     smoke-tests an already deployed Worker today.

### P3-08 — audit purge cadence and budget
- **Context:** the task allowed hourly or daily; D1 limits rows per statement and queries per invocation.
- **Assumption made:** hourly (`17 * * * *`, like `serve`), 500-row batches, at most 20 batches (10,000 rows) and 10 s per
  run; the purge writes an `audit.purge` admin row only when it removed something. Purge runs even with `RB_AUDIT=off`.
- **Options:** daily trigger (fewer invocations), larger batches on the paid plan, a `RB_AUDIT_PURGE_*` setting.
- **Needs:** owner's call only if the hourly trigger conflicts with the Free plan's cron-trigger count in their account.

### P3-09 — one-call access resolution: optional capability, batch of six reads, touch kept separate
- **Context:** the task allowed one joined statement or one `batch()`; `loadAccessRecords` could be a required
  `Storage` member or optional.
- **Assumption made:** optional `Storage.loadAccessRecords` implemented by the SQL adapters (D1: one `batch()` of six
  `SELECT`s, one round trip; SQLite: same SQL in one read transaction); `memory` and `yaml` keep the repository path, so
  existing in-memory test doubles and the yaml/stdio mode are untouched. A batch rather than one joined statement:
  D1 returns rows as objects, so a join would need per-column aliases for six tables, and the batch reuses the
  adapters' row mappers. The throttled `last_used_at` write stays a separate background write (folding it into the
  batch would make every miss a write transaction on the D1 primary).
- **Options:** make it required (add an in-memory implementation); a single joined statement; drop `last_used_at`
  writes on Workers entirely, or make them monotonic (`max(stored, now)`).
- **Needs:** nothing unless the owner prefers one of the options.

### P3-10 — CPU benchmark: representative scenarios, ratio-based gate, separate workflow
- **Context:** the task asked for every built-in tool at three payload sizes and left the timer approach open.
- **Assumption made:** `performance.now()` in local workerd (it advances during CPU work there); scenarios cover each
  hot path and one tool per cost class (`whoami`, `run_nrql` at 10 KB / 100 KB / ~500 KB), not all tools. A regression
  is a ratio to a same-run calibration job above 2x the baseline's and more than 1 ms slower. Own workflow
  `bench.yml` (PRs touching Worker-path code, weekly, manual), not a required check, failing on a regression.
- **Options:** benchmark every tool; report-only; nightly instead of path-filtered PRs; a stricter tolerance once
  the variance across runners is known (the baseline was taken on a WSL2 dev machine, not a CI runner).
- **Needs (owner):** after the first runs on GitHub, check the table's ratios; if CI ratios sit far from 1.0, refresh
  the baseline from a CI run (download the summary numbers, or run `pnpm bench:cpu --update` in a workflow_dispatch).

### P3-07 — docs delivered without a clean-account validation; master-key rotation gap on D1
- **Context:** the task asks for a fresh deployment on a clean account and release v0.3.0; neither is possible
  unattended (no deploys, no releases).
- **Assumption made:** guides were checked against the code and by running the CLI and `pnpm cf:setup --dry-run`;
  restore from a `wrangler d1 export` and the Deploy button are marked "not exercised". Cloudflare Access is documented
  for the future admin panel only (it would block MCP clients and the CLI's `--remote` on `/p/*/mcp` and
  `/api/admin/v1`). Costs are estimates from P0-06 CPU data and Cloudflare's prices of 2026-10-03.
  `keys rotate` is SQLite-only, so a Worker's master key can be rotated only credential by credential
  (`credential rotate`); new task P3-11 covers a proper D1 rotation.
- **Options:** ship the Worker guide only after a validation run; make P3-11 a Phase 3 release blocker.
- **Needs (owner):** deploy to a clean account following `cloudflare-deploy.md`, fix whatever differs, tick the first
  acceptance criterion, then release v0.3.0; decide whether P3-11 blocks it.

### P3-11 — master-key rotation on D1 through the admin API, not the cron trigger
- **Context:** `keys rotate` needs the database and both keys; a Worker's D1 is only reachable from inside the Worker.
  The task offered an admin endpoint driven by the CLI, or background rotation by the hourly cron.
- **Assumption made:** `POST /api/admin/v1/keys/rotate` re-encrypts one batch per call (default 25 rows, max 100: about
  30 D1 queries, under the Free plan's 50 per invocation), with a credential-id cursor; `relic-bridge keys rotate --remote`
  loops to completion and exits 0 only when nothing is pending. Chosen over the cron because the operator needs a
  definite "done, remove the previous key" and the list of rows that failed; a cron run reports to no one. The endpoint
  also works against `serve`. The runbook sets both secrets with one `wrangler secret bulk` (two `secret put` calls
  would deploy an intermediate version that fails its boot check or can't read old rows) and reruns the rotation after
  the rollout before removing the previous key (old isolates could still write under v1).
- **Options:** additionally let the cron finish a started rotation when `RB_MASTER_KEY_PREVIOUS` is set (no CLI needed,
  but silent); a `--wait` that polls until old isolates drained.
- **Needs (owner):** confirm on a real account that `wrangler secret bulk` with both keys deploys a single version
  (the runbook depends on it; not exercised in this run), then follow `cloudflare-deploy.md#rotate-the-master-key` once.

## Phase 3 consolidation review

### Review — M6 lock-out semantics and admin token strength (P3-13)
- **Context:** the auth-failure throttle answers 429 to every request from an IP after 10 failures, valid admin and MCP
  tokens included (probed on the Worker); on Workers it is per isolate. `RB_ADMIN_TOKEN` is checked for length only.
- **Assumption made:** nothing changed; task P3-13 created.
- **Options:** (a) let a verified token bypass `fail:<ip>`; (b) shared D1 failure counter; (c) both; plus a minimum
  entropy rule for the admin token.
- **Needs:** owner's choice before P3-13 starts.
- **Update:** P3-13 went ahead with (a) plus the entropy rule (see the P3-13 entries below).

### Review — real-account checks added by the review fixes
- **Context:** `cf:setup` now deploys with `--keep-vars` and gives a non-default `--name` its own
  `wrangler.<name>.local.jsonc` and D1 `database_name`. Both rely on Wrangler behaviour checked only in `--help` and docs.
- **Needs (owner, during the P3-05 real-account run):** (a) set `RB_ALLOWED_HOSTS` in the dashboard, re-run
  `pnpm cf:setup`, confirm it is still set; (b) `pnpm cf:setup --name relic-bridge-staging` creates a second D1
  database `relic-bridge-staging` (not the production one).

## P3-13 — Admin token strength and failure throttle

### P3-13 — M6 decided as "verified tokens bypass the failure throttle" (option a), without a shared D1 counter
- **Context:** the owner was away; the task title asks that the throttle cannot lock out valid tokens.
- **Assumption made:** option (a) on Node and Workers: failures are charged and, past the budget, answered 429; a
  token that verifies is served. No shared D1 failure counter (b): it adds a D1 write per failed request (Free quota) and
  a read on every failure path, while tokens are 256-bit and the admin token is now strength-checked; the documented
  interim shared defence is an optional WAF rate-limiting rule on `/api/admin/*` (needs a custom domain; Free plan: one
  rule, 10 s period). Pass-through keeps the strict pre-auth refusal (a locked IP cannot make the server call NerdGraph).
- **Options:** keep; revert to "refuse everything from a locked IP" (restore the `peek` in `beforeAuth` for all scopes);
  add the D1 counter now instead of waiting for the Durable Object limiter (P7-10).
- **Needs:** owner confirmation (also closes Phase 2 review M6).

### P3-13 — strength thresholds
- **Context:** the task suggested "fewer than ~10 distinct characters". 32 random hex characters (`openssl rand -hex
  16`, 128 bits) have fewer than 10 distinct characters about once in 7,700 draws, which would refuse a good token.
- **Assumption made:** refuse below **8** distinct characters, plus a repeated block (period ≤ half the length), > 60 %
  runs/±1 steps between neighbours, and a placeholder list (`changeme`, `replace-me`, `placeholder`, `example`,
  `your-admin-token`, `password`, `admin-token`, …). Warn (boot continues) when estimated entropy < 100 bits, one
  character class, no digit, > 40 % steps, or a common word (`admin`, `token`, `test`, `relic`, …). No dictionary is
  shipped, so a long mixed-case word passphrase is not detected. The CLI `--remote` client applies the same check to the
  token it reads, so a weak token configured on an older server is refused client-side too.
- **Options:** other thresholds; make warnings refusals; ship a small word list.
- **Needs:** nothing unless the owner wants stricter rules.

