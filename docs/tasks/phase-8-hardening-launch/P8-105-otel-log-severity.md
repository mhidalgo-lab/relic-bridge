---
id: P8-105
title: Read OpenTelemetry log severity, and keep log totals consistent with patterns
phase: 8
status: review
priority: high
depends_on: []
adr: []
owner: claude-agent
---

# P8-105 — Read OpenTelemetry log severity, and keep log totals consistent with patterns

## Goal
First mobile test (Claude Android, 2026-10-16), issues 1 and 7:
- `analyze_entity_logs` reports "0 lines in total / No log lines in the window" while listing patterns (378 "http
  request", …) and a 556-line burst, and has no level counts. The logs section of `generate_alert_insights_report`
  does the same.
- `list_recent_logs` shows a blank level column.

Verified on the sandbox: logs sent over OTLP (relic-bridge's own, `newrelic.source: api.logs.otlp`) have
`severity.text` (`INFO`) and `severity.number`, and no `level`, `severity` or `log.level`. `FACET level` puts every
line in one null facet, which the level-count code drops, so the total is 0.

## Scope
- Add `severity.text` to the level columns (`LEVEL_COLUMNS`, the level filter, the level-count facet, the
  `list_recent_logs` level value) in `packages/core/src/tools/logs.ts`, with NRQL that works when only some of the
  attributes exist (for example a facet on a `coalesce`-style expression if NRQL supports it, or one facet per column;
  check NRQL docs and record the choice in RESEARCH.md).
- The total line count never contradicts patterns or bursts: count lines without a level as "(no level)" instead of
  dropping them, and take the total from the unfaceted count.
- Same fix wherever `generate_alert_insights_report` reuses the log summary.

## Acceptance criteria
- [x] Tests with OTLP-shaped rows (`severity.text` only), classic rows (`level`), and rows with no level at all:
      totals match, levels are named, `level` filter selects the right lines.
- [x] `list_recent_logs` shows the level for OTLP rows.
- [x] NRQL stays built through the `nrql` template (T4).

## Security notes
T4: attribute names with dots go through `nrql.identifier()`.

## Docs to update
- `docs/RESEARCH.md` (OTLP log attributes), generated tool docs if descriptions change, changeset (patch).

## Out of scope
- Mapping `severity.number` ranges to names when `severity.text` is absent (note it if seen).

## Owner decisions
- 2026-10-16: the level-count facet keeps `LIMIT 20` (real level vocabularies are smaller; the total stays exact).
