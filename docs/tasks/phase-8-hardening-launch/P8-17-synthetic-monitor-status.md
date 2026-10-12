---
id: P8-17
title: Fix list_synthetic_monitors stale NerdGraph status field
phase: 8
status: in-progress
priority: high
depends_on: []
adr: []
owner: claude-agent
---

# P8-17 — Fix list_synthetic_monitors stale NerdGraph status field

## Goal
`list_synthetic_monitors` failed on every call with `Cannot query field "status" on type "SyntheticMonitorEntityOutline"`
(BUG-02, live test run 2026-10-12). Make it work and guard against the same class of stale field.

## Scope
- Read the monitor status from `monitorSummary { status }` instead of a bare `status` on the outline type.
- Map the nested value in the tool (output, `status` filter).
- Regression test on the document; live-suite check that runs the real query against NerdGraph.
- Record the correction in `docs/RESEARCH.md`.

## Acceptance criteria
- [ ] The query selects `monitorSummary { status }` and no bare `status` on the outline fragment.
- [ ] Tool output `status` and the `status` filter use the nested value (tests).
- [ ] Live suite has a schema-validation check for the tool; RESEARCH.md updated.
- [ ] Changeset added.

## Security notes
none (selection still holds no script, credential or header field; every value stays a variable).

## Docs to update
- `docs/RESEARCH.md`.

## Out of scope
- A committed full NerdGraph schema snapshot with offline validation of every document (would need a graphql dependency
  and a large snapshot); the live suite covers it for now.
