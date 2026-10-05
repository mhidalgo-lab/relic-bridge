---
id: P6-05
title: "Tools: analyze_transactions, list_top_transactions"
phase: 6
status: review
priority: high
depends_on: [P5-07]
adr: []
owner: claude-agent
---

# P6-05 — Tools: analyze_transactions, list_top_transactions

## Scope
- `list_top_transactions`: one NRQL query over `Transaction` for an APM application (`entity_guid`), `FACET name`, with
  `sort_by` slowest (p95 duration, default) | errors (error count) | throughput (request count); `limit` (default 10, max 50),
  `transaction_type` all | web | background, `name_contains` (NRQL `LIKE`), `time_range` (default last 1 hour, capped by the
  window limit), `minimal_output`. Per transaction: name, requests, throughput per minute, error count and rate, average, p50,
  p95, p99 duration (seconds). Re-sorted client-side so the order never depends on NRQL `ORDER BY` details.
- `analyze_transactions`: the application as a whole, or one transaction (`transaction_name`, exact), over `time_range` and
  over the equal window just before it: requests, throughput per minute, error rate, average, p50, p95, p99, with
  before/after/delta/ratio and a verdict per metric (the P6-04 thresholds and `compareWindows`). Two queries (current window
  first); if the budget stops the previous window or it fails, the current window is still returned and the result is
  `partial`. `compare_previous` (default true) can switch the comparison off (cost one query).
- Both: read-only, group `performance`, cost 1 / 2. The account comes from the GUID (checked offline, T3) and the query runs in
  that account only. NRQL is built only with the `nrql` tag (GUID, transaction name, pattern, bounds are template values, T4).
  Transaction names are NR/app-supplied text: cleaned, capped and inside the untrusted-data envelope (T6).

## Acceptance criteria
- [x] Fixture + contract tests (`tools-apm.test.ts`, sample calls in `contract.test.ts`); account filtering enforced
  (P2-12 `TOOL_CASES`).
- [x] NRQL built via the `nrql` tag only; hostile transaction names/patterns are escaped (tested); names cleaned and enveloped.
- [x] Budget-aware; partial results tested for `analyze_transactions`.
- [x] `docs/reference/tools.md` regenerated; THREAT_MODEL and RESEARCH updated; owner decisions logged.

## Security notes
T3 (account from the GUID, offline), T4 (`nrql` tag only), T6 (transaction names are free text from the instrumented app).

## Docs to update
- Tool reference (generated), THREAT_MODEL, RESEARCH.

## Out of scope
- Non-APM entities, per-transaction time series, trace/segment drill-down, database and external-call breakdown (`run_nrql`).
- Deployment comparison (P6-04), thread/GC analysis (P6-07).
