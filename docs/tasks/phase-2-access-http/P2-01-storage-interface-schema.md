---
id: P2-01
title: Storage interface, Drizzle schema and migrations
phase: 2
status: todo
priority: high
depends_on: [P1-15]
adr: [0006, 0008]
owner: ""
---

# P2-01 — Storage interface, Drizzle schema and migrations

## Scope
- `Storage` interface (repositories: users, credentials, projects, grants, accessTokens, auditLog, settings, kv) — async, adapter-agnostic.
- Drizzle schema (SQLite dialect) for the tables in ARCHITECTURE §4; SQL migrations committed; `schema_migrations`.
- Shared repository test suite that every adapter must pass (`runStorageContract(adapter)`).
- `yaml` adapter refactored onto the interface (read-only).

## Acceptance criteria
- [ ] Contract suite passes for `yaml` (read paths) and an in-memory adapter.
- [ ] Migrations are forward-only and idempotent.

## Security notes
T7 (ciphertext columns only), T17 (audit append-only: no update/delete API except retention job).

## Docs to update
- ARCHITECTURE §4 if schema changes; `docs/dev/storage.md`.

## Out of scope
- SQLite/D1 adapters (P2-02, P3-02).
