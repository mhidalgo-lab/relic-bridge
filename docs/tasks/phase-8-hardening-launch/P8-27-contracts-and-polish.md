---
id: P8-27
title: Error contracts and polish
phase: 8
status: in-progress
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-27 — Error contracts and polish

## Goal
Fix the error-contract and small usability findings of the live test run (2026-10-12): BUG-19, BUG-27, BUG-29,
BUG-28, BUG-08, BUG-21, plus a check that `run_nrql` `format:"csv"` changes the text block.

## Scope
- BUG-19: `get_query_result` for an unknown or expired id gets its own code (`RB_QUERY_NOT_FOUND`) with a "rerun
  run_nrql" hint; verify `timeout_seconds` reaches NerdGraph on the async path and add a test that forces a pending status.
- BUG-27: multi-statement NRQL (`SELECT …; SELECT …`) is refused with a "one statement per call" error.
- BUG-29: details of errors raised locally (time range, query limits, budget, accounts) are not wrapped as untrusted
  New Relic data; details that may carry New Relic text stay enveloped.
- BUG-28: `whoami` shows calls used and remaining, and says what the budget means (per tool call, no reset).
- BUG-08: `list_event_types` flags global/internal event types that cannot be mixed with account data.
- BUG-21: `get_attributes` takes an optional `name_contains` filter.
- `format:"csv"`: verify the text block changes.

## Acceptance criteria
- [ ] Each bug has a regression test that fails before the fix.
- [ ] `RB_QUERY_NOT_FOUND` is documented in the error reference.
- [ ] Tool descriptions stay within the size budgets; generated docs are regenerated.
- [ ] Changeset added.

## Security notes
T6: only details known to be locally produced skip the untrusted-data envelope; the default stays enveloped.

## Docs to update
- Error reference, generated tool reference, `docs/RESEARCH.md` if something new is learned.

## Out of scope
- Anything not listed under Scope.
