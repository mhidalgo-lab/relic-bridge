---
id: P8-57
title: trace_error(error_group_id) finds the group's traced occurrence
phase: 8
status: done
priority: high
depends_on: []
adr: []
owner: claude-agent
---

# P8-57 — trace_error(error_group_id) finds the group's traced occurrence

## Goal
NEW-13 of the 0.9.1 verification: `trace_error(error_group_id: <APM error group>)` always answers "No traced occurrence
of this error group was found in the window." and, in the same response, "...even though 1159 of 1159 errors carry a
trace id". The same trace works with `trace_id`. Root cause: the occurrence query filters `TransactionError` on
`error.group.guid`, an attribute TransactionError events do not have. Errors Inbox matches a group's events on error
class and message (its `eventsQuery`), so trace_error must do the same.

## Scope
- Look the group up by id through NerdGraph (Errors Inbox `errorGroups` with `filter.ids`, GraphQL variables only), then
  pick the latest traced occurrence with the `nrql` template: the group's entity, `error.class` = group name,
  `error.message` = group message, `traceId IS NOT NULL`, synthetic filter, optional `entity_guid` check.
  New Relic's `eventsQuery` text is never executed (untrusted, T4); `error.group.guid` is not used.
- Unknown group id: a clear `RB_INPUT_INVALID` with a hint. Group whose `source` is not `TransactionError`: say it is not
  supported, with a hint. Custom groups or messages that do not match exactly: fall back to class + entity in the same
  query and say so in a note. Messages the template refuses (control characters, too long): class + entity, with a note.
- The tracing-check note does not contradict itself: when traced errors exist but the group was not matched, say that.
  Keep the BUG-12 spans diagnosis.
- Description and declared cost account for the extra NerdGraph request; output schema unchanged (additive only).

## Acceptance criteria
- [x] The group is looked up by id with GraphQL variables; the occurrence query uses class + message equality on the
      group's entity, never `error.group.guid` and never the group's `eventsQuery` text.
- [x] Regression test: group lookup, occurrence found, then spans, errors and logs run.
- [x] Tests: unknown group, non-TransactionError source, class-only fallback (custom group and message mismatch),
      quotes / backslashes / LIKE wildcards in class and message, a message with control characters.
- [x] When no occurrence matches but spans and traced errors exist, the note says tracing works and none matched the
      group (no "even though" clause); with no spans the BUG-12 diagnosis is unchanged.
- [x] Description query count and declared cost updated; tool-costs test passes.

## Security notes
T4: class and message come from New Relic and go into NRQL only as `nrql` template literals (escaped); equality, not
LIKE, so `%` and `_` in them are not wildcards. The group's `eventsQuery` is not run. T3: the group's entity must decode
to the requested account, or the group is treated as not found.

## Docs to update
- `docs/RESEARCH.md` (TransactionError has no `error.group.guid`; `eventsQuery` matches on class + message).
- `docs/THREAT_MODEL.md` T4 (Errors Inbox values as NRQL literals).
- Generated tool reference, changeset (patch).

## Out of scope
- Following `Span`-sourced (OpenTelemetry) or browser / mobile error groups to a trace.
- `errors[].httpStatus` for string status codes (P8-58).
