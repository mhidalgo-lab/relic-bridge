---
id: P4-03
title: "Admin UI scaffold (Hono JSX, strict CSP)"
phase: 4
status: todo
priority: high
depends_on: [P4-02]
adr: [0004]
owner: ""
---

# P4-03 — Admin UI scaffold (Hono JSX, strict CSP)

## Scope
- Server-rendered Hono JSX layout, design tokens, light/dark, responsive (usable on the phone).
- Static JS only from `/assets/*` with hashes; CSP `default-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`.
- Accessible components (forms, tables, dialogs), progressive enhancement (works without JS where possible).

## Acceptance criteria
- [ ] CSP has no `unsafe-inline`; axe accessibility checks pass in CI.

## Security notes
T13.

## Docs to update
- `docs/dev/admin-ui.md`.

## Out of scope
- Screens (P4-04).
