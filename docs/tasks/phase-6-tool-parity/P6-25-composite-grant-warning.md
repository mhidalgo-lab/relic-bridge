---
id: P6-25
title: Warn in the grant editor when a composite tool lacks its sibling tools
phase: 6
status: todo
priority: low
depends_on: [P6-21, P4-23]
adr: []
owner: ""
---

# P6-25 — Warn in the grant editor when a composite tool lacks its sibling tools

## Goal
Owner decision (pending-decisions phase 6, Review "composite's grant no longer implies siblings", 2026-10-09): keep
least privilege (a composite's grant does not imply its parts; ungranted sections come back `skipped`), but tell the
admin at grant time so the result isn't a surprise.

## Scope
- Expose, per composite tool, the sibling tools it calls (from the definitions in `packages/core/src/tools/` that use
  `grantedSibling`) as static metadata the admin UI can read.
- Admin UI grant form / grant view: a non-blocking warning listing missing siblings when a composite is selected
  without them. Same warning in the `POST /grants` response `warnings`.

## Acceptance criteria
- [ ] Selecting e.g. a report composite without its sibling tools shows the warning; granting them clears it.
- [ ] `POST /grants` returns the warning; no change to authorization (siblings still not implied).
- [ ] Tests for the metadata (stays in sync with `grantedSibling` usage) and the UI.

## Security notes
No authorization change; least privilege kept (T3).

## Docs to update
- `docs/guide/access-model.md`, `docs/guide/admin-guide.md`.

## Out of scope
- Making a composite grant imply its parts.
