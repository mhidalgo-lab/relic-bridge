---
id: P8-44
title: run_nrql accepts array totals of FACET TIMESERIES queries
phase: 8
status: review
priority: high
depends_on: []
adr: []
owner: claude-agent
---

# P8-44 — run_nrql accepts array totals of FACET TIMESERIES queries

## Goal
Any `run_nrql` query with both `FACET` and `TIMESERIES` fails with `Output validation error: totalResult: expected
record, received array, otherResult: expected record, received array`. NerdGraph returns `totalResult` and
`otherResult` as an array of time buckets for that shape, while the output schema only allows an object. Found during
the observability check of 2026-10-14 (not in the 0.9.0 verification report).

## Scope
- Accept both shapes for `totalResult` and `otherResult` in the engine type, the output schema
  (`packages/core/src/output/nrql.ts`) and the text trailer.
- Check the summarizer (`detail: auto|summary`) and any other consumer of `totalResult` for the array case.

## Acceptance criteria
- [x] `SELECT count(*) FROM Log FACET x TIMESERIES 1 hour SINCE 1 day ago` returns rows with every `detail` value.
- [x] Regression test with a recorded FACET + TIMESERIES NerdGraph response (fails before the fix).
- [x] Output schema test covers the object and the array shape.

## Security notes
None: the shape change is within data already returned as untrusted output (T7 labelling unchanged).

## Docs to update
- `docs/reference/tools.md` (generated), changeset.

## Out of scope
- Other run_nrql output changes.
