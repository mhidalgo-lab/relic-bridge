---
id: P8-109
title: trace_error reads OpenTelemetry log severity; NRQL reference logs example
phase: 8
status: done
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-109 — trace_error reads OpenTelemetry log severity; NRQL reference logs example

## Goal
0.13.0 retest (2026-10-17): `trace_error` still shows a blank level for log lines that carry `severity.text`
(`INFO`, `WARN`), for example the sandbox's own OTLP logs (trace `1e655dd6…`). P8-105 fixed `logs.ts` only;
`packages/core/src/tools/investigations.ts` selects and reads `level` alone (the trace log query near line 305 and the
row mapping near line 890). The NRQL reference resource also shows `level` as the only log level example.

## Scope
- `trace_error` (and any other reader in `investigations.ts` that maps log rows): read the level from the same columns
  as `logs.ts` (`level`, `severity`, `log.level`, `severity.text`), sharing the list/helper instead of copying it.
  NRQL stays built through the `nrql` template with `nrql.identifier()` for dotted names (T4).
- NRQL reference (`packages/core/src/nrql-reference.ts`): mention that OpenTelemetry logs carry the level in
  `severity.text`.

## Acceptance criteria
- [x] Tests: trace_error log rows with only `severity.text`, with only `level`, and with neither (blank) map correctly.
- [x] The NRQL reference text names `severity.text`; generated docs regenerated if affected.

## Security notes
T4 (identifiers through `nrql.identifier()`), T5 (log text stays inside the untrusted block).

## Docs to update
- Changeset (patch); generated tool docs if any description changes.

## Out of scope
- Mapping `severity.number` without `severity.text`.
