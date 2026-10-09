# Testing

`pnpm test` runs the unit, integration and E2E suites offline (mock NerdGraph). `pnpm lint`, `pnpm typecheck` and
`pnpm build` must also pass before a PR.

Tool descriptions have their own lint, eval set and offline router baseline inside `pnpm test`, plus an optional
model-in-the-loop eval (`pnpm eval:tools`): see [evals.md](evals.md).

## Authorization and isolation suite

`pnpm test:authz` runs `packages/http-app/test/authz/` alone (it is also part of `pnpm test`, and CI runs it as the
**Authorization suite** job). It is data-driven:

| File | What it checks |
|---|---|
| `matrix.ts` | The data: every route (`MCP_ROUTES`, `PASSTHROUGH_ROUTES`, `ADMIN_ROUTES`, `PUBLIC_ROUTES`, `WILDCARD_ROUTES`) and every kind of caller (`MCP_PRINCIPALS`, `PASSTHROUGH_PRINCIPALS`, `ADMIN_PRINCIPALS`), each with the stable deny reason its audit row carries. |
| `routes.test.ts` | Route × principal: `401` byte-identical to the route family's reference denial (only `X-Request-Id` differs), an `auth.denied` audit row with the reason and no identity, no NerdGraph call, nothing changed by a refused admin call; a positive control per MCP principal (the same caller without the defect gets in). Guards: Hono's route table equals the matrix; every resolver deny reason is covered. |
| `tools.test.ts` | One `TOOL_CASES` entry per built-in tool (guarded against the catalog), run through the HTTP app against `hostileNerdGraph`: foreign account arguments and GUIDs refused before any NerdGraph call, no foreign data in any result, every NerdGraph call names allowed accounts only; a tool outside the grant is not listed, not callable and audited. |
| `isolation.test.ts` | Tool-set caches never cross credentials or account sets and re-check limits on a hit; concurrent requests of two tenants with different keys never mix (T21); interleaved grants each get their own per-request MCP server. |
| `harness.ts` | The seeded world (`addCredential` / `addProject` / `addGrant` / `addToken` for odd states), the app with the admin API and audit recorder, `hostileNerdGraph` (every key also reaches a `FOREIGN` account; list answers mix in foreign and forged rows; single-entity answers lie about the account) and the leak scan run after every test. |

How to extend it is in [CONTRIBUTING](../../CONTRIBUTING.md#testing). The files import no `node:*` module and the harness
runs against a pluggable host (`useAuthzHost`): the HTTP app on in-memory storage by default, the Worker under the
Workers pool (below). Tests that need HTTP app internals (Hono's route table, the admin-off app) skip themselves with
`authzHostKind()`.

## Workers runtime tests

`pnpm test:workers` runs the `worker` project (`apps/worker/test/`) inside **workerd** through
`@cloudflare/vitest-plugin`, with the bindings from `apps/worker/wrangler.jsonc` (local D1, KV and rate-limit
simulators). Test secrets (`RB_MASTER_KEY`, `RB_ADMIN_TOKEN`) are generated per run in `apps/worker/vitest.config.ts`
and passed as Miniflare bindings; nothing is committed. The tests drive the Worker's `fetch` with an MCP SDK client
(`initialize`, `tools/list`, a tool call), check the boot (fail-closed 503s, retry window, one runtime per isolate),
`waitUntil` audit writes and the `CF-Connecting-IP` client address. `pnpm test` includes them; `pnpm test:coverage`
skips them because V8 coverage cannot attach to workerd, so CI runs them as the **Workers runtime tests** job. Most
host tests inject the in-memory storage; `test/entry.test.ts` drives the deployed entry on the local D1 database, and
`test/d1.test.ts` runs the storage contract suite plus D1 concurrency, foreign-key and migration tests against local D1
(P3-02). The local D1 database is shared by a file's tests, so tests that need it empty call `wipeD1`.

**The authorization suite runs against the Worker** (P3-06): `vitest.config.ts` also includes
`packages/http-app/test/authz/*.test.ts` and a setup file (`test/authz-setup.ts`) installs the Worker host
(`test/authz-host.ts`). Each test wipes and migrates local D1, seeds the world under the Worker's `RB_MASTER_KEY`, and
sends every request through `createWorker` (lazy boot, key checks, `waitUntil` audit rows) with the hostile NerdGraph as
its `fetch`. The system time is faked (`Date` only) so `clock.advance` expires tokens and cache entries in the Worker
too; rate limiting is off in this suite (its own tests are in `rate-limit.test.ts`). `test/boot-d1.test.ts` adds
migrations on the first request, the 503 for a wrong `RB_MASTER_KEY`, and a check that the suite really runs on the
Worker host. The suite adds about a minute to the job.

## Worker CPU benchmark

`pnpm bench:cpu` (`scripts/bench-cpu.ts`) runs `apps/worker/bench/cpu.bench.ts` in workerd (config
`apps/worker/vitest.bench.config.ts`; not part of `pnpm test`) and compares the result with
`apps/worker/bench/baseline.json`. Scenarios go through the Worker's `fetch` with local D1 and a mocked NerdGraph: token
verification, access resolution on a cache miss, `initialize`, `tools/list` (cache hit and miss), `whoami`, `run_nrql`
against 10 KB / 100 KB / ~500 KB responses (output shaping included), key decryption and a fresh Worker's first request.
About 30 seconds.

- Timers: local workerd measures CPU with `performance.now()` (production freezes timers), in whole-millisecond ticks,
  so the figure is a trimmed mean over many iterations. D1 scenarios include the simulator's latency.
- Comparison: CI runners vary, so every scenario is judged as a ratio to a fixed `calibration` job measured in the same
  run. It **regresses** only when the ratio is more than 2x the baseline's **and** it is more than 1 ms slower
  (calibrated), so neither tiny scenarios nor 20% drifts fail. `--report` prints the table without failing.
- Refresh after an intended change (quiet machine; commit the file): `pnpm bench:cpu --update`.
- CI: `.github/workflows/bench.yml` (not a required check) runs on pull requests that touch Worker-path code, weekly and
  on demand, and writes the table to the job summary.

## Staging smoke (optional, nightly)

`.github/workflows/staging-smoke.yml` curls a deployed staging Worker (`/health`, `/version`, 401 without credentials,
an admin read) from the protected `staging` environment (variable `STAGING_URL`, secret `STAGING_ADMIN_TOKEN`). It skips
cleanly while those are unset, never deploys and never runs on pull requests.

## Live tests

An optional, read-only suite that calls the real NerdGraph API with your own User key
(`packages/core/test/live/*.live.ts`). It is not part of `pnpm test` or PR CI.

| Variable | Required | Meaning |
|---|---|---|
| `RB_LIVE_API_KEY` | yes | A New Relic **User** key (`NRAK-…`). |
| `RB_LIVE_ACCOUNT_ID` | yes | Account the queries run against. |
| `RB_LIVE_REGION` | no | `US` (default), `EU` or `JP`. |

```sh
RB_LIVE_API_KEY=NRAK-… RB_LIVE_ACCOUNT_ID=1234567 pnpm test:live
```

Without the key and account id every test is skipped. The suite calls only the built-in read-only tools, never prints
the key and checks result text for it.

In GitHub, the manual **Live** workflow (`.github/workflows/live.yml`, `workflow_dispatch` only) runs the same command
from the protected `live` environment, which holds the `RB_LIVE_API_KEY` and `RB_LIVE_ACCOUNT_ID` secrets and the
`RB_LIVE_REGION` variable. It never runs on pull requests, so fork PRs cannot reach the secrets.

## CI runners

Pull-request CI (`ci.yml` except the macOS/Windows SQLite matrix, `security.yml`, `bench.yml`, `e2e.yml`, `zap.yml`, and the
pull-request path of the `docker.yml` `build` job) runs on the organization's self-hosted Linux runners by default:

```yaml
runs-on: ${{ fromJSON(vars.CI_RUNS_ON || '["self-hosted","linux","x64"]') }}
```

If those runners are offline, set the repository (or organization) **variable** `CI_RUNS_ON` to `["ubuntu-latest"]`
(Settings, Secrets and variables, Actions, Variables) and re-run: the same jobs go back to GitHub-hosted runners. Delete
the variable to return to the default. Jobs must not assume preinstalled tools or a recent system userland: they set up
Node (before pnpm: `pnpm/action-setup` runs on the `node` on `PATH`) and pnpm through actions and install anything else
(actionlint, gitleaks) with checksum verification. `harden-runner` only runs on GitHub-hosted runners. `workerd` needs
glibc 2.35+, so the Workers runtime tests and the CPU benchmark run through `scripts/ci-container.sh`, which runs the
pnpm script in a `node:24-bookworm` container (repository copied in with `docker cp`; no bind mounts). The Docker
smoke test (`scripts/docker-smoke.sh`) likewise uses no bind mounts or published ports.

Stay on GitHub-hosted runners, always: `release.yml` (provenance, OIDC), `docker.yml` `plan` / `publish` and release
builds, `scorecard.yml`, `live.yml`, `staging-smoke.yml` (secrets) and the macOS/Windows matrix. `scripts/test/ci-runners.test.ts`
enforces this.

**Public repository warning:** self-hosted runners must only serve a private repository, because a fork pull request
runs its code on them. Before making the repository public, set `CI_RUNS_ON` to hosted runners or restrict fork
pull-request workflows (THREAT_MODEL T18).
