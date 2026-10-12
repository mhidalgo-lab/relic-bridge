---
id: P8-16
title: Fix list_top_transactions NRQL (no ORDER BY after FACET)
phase: 8
status: done
priority: high
depends_on: []
adr: []
owner: claude-agent
---

# P8-16 — Fix list_top_transactions NRQL (no ORDER BY after FACET)

## Goal
`list_top_transactions` fails on every call in the live test run (2026-10-12, BUG-01) because the generated NRQL ends in `FACET name ORDER BY <aggregate> DESC`, which NRDB rejects. Make it work while keeping `sort_by` semantics.

## Scope
- Put the ranking aggregate first in SELECT (NRDB orders facets by the first aggregate, descending); drop ORDER BY.
- Scan all server-built NRQL in `packages/core` for `FACET … ORDER BY <aggregate>`.
- Unit test forbidding ORDER BY in generated faceted queries; correct RESEARCH.md.

## Acceptance criteria
- [x] `topQuery` emits no ORDER BY; slowest = p95, throughput = count, errors = error count lead the SELECT.
- [x] Scan done: no other faceted query uses ORDER BY (others order raw events by timestamp, no FACET).
- [x] Regression test fails before the fix, passes after.
- [x] RESEARCH.md updated; changeset added.

## Security notes
none (values remain template values; no access change).

## Docs to update
- docs/RESEARCH.md, generated docs/task index.

## Out of scope
- Other live-run bugs (separate tasks).
