---
id: P8-47
title: whoami keeps callBudget as a deprecated alias of perCallBudget
phase: 8
status: todo
priority: medium
depends_on: []
adr: []
owner: ""
---

# P8-47 — whoami keeps callBudget as a deprecated alias of perCallBudget

## Goal
NEW-12 of the 0.9.0 verification: 0.9.0 renamed `whoami.limits.callBudget` to `perCallBudget` and removed
`callsUsed`/`callsRemaining` with no deprecation path, and the description does not say what `perCallBudget` means.

## Scope
- Return `limits.callBudget` (same value) for the 0.10 line, marked deprecated in the output schema description; removal
  planned for the next minor after that.
- One line in the `whoami` description: `perCallBudget` = the most upstream requests one tool call may make.
- Release note in the changeset naming the rename and the removed counters.

## Acceptance criteria
- [ ] `whoami` returns both fields; schema marks `callBudget` deprecated.
- [ ] Description explains `perCallBudget` (tools/list budget test still passes).
- [ ] Changeset text covers the 0.9.0 rename.

## Security notes
None.

## Docs to update
- `docs/reference/tools.md` (generated), `docs/guide/upgrading.md` or the release notes page if present, changeset.

## Out of scope
- `listChanged` notifications (the transport stays stateless; see P8-38).
