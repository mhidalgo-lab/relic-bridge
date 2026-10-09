---
id: P4-23
title: Limit fields on the admin panel grant form
phase: 4
status: review
priority: low
depends_on: [P4-04]
adr: []
owner: claude-agent
---

# P4-23 — Limit fields on the admin panel grant form

## Goal
Owner decision (pending-decisions phase 4, P4-04, 2026-10-09): grant limits can be set when creating a grant in the
admin panel, not only through the API. Grants stay non-editable (revoke and recreate).

## Scope
- Admin UI grant creation form: reuse `LimitsFields` / its parser from `packages/admin-ui/src/screens/shared.tsx`,
  sending `limits` with the existing `POST /grants` body.
- Show the grant's limits (and the effective, project-capped limits warnings) on the grant view.

## Acceptance criteria
- [x] Creating a grant with limits from the panel stores them; invalid values show field errors.
- [x] Limits above the project's are accepted with the existing warning text displayed.
- [x] Admin UI tests; CSRF/escaping checks pass (`check-ui-escaping`).

## Security notes
No new route; existing `POST /grants` authorization applies. T31 write-scope guard unchanged.

## Docs to update
- `docs/guide/admin-guide.md`.

## Out of scope
- `PATCH /grants/{id}` (grants stay immutable).
