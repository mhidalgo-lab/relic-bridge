---
id: P8-40
title: trace_error diagnoses missing span data
phase: 8
status: review
priority: high
depends_on: []
adr: []
owner: claude-agent
---

# P8-40 — trace_error diagnoses missing span data

## Goal
When `trace_error` finds no traced occurrence, say why. The live test run (2026-10-12) and the 0.8.0 verification run
(2026-10-13) showed an account with thousands of errors carrying a trace id but zero `Span` events, where the
tool gave no diagnosis (BUG-12).

## Scope
- The tracing check fires whenever `Span` count is 0, regardless of errors with a trace id.
- Spans > 0 but no traced occurrence for the group keeps the current note only.
- A failing check query adds a note (with the RB code) instead of being dropped silently.

## Acceptance criteria
- [x] spans 0 with traced errors > 0 gives the missing-span diagnosis.
- [x] spans 0 and traced errors 0 gives the diagnosis.
- [x] spans > 0 gives no diagnosis.
- [x] A failing check query adds a "could not run" note with the RB code.
- [x] Tests use synthetic numbers only; RESEARCH.md and tool docs updated.

## Security notes
none (read-only, same GraphQL-variable NRQL).

## Docs to update
- `docs/RESEARCH.md`, tool description if it mentions the check.

## Out of scope
- Enabling tracing or any write action.
