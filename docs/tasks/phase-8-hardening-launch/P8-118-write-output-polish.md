---
id: P8-118
title: Write tool output - full change event plan, dashboard checks on confirm
phase: 8
status: review
priority: low
depends_on: []
adr: []
owner: claude-agent
---

# P8-118 — Write tool output: full change event plan, dashboard checks on confirm

## Goal
0.13.1 retest (2026-10-23), sandbox writes through Claude Code:
- `create_change_event` `plan` (dry run and applied) lists `changeType`, `version`, `commit`, `featureFlagId`,
  `shortDescription`, `user` and `groupId`, but not `description`, `changelog` or `deep_link`, which are sent too. A
  dry run therefore doesn't show everything the real run would record.
- A confirmed `create_dashboard` runs the per-query check before the approval (P8-101) but returns `checks: []`, so the
  result doesn't show that the queries were checked.

## Scope
- Add `description`, `changelog` and `deepLink` to the change event `plan` (output schema and both paths), only when
  given, the same way as the other fields.
- Return the confirm path's `checks` in the applied `create_dashboard` result (and in the gate-stopped result if the
  shape allows it).

## Acceptance criteria
- [x] Tests: dry run and applied change events echo the three fields; an applied dashboard has the checks that ran.
- [x] Generated tool docs regenerated if output schemas change.

## Security notes
None: the values are the caller's own arguments (already checked), and the checks are the existing probe results.

## Docs to update
- Generated tool docs, changeset (patch).

## Out of scope
- Changing what is sent to New Relic.
