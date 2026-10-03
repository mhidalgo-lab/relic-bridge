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

