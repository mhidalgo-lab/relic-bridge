# Phase 6 consolidation review

- **Scope:** all of Phase 6 (tool parity, prompts, resources):
  `git diff task/P5-12-review-followups...task/P6-19-trim-input-schema-text` (P6-01 … P6-19, 37 commits, 102 files,
  about 18k lines). 36 tools (23 new in Phase 6, 3 existing tools gained a name input), 7 prompts, 3 resources, ADR-0014.
- **Branch:** `review/phase-6`, stacked on `task/P6-19-trim-input-schema-text` (top of the Phase 6 PR stack).
- **Date:** 2026-10-06.
- **Method:**
  - Read the task files, ADR-0014, the THREAT_MODEL rows, `docs/research/prior-art.md` (P0-10) and the pending decisions
    first.
  - Three parallel read-only sub-reviews, cross-checked against the code: (1) NRQL / entity-search / GraphQL injection
    across every builder, (2) account isolation, envelope coverage, redaction and cost per tool, (3) completeness against
    every acceptance criterion, parity with the official server, consistency across the 36 tools and authz-suite coverage.
  - Generic probe tests that cover every registered tool automatically (a new tool is probed without edits):
    `packages/core/test/probe-envelope.test.ts` poisons every free-text string of the NerdGraph mocks and adds a poisoned
    column for every identifier each NRQL query names, then fails when the canary appears outside an untrusted-data
    block, for every open-world tool and for the name-input path; the same file checks that a sample call never sends
    more requests than the tool's declared `cost`. `packages/core/test/composite-grants.test.ts` covers H1.
  - Fixed findings keep a regression test that fails with the fix reverted (checked for H1, H2 and M1: 4, 2 to 4 and 1 tests fail respectively).
  - Nothing was deployed, published or tagged; no New Relic or LLM API was called. GitHub Actions is unavailable
    (billing), so every check was run locally (see [Local CI](#local-ci)).

## Verdict

**Ready to merge as a stack, with the fixes on this branch.** No critical findings. Two high findings are fixed:
composite tools ignored per-tool grants (H1), and several tools put New Relic text (dashboard descriptions, entity
names, golden-metric titles, ambiguous-name candidates) outside the untrusted-data envelope (H2). One medium finding
(multi-account dashboard widgets) is fixed; the other mediums and the lows are tracked in P6-20 … P6-23.

The injection surface holds. Every GraphQL document is a module-level constant (no `${}` with input; `defineDocument`
refuses `"`, subscriptions and mutations); every NRQL value goes through the `nrql` tag or `nrql.identifier()`; every
entity-search value through `entityQuery`; time ranges are computed integers. No concatenated NRQL or entity query was
found in the 55 tagged templates and five `entityQuery` call sites. Account isolation holds tool by tool: one account
per call from `resolveAccounts` or an offline-checked GUID, and every returned row carrying an account id or GUID is
checked (issues drop a row touching any foreign account; error groups need a GUID of the requested account; related
entities, change events, monitors, dashboards and resolver hits are re-checked, the resolver also on a cache hit). The
resolver and schema caches are keyed by credential id, region and the effective account set (pass-through uses a key
fingerprint id). Prompts render user arguments as one-line JSON-quoted strings and list only granted tools; resources
are offered only with their tool and go through the tool's handler (authz, limits, cache, audit). The per-request
budget caps every call (one unit per attempt, retries included), so no tool can exceed the Workers Free subrequest
limit with the `callBudget: 45` preset.

**The roadmap promise** ("alerts, issues, errors inbox, deployments, logs, APM, JVM, Kafka, synthetics, dashboards,
reports, prompts, resources") is met in code and mocked tests. Every NerdGraph shape added in Phase 6 is from
introspection or documentation only (no live sample for `aiIssues` rows, Errors Inbox, change tracking, synthetics,
dashboards, Kafka, JVM metric names): a `pnpm test:live` run on real accounts is the main open risk before v0.6.0
(owner action, logged per task). The LLM tool-choice eval was never run (no API key; P6-13/P6-19 decisions).

## Per-task completeness

| Task | Result | Notes |
|---|---|---|
| P6-01 alerts | Met | One account per call; foreign-account condition NRQL shown (L1, P6-21). |
| P6-02 issues | Met | `aiIssues` shapes from introspection only (decision logged). |
| P6-03 errors inbox | Met | Error messages get central redaction only (M3, P6-21). |
| P6-04 change tracking | Met | Entity name in the impact summary was outside the envelope (H2, fixed). |
| P6-05 APM | Met | `\_` LIKE escaping unverified live (L6, P6-23). |
| P6-06 logs | Met | Extra redaction is local to logs (P6-06 decision; M3). |
| P6-07 runtime (JVM, Kafka) | Met | Metric and event names unverified live (decision logged). |
| P6-08 synthetics | Met | No script / secure-credential / header field selected; `monitoredUrl` not redacted (M3). |
| P6-09 dashboards | Met, H2 + M1 fixed | Name/description/link outside the envelope; `accountIds` widgets ignored. |
| P6-10 composite reports | Met, H1 fixed | Composite grant implied every section's tool. Cost 9 for user impact plans the whole budget (M2). |
| P6-11 prompts | Met | `entity_health` (P6-16) was referenced by no prompt: added to `investigate_error_spike`. Stdio untested (L11). |
| P6-12 resources | Met | URI values now parsed with the tool's schema before the handler (L9, fixed). |
| P6-13 evals | Partly met | Offline lint and router baseline in `pnpm test`; LLM baseline not run (owner, key needed). |
| P6-14 resolver | Met | Cache isolation tested over HTTP; `resolve_entity` declares cost 1 for up to 4 calls (M2). |
| P6-15 raw NerdGraph decision | Met | ADR-0014 + `no-raw-nerdgraph.test.ts`; P7-15 blocked pending owner. |
| P6-16 investigation tools | Met, H1 + H2 fixed | `dependency_health` / `entity_health` summaries leaked names; grants bypassed. |
| P6-17 name on entity tools | Met, H2 fixed | Resolved entity name in the note was outside the envelope. |
| P6-18 name on report/signal tools | Met | Cost charged on every call (decision logged). |
| P6-19 trim schemas | Met | `tools/list` 51,980 chars; eval not re-run (owner). |

## Parity with the official server (P0-10)

`docs/research/prior-art.md` names about 20 of the official server's "30+" tools; groups without names (alerting,
dashboards, threads, GC, Kafka) are mapped by function.

| Official tool | relic-bridge |
|---|---|
| `get_entity` / `lookup_entity` | `get_entity` (guid or name) |
| `list_related_entities` | `get_related_entities` |
| `search_entity_with_tag` | `search_entities` (`tags`) |
| `list_entity_types` | `list_entity_types` |
| `list_available_new_relic_accounts` | `list_accounts` |
| dashboards | `list_dashboards`, `get_dashboard` |
| `convert_time_period_to_epoch_ms` | `time_range` |
| `execute_nrql_query` | `run_nrql` (+ `get_query_result`) |
| `natural_language_to_nrql_query` | **none, by design** (P1-06: the agent writes NRQL; `relic://nrql/reference` helps) |
| alerting | `list_alert_policies`, `list_alert_conditions`, `list_recent_issues`, `search_incidents` |
| `generate_alert_insights_report` | same |
| `generate_user_impact_report` | same |
| `analyze_deployment_impact` | same |
| `list_entity_error_groups` | `list_error_groups` |
| `list_change_events` / `list_recent_deployments` | `list_change_events` |
| `analyze_golden_metrics` | `get_golden_metrics` |
| `analyze_transactions` | same (+ `list_top_transactions`) |
| `analyze_entity_logs` | same (+ `list_recent_logs`) |
| threads / GC / Kafka | `analyze_threads`, `list_gc_metrics`, `analyze_kafka_metrics` |
| synthetics | `list_synthetic_monitors` |

Only in relic-bridge: `whoami`, `resolve_entity`, `decode_entity_guid`, `list_event_types`, `get_attributes`,
`trace_error`, `dependency_health`, `entity_health`, 7 prompts, 3 resources. Not covered by either: Kubernetes tools
(the `investigate_kubernetes_pods` prompt uses `run_nrql`).

## Findings

Severity: impact if exploited or hit × likelihood. Status: **fixed** (here, with tests), **task** (new task file),
**decision** (`docs/pending-decisions/phase-6.md`), **accepted** (documented residual).

### High

**H1. Composite tools ignored per-tool grants.** `packages/core/src/tools/reports.ts` and `investigations.ts` called
sibling handlers directly (`tool(name).handler`). HTTP registers only granted tools (`packages/http-app/src/app.ts`,
`access.tools`), but a grant with only `generate_alert_insights_report` still returned log message patterns and example
lines (`analyze_entity_logs`), error groups, deployments and related entities; `entity_health` returned issues, error
groups and deployments; `dependency_health` returned neighbours and their golden metrics.
*Impact:* an admin restricting a grant to "health overview" tools (for example to keep log lines away from a
connection) is silently bypassed; least privilege per tool, the point of grants, does not hold for four tools.
*Fix:* siblings are wrapped by `grantedSibling` (`packages/core/src/tools/shared.ts:115`, used at `reports.ts:541` and
`investigations.ts:415`): when `ctx.connection.allowedTools` lacks the sibling it throws `RB_TOOL_DISABLED` before any
request; `runSection` marks the section `skipped` with the reason (`reports.ts:217`); `dependency_health` without
`get_related_entities` fails. Stdio and pass-through list every tool, so nothing changes there. Regression tests in
`packages/core/test/composite-grants.test.ts` (4 of 5 fail without the fix). THREAT_MODEL row added. Owner question
(should a composite grant imply its parts?) logged. **fixed, decision**

**H2. New Relic text outside the untrusted-data envelope (T6).** Found by the generic probe:
- `get_dashboard`: `name:`, `description:` and `link:` lines (anyone who can edit a dashboard writes them) —
  `dashboards.ts:353` now envelopes them.
- `analyze_deployment_impact` and `dependency_health` summaries named the entity (APM app names are set by anyone with
  the licence key) — `changes.ts:754`, `investigations.ts:814` no longer do (the name is in the enveloped tables).
- `entity_health` summary listed signals quoting golden-metric titles (customisable) — `investigations.ts:980`
  envelopes them.
- The name-input note (`entity-ref.ts:87`) quoted the matched entity's own name: with a substring match, an entity named
  `checkout <instructions>` resolved from "checkout" and its name reached the agent unwrapped. The note now shows only
  the user's input and the guid.
- Error results rendered `Details: {...}` unwrapped, and ambiguous-name errors put candidate entity names there:
  `packages/core/src/errors.ts:69` envelopes every details block.

*Impact:* indirect prompt injection from any user able to name an entity or edit a dashboard, outside the one control
the design relies on. *Tests:* `probe-envelope.test.ts` (every tool and the name path; 2 to 4 cases fail with each fix
reverted), `errors.test.ts`. **fixed**

### Medium

**M1. Multi-account dashboard widgets were judged by `accountId` only.** `readWidget` (`dashboards.ts:83`) read
`nrqlQueries[].accountId`; widgets that carry an `accountIds` array (multi-account queries) were either always withheld
(no `accountId`) or, with both fields, shown with a foreign account in `accountIds` ignored (another account's NRQL
text, not its data). Every named account must now be allowed. Test in `tools-dashboards.test.ts`; RESEARCH updated.
**fixed**

**M2. Declared costs undercount real calls.** Every NRQL may take two calls (async submit + poll), retries count, and
`resolve_entity` (1 declared, up to 4), `get_golden_metrics` (15 declared, 1 + 2 per metric + 4), `dependency_health`
(up to 66 planned at maximums) and `generate_user_impact_report` (9 declared, plans the whole remaining budget) exceed
their numbers. The per-request budget still caps every call, so the effect is surprising partial results and
`affordable` showing tools that cannot finish, not a DoS. The probe confirms sample calls stay within cost. **task P6-20**

**M3. Error text gets weaker redaction than log lines.** Errors Inbox messages, span and `TransactionError`
`error.message`, synthetic `lastError` go through `cleanName` (central `redact()`), not the log patterns
(`cleanLogMessage`: URL credentials, JWT, cloud tokens, PEM): `connect failed postgres://app:S3cret@db` passes. Synthetic
`monitoredUrl` can carry `user:pass@`. Linked to the open P6-06 (c) decision. **task P6-21**

**M4. Golden-metric NRQL bypasses the `rawNrql` switch.** `golden.ts` runs New Relic-supplied golden-metric NRQL with
`runTrustedNrql`; golden metrics can be customised in New Relic, so a user with write access there can make
`get_golden_metrics` and the composites run arbitrary NRQL on a connection where `run_nrql` is off (still limited to the
entity's allowed account, event-type lists, window and LIMIT). Predates Phase 6; composites widen it. **task P6-21**

**M5. Argument and output naming drifted across 36 tools.** Seven shapes of time argument (`time_range`, `since`,
`lookback`, `lookback_days`, `before_minutes`, …), `guid` vs `entity_guid`, `policy_id` string vs integer, list tools
with and without `limit` or a cursor, `name` meaning "filter" on some tools and "entity to resolve" on others, output
fields `account`/`accountId`, `total`/`totalCount`, `maybeMore`/`hasMore`/`truncated`. Costs tool-choice accuracy and
tokens; fix before the 1.0 contract. **task P6-22**

**M6. The LLM tool-choice eval has never run.** Descriptions were rewritten (P6-13) and schemas trimmed (P6-19) against
an offline lint and a BM25 router baseline only. **decision** (existing P6-13 / P6-19 entries)

### Low

- **L1** `list_alert_conditions` shows a condition's NRQL and `dataAccountId` when that account is outside the
  connection; dashboards withhold the same case. **task P6-21**
- **L2** `guidAgrees` returns true for an undecodable GUID (`entity-common.ts`); such GUIDs reach `resolve_entity` and
  `get_related_entities` output (later `checkGuid` stops any use). **task P6-21**
- **L3** `Note:` lines carry redacted New Relic error messages outside the envelope (pattern older than Phase 6), and
  `structuredContent` carries cleaned but not enveloped text (clients that give it to the model rely on the
  description sentence). **task P6-21**, residual documented in THREAT_MODEL.
- **L4** `entityQuery.and()` joins parts without parentheses: a future `OR` fragment would escape the
  `accountId IN (...)` scope. Safe today. **task P6-23**
- **L5** `scripts/check-nrql-templates.ts` is case-sensitive, misses fragments without SELECT/FROM, entity-search
  strings and `defineDocument` with `${}`. The type gate on `runNrql` is the real control. **task P6-23**
- **L6** `likePattern` escapes `%`/`_` with a backslash; NRQL honouring `\_` is unverified live (a value with `_` may
  match nothing). **task P6-23**
- **L7** `nrql.identifier` allows `--`, `//`, `/*` inside backticks (only `get_attributes` `event_type` is
  user-supplied); needs one live probe. **task P6-23**
- **L8** `generate_user_impact_report` pairs `entityGuids[i]` with `entities[i]` after empty names were dropped, so
  front-end labels can shift. **task P6-23**
- **L9** Resource reads passed URI values to the tool handler without the tool's input schema (safe only because the
  handlers re-check). Now `safeParse`d first (`resources.ts:130`). **fixed**
- **L10** `entity_health` was not referenced by any prompt (P6-16 criterion). Added as the first step of
  `investigate_error_spike`; `docs/reference/prompts.md` regenerated. **fixed**
- **L11** Authz suite: `analyze_deployment_impact`, `get_dashboard`, `dependency_health`, `entity_health` never reach a
  success path over HTTP; some foreign-GUID cases missing; prompts and resources never tested over stdio. Section
  summaries still say "skipped (budget)" when a section is skipped for a missing grant. **task P6-23**
- **L12** `docs/ROADMAP.md` status line still said "Phase 2 in review". **fixed**

### Informational (accepted)

- A report concatenates many enveloped blocks, so it carries more injection surface per call than a single tool
  (documented in THREAT_MODEL P6-10).
- A composite's own queries (issue lookup, `trace_error` spans, error events and trace logs, user-impact front-end
  queries) are part of its grant, by design.
- Errors Inbox `contains` and alert `nameLike`/`queryLike` are passed as GraphQL variables to New Relic's own filter
  languages: the agent controls the filter, scope still comes from `accountIds` and per-row checks.

## What was verified to hold

- **GraphQL:** 32 static documents; `defineDocument` refuses `"`, subscriptions and unflagged mutations; every request
  is a named `query Rb…` (contract test); no passthrough tool (ADR-0014 test).
- **NRQL:** every Phase 6 builder uses the tag; user strings (`name`, `contains`, `cluster_name`, `consumer_group`,
  `topic`, ids) are quoted literals; enums map to constants; ids are charset-checked (also when read back from New
  Relic); numbers are schema-bounded integers; `enforceQueryLimits` re-tokenises every query.
- **Accounts:** every tool resolves one allowed account before any request; every row is re-checked; composites pass
  the same per-request context and fail closed on authorization errors.
- **Caches:** resolver (credential id + region + effective accounts + filters, re-filtered on read), event types and
  attributes (credential + account), schema JSON memo (static definitions only).
- **Secrets:** synthetics select no script, secure credential or header; log lines redacted before truncation; GraphQL
  errors redacted and capped; no `FAKE_KEY` in any result (contract test).
- **Prompts/resources:** offered only with their tools; arguments strict, one line, ≤ 200 chars, JSON-quoted; resource
  URIs digits-only accounts and schema-checked event types; reads audited as tool calls.
- **Hard rules:** no `node:*` in `core`/`auth`/`http-app`; no module-level request state; every Phase 6 tool has
  negative authz cases (guard test fails on a tool without one).

## Local CI

GitHub Actions is unavailable (billing). Results on WSL2 Linux, Node 24, Docker available.

Baseline run on the unchanged stack tip (`task/P6-19-trim-input-schema-text`): lint, typecheck, `pnpm test` twice
(174 files, 3,178 passed, 14 skipped), `test:workers`, build, `bench:cpu`, `docs:tools`, `test:e2e` all passed.

Final run on this branch (sequential):

| Command | Result |
|---|---|
| `pnpm lint` | pass (biome, runtime imports, NRQL, UI escaping, SPDX, tasks, generated docs/migrations/assets, version sync) |
| `pnpm typecheck` | pass |
| `pnpm test` (run 1) | pass: 176 files, 3,260 passed, 14 skipped (264 s) |
| `pnpm test` (run 2) | pass: 176 files, 3,260 passed, 14 skipped (261 s) |
| `pnpm test:workers` | pass: 31 files, 536 passed, 6 skipped (workerd + D1 simulator) |
| `pnpm test:authz` | pass: 20 files, 411 passed (authorization matrix) |
| `pnpm build` | pass |
| `pnpm bench:cpu` | pass, one run, within baseline (0.83x … 1.26x; `cold.first-request` 1.26x, `mcp.tools-list.hit` 1.22x) |
| `pnpm docs:tools` | pass, no diff |
| `pnpm test:e2e` (Playwright) | pass: admin and OAuth flows, desktop and mobile-320 (4 tests) |
| Offline tool-description checks (`tool-descriptions.test.ts`, `eval-tools.test.ts`) | pass (16 tests; router baseline held). `pnpm eval:tools` (LLM) not run: no API key, never called |
| Docker image build + `scripts/docker-smoke.sh` | pass (health, foreign Host refused, backup, CLI setup, 36 MCP tools, uid 65532, read-only rootfs); image and containers removed |
| actionlint 1.7.12 on `.github/workflows/*` | pass, no findings |

**Benchmark noise.** On a quiet machine six consecutive `pnpm bench:cpu` runs stayed between 0.78x and 1.30x of the
baseline for every scenario (threshold 2x); under full CPU load from other processes the calibration scenario slows too,
so ratios fall rather than rise. The failures agents saw came from load that changes during a run (parallel test runs
starting between the calibration and a scenario), plus one real regression (`mcp.tools-list.hit` about 2.05x), which
P6-10 fixed (schema JSON computed once per isolate) and re-baselined. `scripts/bench-cpu.ts` now re-runs the benchmark
up to three times when a scenario regresses and fails only on scenarios that regress in every run; a single clean run
still decides at once. Checked both ways: unit tests (`scripts/test/bench-cpu.test.ts`) and a deliberately lowered
baseline (`admin.overview` 3.5x), which failed after three runs. `cold.first-request` is consistently about 1.25x of
the Phase 5 baseline (more tools to load), within tolerance; the baseline was not re-taken.

## What Phase 7 must know

1. **Composites need sibling grants.** Any new composite must call siblings through `grantedSibling`; the admin UI
   grant editor should show which parts a composite needs (decision logged).
2. **The envelope probe is the gate for new tools.** `probe-envelope.test.ts` and the contract table cover every
   registered tool; a new tool needs a sample call and must keep New Relic text inside envelopes, including summary
   lines and error `details`. MCP Apps / charts (P7-04) render New Relic text in a UI: treat titles, names and NRQL as
   untrusted there too (escape, never `innerHTML`), and decide what the model sees of chart data.
3. **Cost is a plan, the budget is the cap.** Costs undercount polls (P6-20); the query cache (P7-02) should key like the
   resolver (credential id, region, effective accounts, normalised query) and refund budget on hits only after P6-20
   settles the rule. The DO limiter (P7-10) and quotas (P7-12) should count real calls, not declared costs.
4. **Write tools (P7-09) need more than a grant.** OAuth tokens are `mcp:read` only; ADR-0014 forbids raw mutations;
   `defineDocument` requires `{ mutation: true }`; composites must never call a write tool.
5. **Deep links (P7-03):** New Relic `permalink`/`deepLinkUrl` values are shown as cleaned text today; build links from
   validated GUIDs and a fixed host per region instead of echoing New Relic's URL.
6. **Live verification is still owed** for every Phase 6 NerdGraph shape (`pnpm test:live`), and the LLM eval for the
   descriptions; both need owner credentials.
7. **Naming (P6-22) should land before plugin/import-export (P7-06, P7-07)** so saved prompts and exported configs use
   the final argument names.
