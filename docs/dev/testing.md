# Testing

`pnpm test` runs the unit, integration and E2E suites offline (mock NerdGraph). `pnpm lint`, `pnpm typecheck` and
`pnpm build` must also pass before a PR.

Tool descriptions have their own lint, eval set and offline router baseline inside `pnpm test`, plus an optional
model-in-the-loop eval (`pnpm eval:tools`): see [evals.md](evals.md).

Write tools are never exercised by the offline suites against real New Relic. Their live check against a sandbox account
is in [write-tools-sandbox-test.md](write-tools-sandbox-test.md). Other checks a release verification run does by hand
(an async NRQL handle through `get_query_result`, reconnecting clients after an upgrade) are in
[verification-guide.md](verification-guide.md).

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

## Property and fuzz tests

The parsers and builders that take untrusted input have [fast-check](https://fast-check.dev/) properties in
`fuzz*.test.ts` files (P8-01, THREAT_MODEL section 4a), next to the property tests of the original tasks:

| File | Targets |
|---|---|
| `packages/core/test/fuzz.test.ts` | `nrql` tag and `nrql.identifier()` (no breakout in any template position, literals and identifiers decode back), `entityQuery` and `entityQuery.and()`, `enforceQueryLimits` and the tokenizer on arbitrary text, entity GUID decoding, `time_range` parsing. |
| `packages/auth/test/fuzz.test.ts` | `Authorization: Bearer` and `rb_` token parsing, session cookies, PKCE S256, `RB_MASTER_KEY`, identity settings and `RB_PUBLIC_URL`. |
| `packages/http-app/test/fuzz.test.ts` | OAuth redirect URIs, registration bodies, metadata documents, client ids, display names, IP classification for the metadata fetch guard, post-login redirects, client addresses, Host / Origin / MCP headers, the JSON-RPC body peek and its size bound, OTLP and OAuth settings. |
| `packages/http-app/test/fuzz-http.test.ts` | Requests on the authz harness: mutated OAuth authorize and token requests, registration bodies, MCP POST bodies of any shape and size, with and without credentials. |
| `apps/cli/test/fuzz.test.ts`, `apps/worker/test/fuzz-settings.test.ts` | `serve` and Worker settings from `RB_*` variables (protections stay on unless switched off exactly), stdio settings, the YAML file and the command line (no secret in an error). |

`pnpm test` runs each property a bounded number of times (a few seconds per file). For a longer local run set the number
of runs per property, and replay a counterexample with the seed fast-check prints:

```sh
RB_FUZZ_RUNS=100000 pnpm vitest run fuzz
RB_FUZZ_RUNS=100000 RB_FUZZ_SEED=-1234567 pnpm vitest run packages/core/test/fuzz.test.ts
```

The settings are read in `packages/core/test/helpers/fuzz.ts` (`fuzzParams`, `FUZZ_TIMEOUT`); inside workerd the
variables are not visible and the bounded default applies. A new parser of untrusted input gets a property there.

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

## Per-tool overhead and cost benchmark

`pnpm bench` (`scripts/bench-tools.ts`) measures every built-in tool against the recorded-fixture NerdGraph mock, on Node
and in workerd (`apps/worker/bench/tools.bench.ts`, same project config as `pnpm bench:cpu`), and prints a Markdown table:
relic-bridge's own time per call (wall time minus the time inside the mock request, p50 and p95), NerdGraph requests per
call against the declared cost, and response bytes. The harness (`scripts/bench/tools-harness.ts`) is runtime-neutral and
reuses the contract tests' sample arguments and mock; `--node` skips workerd; `--samples N`, `--out file.md` and `--host-label "<text>"` (the machine description in the
header; the CPU model is never detected) are available. It is manual (not a CI check, no baseline): the table in `docs/guide/cloudflare-limits.md` is a snapshot
labelled with machine, versions and date, to be regenerated when tools or the call path change a lot.

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

## NerdGraph schema check

Every static GraphQL document (`defineDocument`) is validated with the `graphql` package against a committed
introspection snapshot, `scripts/fixtures/nerdgraph-schema.json.gz`, in `pnpm test`
(`scripts/test/nerdgraph-documents.test.ts`). It catches stale or misspelt fields, wrong arguments and wrong variable
types before they reach a live account (BUG-02 of the live test run 2026-10-12). A guard in the same test fails if a
document is defined somewhere the check cannot see it (define documents at module level).

Generate or refresh the snapshot with your own User key (it is read from the environment only, never printed or
written, and sent only to the NerdGraph endpoint):

```sh
RB_LIVE_API_KEY=NRAK-… pnpm nerdgraph:schema        # RB_LIVE_REGION=US (default), EU or JP
```

Commit the resulting file. Until a snapshot exists the check is skipped with a message; once it is present the check
fails on any invalid document. Refresh it when New Relic changes the schema or when a document starts failing live.
The snapshot is loaded with graphql-js `assumeValid`: NerdGraph's own schema breaks one type-system rule (a deprecated
implementation field whose interface field is not deprecated), so only our documents are validated, not New Relic's
schema.

## CI runners

All CI runs on GitHub-hosted runners (`runs-on: ubuntu-latest`, plus the macOS/Windows SQLite matrix in `ci.yml`).
There is no self-hosted runner support and no runner-selection variable (P8-64): the repository is public, so a
`runs-on` fallback to self-hosted runners would run fork pull-request code on them if the variable were ever unset.
`scripts/test/ci-runners.test.ts` fails if a workflow uses a self-hosted label or `vars.CI_RUNS_ON`.

Every Linux job starts with `step-security/harden-runner`, unconditionally. Jobs set up Node (before pnpm:
`pnpm/action-setup` runs on the `node` on `PATH`) and pnpm through actions and install anything else (actionlint,
gitleaks) with a sha256 pinned in the workflow. `workerd` needs glibc 2.35+, so the Workers runtime tests and the CPU
benchmark run through `scripts/ci-container.sh`, which runs the pnpm script in a `node:24-bookworm` container
(repository copied in with `docker cp`; no bind mounts). The Docker smoke test (`scripts/docker-smoke.sh`) likewise uses
no bind mounts or published ports.

**Scheduled workflows** (default branch only, plus `workflow_dispatch`; never pull requests or pushes; none is a required
check and none uses secrets):

| Workflow | Schedule (UTC) | Runner |
|---|---|---|
| `zap.yml` Admin ZAP baseline | Mondays 04:17 | GitHub-hosted `ubuntu-latest` |
| `e2e.yml` Admin browser E2E | Mondays 04:47 | GitHub-hosted `ubuntu-latest` |

`zap.yml` is pinned to `ubuntu-latest`: the scan runs ZAP in Docker on the host network with a bind-mounted report
directory, which needs the Docker daemon on the same machine as the job. Scheduled and manually dispatched runs only
happen once the workflow files are on the default branch.

