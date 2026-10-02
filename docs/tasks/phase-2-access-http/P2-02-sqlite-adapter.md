---
id: P2-02
title: SQLite adapter for Node
phase: 2
status: todo
priority: high
depends_on: [P2-01]
adr: [0006]
owner: ""
---

# P2-02 — SQLite adapter for Node

## Scope
- Decide `node:sqlite` vs `better-sqlite3` (stability in target LTS, native-build pain on Windows) → record in ADR-0006.
- WAL mode, busy timeout, file permissions `0600`, migrations on start (flag to disable).
- Backup command `relic-bridge db backup <file>`.

## Acceptance criteria
- [ ] Storage contract suite passes; works on macOS/Windows/Linux CI.

## Security notes
T7: DB file permissions; docs warn the DB + master key together expose all keys.

## Docs to update
- Self-hosting guide.

## Out of scope
- —
