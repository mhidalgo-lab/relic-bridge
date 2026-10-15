---
id: P8-77
title: trace_error follows Span-sourced error groups
phase: 8
status: in-progress
priority: low
depends_on: [P8-57]
adr: []
owner: claude-agent
---

# P8-77 — trace_error follows Span-sourced error groups

## Goal
Services instrumented with OpenTelemetry (including relic-bridge itself, P8-51) report errors as Span data. Their Errors Inbox
groups carry a `trace.id` and are matched through the span `name` and `otel.status_description`, not through the
`TransactionError` attributes `trace_error` expects. After P8-57 (PR #232) such groups are refused as unsupported; this
task makes `trace_error` follow them.

## Scope
- Identify a Span-sourced group from the group's `source`/`eventsQuery` shape as returned by NerdGraph (verify against a live
  response, with placeholders in the repo: `<APP>`, `<account>`, `<error class>`; never real names or guids).
- Match its events on span `name` + `otel.status_description` (through the `nrql` tagged template and
  `nrql.identifier()`, never by running NRQL text received from New Relic), read `trace.id`, and continue into the trace
  (spans, logs) like the transaction path in `packages/core/src/tools/investigations.ts`.
- Output marks the source (`Span`) and keeps the untrusted-data wrapping of every New Relic string.
- Fix the sample data in `packages/core/test/tools-errors.test.ts`: the `group()` helper uses a made-up
  `source: 'transaction'` and an `eventsQuery` of `SELECT count(*) FROM TransactionError WHERE error.group.guid = 'x'`, which
  is not what NerdGraph returns. Replace both with shapes taken from real responses (anonymised) for the transaction and
  the span case.

## Acceptance criteria
- [ ] A Span-sourced error group yields a trace with `trace.id`, matching events by `name` + `otel.status_description`
      (tests with anonymised fixtures).
- [ ] Transaction-sourced groups behave as before (existing tests, with corrected fixtures).
- [ ] A group of an unknown source is still refused with the P8-57 message (test).
- [ ] No NRQL from New Relic is executed; all values are bound through the template helpers (check-nrql-templates passes).
- [ ] Live check on a real OpenTelemetry service (leave unticked until done; note in the PR).

## Security notes
T4 (NRQL values go through `nrql`), T6/T27 (New Relic text is untrusted data), T21 (no state between calls). The span
`name` and status description are attacker-influenced strings: escape them as values, never as identifiers.

## Docs to update
- `docs/guide/` tool description for `trace_error` (and the generated `docs/reference/tools.md`, regenerate),
  `docs/RESEARCH.md` (Span error group shape with sources), changeset.

## Out of scope
- Other tools' handling of OpenTelemetry errors.
