---
id: P8-49
title: trace_error note states how many errors carry a trace id
phase: 8
status: review
priority: low
depends_on: []
adr: []
owner: claude-agent
---

# P8-49 — trace_error note states how many errors carry a trace id

## Goal
NEW-10 of the 0.9.0 verification: the "no Span events" note says "even though some errors carry a trace id" when 0 of
about 3.5 K `TransactionError` events have `trace.id`.

## Scope
- Make the clause depend on a real count: "none of N errors carry a trace id" or "K of N errors carry a trace id",
  within the existing request budget (reuse a query if one already counts errors).

## Acceptance criteria
- [x] Note text is correct for K = 0 and K > 0.
- [x] Tests for both.

## Security notes
None.

## Docs to update
- Changeset.

## Out of scope
- Other trace_error behaviour.
