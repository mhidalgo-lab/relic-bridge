---
id: P6-03
title: "Tool: list_error_groups (Errors Inbox)"
phase: 6
status: review
priority: high
depends_on: [P5-07]
adr: []
owner: claude-agent
---

# P6-03 — Tool: list_error_groups (Errors Inbox)

## Scope
- `list_error_groups`: `actor.errorsInbox.errorGroups(cursor, entityGuids, filter, query, sortBy, timeWindow)`. Filters `states`
  (UNRESOLVED, RESOLVED, IGNORED), `entity_guid` (implies its account), `contains` (New Relic's free-text `query`), `assigned`
  (`isAssigned`); `sort_by` occurrences | last_seen | first_seen (DESC); `time_range` (default last 24 hours, capped by the
  connection's window limit); `account`, `cursor`, `minimal_output`.
- Output per group: id, name, message, state, issue type, source, entity GUID, occurrences in the window (total, expected, first
  and last in window), first/last seen, regressed-at, `eventsQuery` (to run with `run_nrql`), link. Total match count.
- One account per call (`filter.accountIds`), read-only, cost 1, group `incident-response`. A group is shown only if its entity
  GUID decodes to the requested, allowed account; otherwise it is dropped and `hiddenOutsideScope` is set (T3).
- Name, message, query and link are NR/app-supplied: cleaned and inside the untrusted-data envelope (T6).
- Not selected: the assignee (an email address, PII) and per-group `resources`.

## Acceptance criteria
- [x] Fixture + contract tests (`tools-errors.test.ts`, sample call in `contract.test.ts`); account filtering enforced
  (P2-12 `TOOL_CASES`, hostile mock).
- [x] Every value is a GraphQL variable; names, messages and queries are inside the untrusted-data envelope.
- [x] `docs/reference/tools.md` regenerated; THREAT_MODEL and RESEARCH updated.

## Security notes
T3 (group re-checked against its entity GUID, dropped otherwise), T4 (variables only), T6 (error messages and stack-derived text
are prime prompt-injection carriers: enveloped).

## Docs to update
- Tool reference (generated), THREAT_MODEL, RESEARCH.

## Out of scope
- Changing state or assignment (P7-09-style mutations); `resources`, version fields and per-group event drill-down (`run_nrql`
  with the returned `events_query` covers it); multi-account listing in one call.
