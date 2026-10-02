---
id: P1-03
title: NRQL execution engine (sync, async, cross-account)
phase: 1
status: todo
priority: high
depends_on: [P1-02]
adr: [0005, 0010]
owner: ""
---

# P1-03 — NRQL execution engine (sync, async, cross-account)

## Goal
Run any NRQL reliably within platform limits, returning a handle when it can't finish in time.

## Scope
- `runNrql({ nrql, accounts, timeoutS, mode: 'auto'|'sync'|'async', maxPolls })`.
- Single account: `actor.account(id).nrql`; multiple: `actor.nrql(accounts: [...])`.
- `auto`: sync with explicit timeout; on timeout/long query, async with `queryProgress` polling honouring `retryAfter` and budget; if not complete → return `{ status: 'pending', queryId, retryAfterS, expiresAt }`.
- `getQueryResult({ queryId, account })`: follows the "same account as original" rule.
- **Async availability:** if async isn't available for the account (docs tie it to Data Plus; live result from P0-09), `auto`
  falls back to sync with the maximum allowed timeout and returns a clear `RB_NERDGRAPH_TIMEOUT` hint to narrow the query.
- Select **only needed fields**: `results`, `metadata { eventTypes facets messages timeWindow }`, `rawResponse` cost data
  (`performanceStats.inspectedCount`, `queryUsage.scannedEvents`), `queryProgress`. Selecting everything cost ~3.6 s vs ~0.3 s
  in P0-09. **Never** select `staticChartUrl` / `embeddedChartUrl` (T26) or `eventDefinitions` / `suggestedQueries` by default.
- Capture result metadata (facets, timeseries, warnings from `metadata.messages`, e.g. "No events found").
- Fixtures: `packages/core/test/fixtures/nerdgraph/` (sanitized P0-09 captures).

## Acceptance criteria
- [ ] Fixture tests for sync, async-complete, async-pending-handle, cross-account, NRQL syntax error message passed back helpfully.
- [ ] Polling never exceeds the budget (test with tiny budget).

## Security notes
T5.

## Docs to update
- `docs/dev/core.md`.

## Out of scope
- Query limits (P1-04).
