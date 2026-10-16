---
id: P8-89
title: Restore the tracing-off diagnosis and remove false zeros in the user impact report
phase: 8
status: done
priority: high
depends_on: []
adr: []
owner: "claude-agent"
---

# P8-89 — Restore the tracing-off diagnosis and remove false zeros in the user impact report

## Goal
Two regressions of earlier fixes that review 4 (0.11.0) found:
- **NEW-17 (BUG-12):** when a trace has no spans, `trace_error` says "may have been sampled out…" even when the account
  has **no** `Span` events at all. The 0.9.x account-wide check ("distributed tracing appears to be disabled") is gone,
  probably since P8-77 (Span-sourced error groups).
- **NEW-18 (BUG-13):** `generate_user_impact_report` returns `previous.sessionsWithErrors: 0` when no `JavaScriptError`
  event in the previous window has a `session` attribute, and `totals.browserSessionsWithErrors: 0` when a part is
  `null`.

## Scope
- `trace_error` (every input path: `error_group_id`, `trace_id`, entity): when the trace has no spans, run a cheap
  account-wide `SELECT count(*) FROM Span` in the window. Zero → the tracing-off diagnosis. Non-zero → the generic
  wording. One extra request at most, counted in the budget.
- User impact: apply the "unknown when no event carries a session id" rule to every window, and make each total `null`
  (with a note) when any part is `null`.
- Regression tests that pin both behaviours, named after BUG-12 and BUG-13, so the next refactor can't drop them again.

## Acceptance criteria
- [x] Tests for each `trace_error` input path with zero and non-zero account span counts.
- [x] Tests: previous window without session ids → `null` plus a note; totals `null` when a part is `null`.
- [x] Tool docs regenerated if descriptions change.

## Security notes
None. The values are built only from NRQL templates (T4).

## Docs to update
- Changeset (patch).

## Out of scope
- New-14-style attribute mapping changes.
