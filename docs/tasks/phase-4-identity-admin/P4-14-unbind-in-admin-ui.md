---
id: P4-14
title: "Move a user to another provider from the admin panel"
phase: 4
status: done
priority: low
depends_on: [P4-09, P4-04]
adr: []
owner: claude-agent
---

# P4-14 — Move a user to another provider from the admin panel

## Goal
P4-09 added `POST /users/{id}/unbind` and `relic-bridge user unbind`. Owners who live in the panel should reach it there,
with the same safeguards.

## Scope
- A control on the user page, shown to owners only (the API still decides): a confirmation page that states the
  account-takeover consequence and asks for the user's email again, posting `confirm` to the admin API through the
  in-process call (CSRF token, `Origin`, single-use handle against re-sent forms, like the other destructive forms).
- A flash code for "identity cleared"; the user page shows the bound provider (already in the user view) and
  "not bound" afterwards.

## Acceptance criteria
- [x] Owners can unbind from the user page; admins and members get no control and a `403` page on a forged POST.
- [x] Wrong confirmation changes nothing and re-renders the form without echoing the typed value.
- [x] P2-12 UI matrix rows (HTTP app and Worker) and axe-core pass on the new page and states.

## Security notes
T13, T14: same rules as the API (owner only, not yourself, confirmation, CSRF); the page never reveals the subject.

## Docs to update
- `docs/guide/identity-providers.md`, `docs/guide/admin-access.md`, `docs/THREAT_MODEL.md`.

## Out of scope
- Several identities per user (P4-01 pending decision, option c).
