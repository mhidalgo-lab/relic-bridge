---
id: P2-09
title: Admin REST API (API-first management)
phase: 2
status: todo
priority: high
depends_on: [P2-04, P2-05, P2-08]
adr: [0008]
owner: ""
---

# P2-09 — Admin REST API

## Goal
Everything the admin panel will do is first an API, usable by the CLI and scripts — on Node and Workers.

## Scope
- `/api/admin/v1/*`: credentials (create+validate, list masked, rotate key, delete), projects, grants, tokens (create shows once, revoke), users (later), audit (query).
- Auth for now: **bootstrap admin token** (`RB_ADMIN_TOKEN` secret, hashed compare) — replaced/augmented by IdP sessions in P4.
- OpenAPI 3.1 document generated from route schemas (`@hono/zod-openapi`); served at `/api/admin/v1/openapi.json` (auth required).
- Input validation, consistent error format, pagination.

## Acceptance criteria
- [ ] Integration tests incl. negative authz (no/invalid admin token).
- [ ] No endpoint ever returns key plaintext or token hashes.

## Security notes
T8, T13 (CSRF N/A for bearer API; documented), T14.

## Docs to update
- `docs/reference/admin-api.md` (generated from OpenAPI).

## Out of scope
- UI.
