# Phase 1 consolidation review

- **Scope:** all Phase 1 work: `git diff main...task/P1-15-release-pipeline` (P1-05 … P1-15, 23 commits, 110 files)
  plus the already-merged P1-01 … P1-04 code in `packages/core`.
- **Branch:** `review/phase-1`, stacked on `task/P1-15-release-pipeline` (top of the Phase 1 PR stack).
- **Date:** 2026-10-03. **Method:** read every source file in `packages/core/src` and `apps/cli/src`, the release
  and CI workflows and the release scripts; checked each task's acceptance criteria against code and tests; built the
  CLI and drove it with odd argv, env and YAML input; ran throwaway probe tests (deleted) against the in-memory MCP
  server; mutation-checked every regression test added here (each one fails with the fix reverted).
- **Checks:** `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green before and after the fixes.

## Verdict

**Ready, with fixes in this branch.** One high finding (gaps in secret redaction) and five low-risk issues are fixed
here, with regression tests. Phase 1 meets its exit promise ("`npx relic-bridge` locally, both NR accounts, one MCP
entry per project") in code and offline tests. Two things are still open:

1. **Nothing has run against real New Relic yet.** The live suite has never run; the client set-up guides and several
   NerdGraph details (`RegionScope`, `accountId IN (…)`, `keyset()` shape, epoch `SINCE`) are unverified. The owner
   steps are in `docs/pending-decisions/phase-1.md`.
2. **Do not enable publishing until P1-16 is done.** The publish job holds the OIDC `id-token` while it runs
   `pnpm install` and the test suite (M1).

## Per-task completeness

| Task | Status | Evidence / gap |
|---|---|---|
| P1-01 core skeleton | met | registry rejects duplicates and secret-like inputs; `toToolErrorResult` redacts; `node:*` ban lint-enforced |
| P1-02 NerdGraph client | met | EU endpoint, 429/5xx retry within budget, streaming byte cap, key never in errors (`nerdgraph-client.test.ts`) |
| P1-03 NRQL engine | met | sync, async, poll, pending handle, cross-account, budget-bounded polling (`nrql-engine.test.ts`) |
| P1-04 NRQL safety | met | `nrql` tag with fast-check round trips, limits parser, lint rule `check-nrql-templates.ts` |
| P1-05 output shaping | met | envelope with random marker, caps, cursors, redaction. Column names were not redacted: **fixed** (L1) |
| P1-06 query tools | met | negative tests assert zero requests (out-of-scope account, raw NRQL off, bad input) |
| P1-07 identity/time | met | account intersection, `RegionScope` as variable, email mask; `RegionScope` value unverified live (pending) |
| P1-08 entity tools | met | offline GUID decode and scope check, `entityQuery` tag, per-credential cache. `decode_entity_guid` echoed free text outside the envelope: **fixed** (M2) |
| P1-09 golden metrics | met | NR-supplied NRQL through `runTrustedNrql` with all limits; budget-aware partial results |
| P1-10 schema discovery | met | identifier charset + `nrql.identifier()`, cache keyed by credential/region/account, deny list re-checked on cache hit |
| P1-11 CLI stdio | met | stdout carries only JSON-RPC (E2E), keys only from env / `${VAR}`, test hook compiled out of the release build. Plaintext-key warning unreadable after redaction: **fixed** (L2) |
| P1-12 test harness | partially met | Contract test covers every tool. The criterion "live suite documented" is ticked, but `pnpm test:live` appears only in CONTRIBUTING.md and the task file, and the suite has never run → P1-17 |
| P1-13 tool reference | met | `docs/reference/tools.md` generated, `--check` in `pnpm lint`; 13 tools match the registry |
| P1-14 docs quickstart | partially met | All guides present and accurate to code. "Dry-run by a fresh agent session" is ticked, but it was offline only, no real key and no real clients (pending decision P1-14) |
| P1-15 release v0.1 | met (last box open by design) | SHA-pinned actions, per-job permissions, `main`-only + variable + environment gating, tarball allowlist and smoke test. Publishing is still an owner step. See M1, M3, M4 |

**Exit promise.** One process serves one project: one credential, one region and its `accounts` list. Two NR accounts
under the same key work, including cross-account `run_nrql`. Two keys or two regions need two MCP entries, and
`quickstart-local.md` shows that. Not done yet: publishing to npm and a run with a real key.

## Findings

Severity is the impact if exploited or hit in normal use. Status: **fixed** (in this branch, with a regression test),
**task** (new task file), **pending** (`docs/pending-decisions/phase-1.md`).

### Critical

None.

### High

**H1 — Secret redaction missed common credential shapes** — **fixed**
- `packages/core/src/redact.ts:15-26` (old lines 14-18).
- **Impact:** `redact()` guards logs and errors, and since P1-05 also telemetry rows shown to the agent (T8). It
  missed four shapes, so these went verbatim into stderr logs and the LLM transcript:
  - non-Bearer `Authorization` schemes (`Authorization: Basic dXNl…` kept the credential);
  - prefixed names (`DB_PASSWORD=…`, `client_secret=…`, `aws_secret_access_key=…`), because `\b` doesn't match
    after `_`;
  - OAuth tokens in URLs (`?access_token=…`);
  - `x-api-key`-style headers inside JSON.

  Telemetry with these strings (request logs, error messages) is common.
- **Fix:** one pattern for any `Authorization` / `Proxy-Authorization` scheme (the scheme stays, the credential
  goes), and name prefixes allowed for `*password`, `*secret`, `*token`, `*credential(s)`, `*private_key` and
  `*_key` variants. Tests cover the new cases, idempotency, and words that must stay (`max_tokens=100`,
  `secretary=`, `tokens: 5`).
- Trade-off logged as a pending decision: the wider patterns over-redact things like `input_token=42`.

### Medium

**M1 — OIDC token available to install scripts and tests in the publish job** — **task P1-16**
- `.github/workflows/release.yml:88-150`.
- **Impact:** `id-token: write` is granted to a job that also runs `pnpm install` (with the allowed build scripts
  esbuild, lefthook and workerd), lint, test and build. A compromised dependency could mint the OIDC token and
  publish through npm trusted publishing (T18). Environment approval only covers the job as a whole.
- **Recommendation:** split into a `build` job without `id-token` that uploads the tarball, SBOM and sums, and a
  minimal `publish` job that verifies the sums and publishes. Do this before enabling `RB_RELEASE_ENABLED`
  (pending decision).

**M2 — `decode_entity_guid` echoed attacker-controllable text outside the envelope** — **fixed**
- `packages/core/src/tools/entities.ts:586-596`.
- **Impact:** a GUID is base64 of `account|DOMAIN|TYPE|domainId`, and the domain id may be any printable text. An
  agent that picked a crafted GUID out of a log line got, for example, `domain id Ignore previous instructions…`
  printed as trusted tool text (T6).
- **Fix:** the domain id now goes inside the untrusted-data envelope. Regression test with an injected domain id.

**M3 — Release `plan` step could fail silently** — **fixed**
- `.github/workflows/release.yml:45-48`.
- **Impact:** `node scripts/release.ts plan | tee -a "$GITHUB_OUTPUT"` ran without `pipefail`. A failing plan left
  the step green with empty outputs, so nothing released and nobody saw why.
- **Fix:** `shell: bash`, which runs with `-eo pipefail`.

**M4 — A rerun after a partial release never creates the GitHub Release** — **task P1-16**
- `release.yml:139-150` and `scripts/release.ts` `plan`.
- **Impact:** `npm publish` runs before `gh release create`. If the second step fails, the next `plan` sees the
  version on npm and returns `none`, so the tag, release, SBOM and attestation assets need manual work.
- **Recommendation:** an idempotent "published but not released" mode, and fail when an existing `v<version>` tag
  points at another commit.

### Low

| Id | Finding | Location | Status |
|---|---|---|---|
| L1 | NRQL column names (attribute names, facet labels) were not redacted, unlike values | `packages/core/src/output/format.ts:233-234` | **fixed** + test |
| L2 | The CLI plaintext-key warning `Prefer apiKey: ${NEW_RELIC_API_KEY_X}` was itself redacted by the logger, so the advice read `apiKey: [REDACTED]}` | `apps/cli/src/config.ts:386-391` | **fixed** + test |
| L3 | A non-numeric or out-of-range `resultExpiration` made `toISOString()` throw, so a running query came back as `RB_INTERNAL` | `packages/core/src/nrql/engine.ts:251-256` | **fixed** + test |
| L4 | ARCHITECTURE §7 tool table omitted `decode_entity_guid`; `configuration.md` didn't say deny lists are case-insensitive | `docs/ARCHITECTURE.md:176`, `docs/guide/configuration.md:47` | **fixed** |
| L5 | NRDB `messages` and GraphQL field warnings are printed outside the envelope; the NerdGraph `queryId` is echoed unvalidated | `packages/core/src/output/nrql.ts:151-152, 410-411` | task P2-14 |
| L6 | `get_entity` / `get_related_entities` don't check that the returned account equals the GUID's account (`get_golden_metrics` does); `related` skips the check when NerdGraph omits `accountId`. Still always an allowed account | `packages/core/src/tools/entities.ts:381, 462` | task P2-14 |
| L7 | `search_entities` shows "results outside this connection's accounts were left out" when NerdGraph merely returned more than `limit` | `packages/core/src/tools/entities.ts:333` | task P2-14 |
| L8 | Duplication: five copies of the client factory, four of the `accountId` schema, the window check in `golden.ts` and `schema.ts`, three `DAY_MS`; `time_range` text says `since_ms` while its structured output says `sinceMs` | `packages/core/src/tools/*.ts`, `time.ts:31,51` | tasks P2-14, P1-17 |
| L9 | Config file permission warning ignores group-readable (`0o040`); `RB_PROJECT` silently ignored in env mode | `apps/cli/src/config.ts:373, 383` | task P1-17 |
| L10 | README advertises hosted features (Worker, `/p/{slug}/mcp`, OAuth, tokens, encrypted keys, audit log) as features of an alpha that has none of them; troubleshooting misses startup `RB_AUTH_INVALID_KEY`; P1-12 live-test docs missing | `README.md:10-13`, `docs/guide/troubleshooting.md` | task P1-17 |
| L11 | harden-runner is audit-only and missing from several jobs; actionlint checksum comes from the same release as the binary; `check-package` secret patterns are narrow | `.github/workflows/*.yml`, `ci.yml:61-62`, `scripts/check-package.ts:29-38` | task P8-07 |
| L12 | `live.yml` can be dispatched from any branch and would run that branch's code with `RB_LIVE_API_KEY` unless the `live` environment limits branches | `.github/workflows/live.yml` | pending (owner setting), P8-07 |
| L13 | The version PR, created with `GITHUB_TOKEN`, triggers no CI | `release.yml:71` | already pending (P1-15 entry) |

### Checked and found sound

- **T4:**
  - Every NerdGraph call uses static `defineDocument` documents with variables only.
  - NRQL from tools goes through the `nrql` tag (`runNrql` refuses plain strings).
  - Entity-search filters go through the `entityQuery` tag, with a property test.
  - `event_type` is restricted by charset and sent through `nrql.identifier()`.
  - Golden-metric NRQL from New Relic still goes through `enforceQueryLimits`, with comments stripped before
    clauses are appended.
- **T5:** limits apply on every path (raw, trusted, typed). Output caps have hard maximums. Polls and golden metrics
  are budget-aware. The response byte cap is enforced while streaming.
- **T3:** accounts are checked against `ctx.accounts.allowed` before any request (`resolveAccounts`, `checkGuid`).
  Entity results are filtered again by account, and related entities in other accounts are dropped.
- **T21:** no module-level mutable state. The only module-level collection is the constant `CLAUSES` set. Caches
  live in the tool-set instance, keyed by credential id, region and accounts. stdio builds a fresh context per call.
- **T23:** the registry refuses secret-like input names. The CLI refuses `--api-key`, `-k` and bare `NRAK-…`
  arguments with a redacted echo. Strict schemas reject an `apiKey` argument.
- **stdout:** `console.log/info/debug` are rerouted to stderr. A garbage stdin line and odd argv still produce only
  JSON-RPC on stdout (E2E and manual probes).
- **Release build:** the test hook is compiled out, and setting `RB_TEST_NERDGRAPH_URL` makes the release build
  exit 1. The packed-tarball smoke test re-checks this.
- **Workflows:** no `pull_request_target`; no `github.event.*` interpolated into `run:`; all actions SHA-pinned;
  `persist-credentials: false`.
- **Tests:** negative tests assert that no request was sent, not just the error code. The contract test fails when a
  registered tool has no sample call.

## New task files

- `P1-16` Isolate the OIDC publish step and make release reruns idempotent (high; before first publish).
- `P1-17` CLI warnings and docs accuracy follow-ups (low).
- `P2-14` Core tool consistency and envelope coverage clean-up (low).
- `P8-07` CI supply-chain hardening follow-ups (medium).

## For Phase 2

- **Tool filtering:** the HTTP app must filter `run_nrql` / `get_query_result` out of `tools/list` when `rawNrql` is
  off. stdio already does this, but core only refuses at call time. This was a P1-06 pending decision. Grant
  resolution must also feed `ctx.connection.allowedTools`.
- **Shared caches:** the entity-types and schema caches are per tool-set instance, keyed by credential id. If the
  Worker or HTTP app shares one tool set across tenants, credential ids must be unique per tenant and never reused
  (T16, T21).
- **Account scope:** `ctx.accounts.allowed` is the only account guard. Grant resolution must compute the
  intersection before building the context (T3).
- **Envelope gaps:** finish P2-14 before exposing tools over HTTP to untrusted clients.
- **Redaction tuning:** redaction now also hits `*token=` assignments in telemetry. Revisit this with the per-connection
  redaction setting if the owner wants one (pending decision).
