# Phase 1 — pending decisions

Decisions that agents could not make alone during the autonomous run (2026-10-03). Each entry says what was
assumed so work could continue. Review, then answer in place or move the outcome into an ADR / task file.

Format: `### <task id> — <short title>` then **Context**, **Assumption made**, **Options**, **Needs**.

## Workflow

### ALL — stacked PRs instead of merging to `main`
- **Context:** The owner was away. Every task PR targets the previous task's branch (the first one targets
  `phase/1-core-stdio`), so nothing is merged into `main`.
- **Assumption made:** A dependency counts as satisfied when its task is `review` and its branch is lower in the
  stack. Tasks stay `review`, not `done`, until their PRs are merged.
- **Options:** merge the stack bottom-up (retarget each PR to `main` after its parent merges), or squash-merge the
  tip into `main` in one go.
- **Needs:** owner's merge strategy; then mark merged tasks `done` and run `pnpm tasks index`.

## P1-05 — Output shaping

### P1-05 — Envelope everything vs only free-text fields
- **Context:** The task says to envelope telemetry fields such as log and error messages. Any NRQL attribute can carry
  attacker-written text, and we can't reliably tell which columns are free text.
- **Assumption made:** Every rendered data block (all rows, plus NRQL totals) goes inside one envelope per result.
  Cost: about 60 tokens per result. `untrusted: false` exists only for values relic-bridge generates itself.
- **Options:** keep (safest); envelope only known free-text attributes (cheaper, easy to miss one); make it a
  connection setting.
- **Needs:** owner's confirmation.

### P1-05 — Redacting secret-shaped values in telemetry rows
- **Context:** Log lines sometimes contain keys or `password=…`. The central `redact()` (T8) can scrub them before they
  reach the agent transcript, but it also changes data the user might want to see verbatim.
- **Assumption made:** Redaction on by default for rows and structured content (`redactSecrets: true`); tools can turn
  it off per call site, but no tool input exposes that switch.
- **Options:** keep on by default; make it a connection setting (P2); off by default.
- **Needs:** owner's preference.

### P1-05 — Default caps
- **Context:** No measured token budget yet (P7-01 evaluates large results).
- **Assumption made:** 100 rows, 300 characters per value, 24 000 characters per data block, 50 columns; `auto`
  renders a table up to 8 columns, CSV above. Hard maximums 1000 / 4000 / 100 000 / 200.
- **Options:** tune after P1-12 evals or real usage.
- **Needs:** nothing now; revisit with data.

## P1-06 — Query tools

### P1-06 — `run_nrql` still listed when raw NRQL is off
- **Context:** The task says the tool is disabled when `rawNrql=false`. ARCHITECTURE prefers tools a caller may not
  use to be absent from `tools/list`. Phase 1 has no grant resolution yet that feeds limits into `ToolRegistry.select`.
- **Assumption made:** `run_nrql` and `get_query_result` stay listed and fail with `RB_TOOL_DISABLED` plus a hint to
  use purpose-built tools. No request reaches New Relic.
- **Options:** keep; filter in the stdio CLI (P1-11) when its config sets `rawNrql: false`; filter centrally in the
  Phase 2 grant resolution (P2-xx).
- **Needs:** owner's preference on where the filter lives; nothing blocks Phase 1.

### P1-06 — Polling behaviour of `run_nrql`
- **Context:** The engine supports `sync`, `async` and `auto` modes. Agents only see `timeout_s`.
- **Assumption made:** `run_nrql` always uses `auto`: wait up to `timeout_s` (default 10 s), then poll up to 3 times
  within budget (waits capped at 10 s each) before handing back a `query_id`. Worst case is roughly `timeout_s` + 30 s
  per call.
- **Options:** keep; expose a `wait` / `mode` input; return the handle right after `timeout_s` (no polling).
- **Needs:** nothing now; revisit after P1-12 evals or real usage.

## P1-07 — Identity, accounts and time tools

### P1-07 — `RegionScope` value and `ToolContext.connection`
- **Context:** `Actor.accounts` takes `scope: RegionScope`; P0-09 confirmed the argument but not a live call with it.
  `whoami` also needs the project slug and granted tools, which Phase 1 context doesn't carry.
- **Assumption made:** pass `IN_REGION` (the key's own data center) as a variable `$scope: RegionScope!`; add an
  optional `ToolContext.connection { project?, allowedTools? }` that P1-11 / Phase 2 fill in (absent shows "unknown").
  The enum value is from the NerdGraph schema as remembered, not yet verified against a live account.
- **Options:** `GLOBAL` (accounts in every region); verify live with the P0-09 spike profile.
- **Needs:** one live check of `IN_REGION` when a key is at hand; swap the `ACCOUNT_SCOPE` constant if rejected.

### P1-07 — `time_range` semantics
- **Context:** the task didn't fix the grammar, time zone or clause format.
- **Assumption made:** UTC only; weeks start Monday; "last week/month" are rolling 7/30 days while "this/previous
  week/month" are calendar periods; date-only range ends include the whole day. Relative input yields NRQL
  `SINCE n units ago`; absolute input yields `SINCE <epoch seconds> UNTIL <epoch seconds>` (epoch seconds are
  documented NRQL; the clause is accepted by our own limits parser but not yet run live).
- **Options:** add a `timezone` input; use ISO string literals in the clause; calendar meaning for "last week".
- **Needs:** nothing now; revisit after P1-12 evals.

### P1-07 — `whoami` email default
- **Assumption made:** email shown unmasked unless `mask_email: true` (it is the connection owner's own address and the
  tool exists for debugging). Names and email are enveloped as untrusted data.
- **Options:** mask by default; drop the email.
- **Needs:** owner's preference.


## P1-08 — Entity tools

### P1-08 — Unverified entity-search details
- **Context:** P0-09 measured quoting (`\'`) and `accountId = '…'`, but not `accountId IN (…)`, `options.limit`
  semantics, `relatedEntities(filter:)` or `entitySearch.types` against a live account (the probed account had no APM
  entities).
- **Assumption made:** every search carries `accountId IN ('<id>', …)` (quoted, like the probe), passes
  `options: { limit }` and `results(cursor:)`; related entities use `EntityRelationshipEdgeFilter { direction,
  entityDomainTypes { include } }` from the introspected schema; the type catalogue reads `entitySearch.types`.
  Results are filtered by `accountId` client-side regardless, so a wrong guess can only hide entities, never leak them.
- **Options:** verify with the P0-09 spike profile; switch to unquoted ids or one search per account if `IN` is rejected.
- **Needs:** one live run against an account with APM entities.

### P1-08 — Tag keys and name matching
- **Assumption made:** tag-key filters accept only `[A-Za-z0-9_.]` (bare `tags.<key>`), because backtick quoting inside
  entity search is undocumented; keys like `team-name` are refused with a hint. `name` is a substring match
  (`LIKE '%…%'`) and a `%` typed by the agent stays a wildcard (no documented escape; it can't end the literal).
- **Options:** probe backtick quoting live and widen the charset; offer an exact-name option.
- **Needs:** nothing now.

### P1-08 — `list_entity_types` cache scope
- **Context:** the task asks for a per-isolate cache; AGENTS.md forbids module-level request state (T21).
- **Assumption made:** a bounded map (64 entries, 10-minute TTL) held by each `createEntityTools()` instance (not module
  state), keyed by credential id + region + sorted account set, so one credential or grant never sees another's
  catalogue. It stores only domain/type names and counts.
- **Options:** keep; move to the Phase 7 cache layer; drop caching (one subrequest per call).
- **Needs:** owner's confirmation when the Worker shares tool instances across tenants (Phase 3).

### P1-09 — Golden metrics run when raw NRQL is off
- **Context:** golden-metric NRQL is supplied by New Relic, but `run_nrql`'s `rawNrql` switch exists to stop agent-written NRQL.
- **Assumption made:** `get_golden_metrics` is not gated by `rawNrql` (new `runTrustedNrql` engine entry point); query limits still apply.
- **Options:** keep; gate the tool on `rawNrql` as well; add its own grant in Phase 2.
- **Needs:** owner's call once per-tool grants exist (Phase 2).

### P1-09 — Trend definition and defaults
- **Assumption made:** window default "last 30 minutes" with `TIMESERIES AUTO`; trend compares the mean of the later half of the series with the earlier half (flat within +/-5%, at least 4 points); faceted metrics get a value-less row pointing to `run_nrql`. Metrics with their own SINCE/TIMESERIES keep them. At most 10 metrics by default (max 20); the `title`/`query` fields are the only ones selected (`unit` unverified live).
- **Options:** other thresholds or a `COMPARE WITH` baseline; select `unit` once checked against the live schema.
- **Needs:** one live run against an APM entity.

### P1-10 — Schema tools not gated by `rawNrql`; defaults; no counts
- **Context:** `list_event_types` / `get_attributes` run server-built NRQL (the `nrql` tag), not agent-written NRQL.
- **Assumption made:** not gated by `rawNrql` (query limits and event-type allow/deny still apply). Default window "last 24 hours", 5-minute per-instance cache. With an event-type allow list `list_event_types` returns the list without querying; deny lists are filtered from the output. The optional per-type counts in the original scope were dropped (one query per type; use `run_nrql`). Exact NRQL result shapes of `keyset()` (`key`/`type` rows; older key-list form also parsed) are unverified live.
- **Options:** gate on `rawNrql`; longer default window; add counts as a separate task.
- **Needs:** one live run against an account with APM data.


### P1-11 — CLI packaging, config discovery and stdio defaults
- **Context:** first runnable entry point; several product choices weren't fixed by the task.
- **Assumption made:**
  - npm package and bin `relic-bridge` (as already in `apps/cli/package.json`); bin-only bundle `dist/index.mjs` with
    `@relic-bridge/core` **bundled from source** (core is not published separately for v0.1); runtime deps are the MCP
    SDK, zod and yaml.
  - No config auto-discovery: YAML mode only with `--config` / `RB_CONFIG` (no implicit `./relic-bridge.yaml` or
    `~/.config/relic-bridge/`). Keys only from env (`${VAR}` in YAML); no keychain source yet.
  - Env mode adds `RB_ACCOUNTS` (extra allowed accounts). In YAML mode `RB_*` / `NEW_RELIC_*` are ignored except as
    `${VAR}` targets. A plaintext `apiKey` is allowed with a warning (not refused).
  - Budget 1000 NerdGraph calls per tool call in stdio (ADR-0010 "paid" figure), concurrency 5 per process.
  - With `rawNrql: false` the stdio CLI does not register `run_nrql` / `get_query_result` (answers the P1-06 entry for
    stdio; HTTP still needs the same filter in Phase 2 grant resolution).
  - Test hook `RB_TEST_NERDGRAPH_URL` is compiled in only with `RB_TEST_HOOKS=1` at build time; the default `pnpm build`
    is the release build. P1-15 must publish the default build.
  - Claude Code compatibility verified with the SDK stdio client (same transport) and `claude mcp add --env` syntax
    checked against `claude mcp add --help`; not yet run against a live key.
- **Options:** auto-discover a config file; refuse plaintext keys; publish `@relic-bridge/core` as a library; keychain
  support (macOS Keychain / libsecret) as a later task.
- **Needs:** owner's confirmation; one live `claude mcp add` run with a real key.

### P1-12 — Test harness: injected fetch instead of msw; live suite and `live` environment
- **Context:** the task named msw and a protected live environment; the core is web-standard and already tests via an injected `fetch` (P1-02).
- **Assumption made:**
  - No msw dependency; `scriptedFetch` / `mockNerdGraph()` replay sanitized fixtures. Coverage gate on `packages/core/src`: 85% lines/statements/functions, 75% branches (actual ~97/90), enforced by `pnpm test:coverage` in CI (adds `@vitest/coverage-v8`).
  - Live suite in `packages/core/test/live/*.live.ts` (excluded from `pnpm test`), env `RB_LIVE_API_KEY`, `RB_LIVE_ACCOUNT_ID`, `RB_LIVE_REGION`; manual-only `.github/workflows/live.yml` using a GitHub environment named `live`.
- **Options:** adopt msw later for the HTTP app (Phase 2); raise thresholds; run live nightly.
- **Needs:** owner to create the `live` environment (required reviewers) with the secrets, and **one manual `pnpm test:live` run with a real key**: the live suite has never been executed.

### P1-13 — Generated tool reference: scope and shape
- **Context:** the task asked for a generated `docs/reference/tools.md` and a CI staleness check.
- **Assumption made:**
  - Generator is `scripts/gen-tool-docs.ts` (imports core source directly), checked by `pnpm lint` via `pnpm docs:tools --check`; core now exports `outputJsonSchema` next to `inputJsonSchema`.
  - Only top-level input/output fields are tabulated (nested shapes shown as `object` / `object[]`); no config-file reference generated.
- **Options:** nested field rendering; generate the CLI config reference from `configFileSchema`; publish the reference on the docs site (P8-04).
- **Needs:** nothing urgent; owner may request a config-reference task.

### P1-14 — Client guides: one page, unverified clients, no generated config reference
- **Context:** the task asked for per-client guides, a config reference "generated if feasible", and a dry-run by a fresh agent session.
- **Assumption made:**
  - One `docs/guide/clients.md` covers Claude Code, Claude Desktop, Cursor, VS Code and MCP Inspector; the config reference stays hand-written (`configuration.md`).
  - Desktop/Cursor/VS Code config shapes follow each client's documentation from memory/Context7 and were not run; commands in the docs are shown with `npx -y relic-bridge`, with a pre-release note to use `node …/apps/cli/dist/index.mjs`. P1-15 must remove that note once v0.1 is on npm.
  - `docs/guide/*.md` messages and error codes were checked against source; `RB_LIMIT_RATE` is intentionally not documented (unused in code).
- **Options:** generate the config reference from `configFileSchema`; add per-client screenshots; add Windsurf/Zed guides.
- **Needs:** owner to run the quickstart once with a real key in at least Claude Code and one JSON-config client, and fix any drift.

### P1-15 — Release pipeline built, nothing published (owner actions required)
- **Context:** the pipeline and the v0.1.0 bump are ready, but publishing needs npm and repository settings only the
  owner can change. No tag, GitHub Release or npm version was created; no secrets or settings were touched.
- **Assumption made:**
  - Only `relic-bridge` (`apps/cli`) is published; all `packages/*` are now `"private": true` (core stays bundled).
    Changesets `privatePackages: { version: false, tag: false }`.
  - v0.1.0 was versioned locally (`pnpm version-packages`: `apps/cli/package.json` 0.1.0, `apps/cli/CHANGELOG.md`,
    core `VERSION`), so after merge to `main` the workflow plans **publish** directly (no version PR for 0.1.0).
  - Publish is gated three ways: `main` only, repository variable `RB_RELEASE_ENABLED == 'true'`, and the protected
    `release` environment. Tag `v<version>` and the GitHub Release are created by the publish job (`gh release create`).
  - Release artifacts: npm tarball, CycloneDX SBOM (`pnpm sbom`), `SHA256SUMS`, Sigstore provenance + SBOM attestations.
  - Local dry-run (2026-10-03): `pnpm pack` → 5 files (`LICENSE`, `NOTICE`, `README.md`, `dist/index.mjs`,
    `package.json`), 56.9 kB; `npm publish <tgz> --dry-run` and `pnpm publish --dry-run` pass;
    `npx --package <tgz> relic-bridge --version` prints `0.1.0`; packed build refuses `RB_TEST_NERDGRAPH_URL`; a
    `RB_TEST_HOOKS=1` build is caught by `scripts/check-package.ts`.
  - The version PR is created with `GITHUB_TOKEN`, so GitHub does not run CI on it automatically (close/reopen it, or
    give the job a GitHub App token later).
- **Options:** environment approval (current) vs npm **staged publishing** (`npm stage publish`, approve with 2FA on
  npmjs.com) or both; publish `@relic-bridge/core` as a library later (needs its own build and a new task).
- **Needs (owner, in order):**
  1. Merge the stack into `main` (the release workflow only runs there).
  2. Make the repository public before the first release (attestations in private repos need GitHub Enterprise; npm
     provenance links to a public source repo).
  3. npm: on `relic-bridge` → *Settings → Trusted publisher*, add GitHub Actions `matiashidalgo/relic-bridge`, workflow
     `release.yml`, environment `release` (or `npm trust github relic-bridge --file release.yml --env release
     --allow-publish`). Then set *Publishing access* to "Require 2FA and disallow tokens".
  4. GitHub: create environment `release` with a required reviewer (you), deployment branches limited to `main`; enable
     *Settings → Actions → Allow GitHub Actions to create and approve pull requests* (version PRs); add a tag ruleset
     protecting `v*` (only the release workflow / admins create them).
  5. Set repository variable `RB_RELEASE_ENABLED=true`, push/merge to `main` (or run the workflow manually on `main`),
     approve the `release` deployment, and check the npm page shows the provenance badge
     (`npm audit signatures`, `gh attestation verify relic-bridge-0.1.0.tgz --repo matiashidalgo/relic-bridge`).
  6. Smoke test on macOS, Windows and Linux: `npx -y relic-bridge --version`, then the quickstart with a real key.
  7. After it is live: remove the pre-release notes in `docs/guide/quickstart-local.md`, `docs/guide/clients.md`
     and the root `README.md` Install section, tick the last P1-15 criterion and mark it `done`.

## Phase 1 consolidation review

### P1-review — Broader secret redaction in telemetry rows
- **Context:** The review widened `redact()` (any `Authorization` scheme, `DB_PASSWORD=`, `client_secret=`,
  `*token=` …). It runs on logs, errors **and** telemetry rows shown to the agent, so a log line such as
  `input_token=42` now shows `input_token=[REDACTED]`.
- **Assumption made:** over-redaction is the safer default (consistent with the P1-05 "redaction on" assumption).
- **Options:** keep; narrower patterns for telemetry rows than for our own logs; connection setting (P2).
- **Needs:** owner's confirmation.

### P1-review — Release must not ship before P1-16
- **Context:** the publish job gives `id-token: write` to a job that also runs `pnpm install` and the test suite,
  so a compromised dependency could mint the trusted-publishing token.
- **Assumption made:** P1-16 (split build/publish jobs) is `priority: high` and should land before step 5 of the
  P1-15 owner list (`RB_RELEASE_ENABLED=true`).
- **Options:** do P1-16 first (recommended); publish v0.1.0 now with the environment approval as the only guard.
- **Needs:** owner's call.

### P1-review — `live` environment branch rule
- **Context:** `live.yml` is `workflow_dispatch` only; dispatching it from a feature branch runs that branch's test
  code with `RB_LIVE_API_KEY` unless the `live` environment limits deployment branches.
- **Assumption made:** none in code; add to the owner set-up list.
- **Needs:** owner: when creating the `live` environment (P1-12 entry), restrict deployment branches to `main` and
  require a reviewer.

## P1-16 — Release publish isolation

### P1-16 — Split build/publish jobs and idempotent reruns (owner steps unchanged, a few assumptions)
- **Context:** P1-16 moved everything that installs or runs code into a `build` job (`contents: read`, no OIDC) and
  left a minimal `publish` job (environment `release`, `id-token: write`) that only verifies, attests, publishes and
  creates the GitHub Release. `plan` now also returns `release` (version on npm, no GitHub Release) and fails on a
  `v<version>` tag that points at another commit. Nothing was published, tagged or configured.
- **Assumption made:**
  - The npm trusted-publisher entry from the P1-15 list stays valid: workflow `release.yml`, environment `release`
    (the OIDC token now comes from the `publish` job, which keeps that environment).
  - The release build is reproducible: a rerun repacks the tarball and skips `npm publish` only if it is
    byte-identical to `dist.integrity` on npm (verified locally: two builds gave the same SHA-256). If it ever differs,
    the run stops and the GitHub Release must be created by hand from the published tarball.
  - `build` is not behind the environment, so it runs (tests, pack, artifact upload with 7-day retention) as soon as
    `plan` says `publish`/`release`; only `publish` waits for approval.
  - A leftover **draft** release `v<version>` makes `publish` stop with an error instead of reusing it.
- **Options:** keep; put `build` behind the environment too (approval before tests run, slower feedback); in
  `release` mode attach the tarball downloaded from npm instead of a rebuilt one (no reproducibility requirement,
  but the asset would not be attested as built by this run).
- **Needs:** owner's confirmation. P1-16 closes the blocker in "P1-review — Release must not ship before P1-16" once
  merged; the P1-15 owner steps then apply unchanged.
