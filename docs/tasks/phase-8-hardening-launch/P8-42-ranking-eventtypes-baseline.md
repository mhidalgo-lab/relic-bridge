---
id: P8-42
title: Polish - slowest ranking, global event types, weekly baseline
phase: 8
status: done
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-42 — Polish: slowest ranking, global event types, weekly baseline

## Goal
Three refinements from the 0.8.0 verification run (2026-10-13): NEW-03, NEW-04, NEW-06.

## Scope
- NEW-03: `list_top_transactions` `sort_by: slowest` is dominated by one-request transactions. Add `min_requests`
  (default 10, slowest only). NRQL has no HAVING and ranks a faceted page by its first aggregate, so read a wider page
  and filter client-side. The throughput and errors sorts are unchanged.
- NEW-04: `list_event_types` lists global types in `eventTypes` as well as `globalEventTypes`. Keep them only in
  `globalEventTypes` (the text table still marks them `global`).
- NEW-06 (owner decision): the automatic seasonal baseline prefers `same_window_7d_ago` for a window of 24 h or more or
  one crossing a weekend boundary, only if the `maxWindowDays` lookback limit allows it (the limit is never relaxed for
  baseline queries); otherwise `same_window_1d_ago` with a note giving the `maxWindowDays` a weekly control needs. An
  explicit `baseline` keeps priority.
- Keep new tool description/input text minimal (tools/list budget).

## Acceptance criteria
- [x] NEW-03: slowest drops transactions under `min_requests` (default 10), reports how many, and still flags a truncated page; other sorts unchanged.
- [x] NEW-04: `eventTypes` holds no global type; `globalEventTypes` does.
- [x] NEW-06: weekly control chosen when allowed; fallback to 1d with the needed `maxWindowDays`; explicit baseline wins; limit never exempted.
- [x] Regression tests for each item (fail before the fix); budget tests unchanged.
- [x] RESEARCH.md, generated docs and changeset updated.

## Security notes
No new access path. The P8-24 lookback limit still bounds every baseline query (T5).

## Docs to update
- `docs/RESEARCH.md`, `docs/reference/tools.md` (generated), changeset.

## Out of scope
- Other findings of the verification run.
