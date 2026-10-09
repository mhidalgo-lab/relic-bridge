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
