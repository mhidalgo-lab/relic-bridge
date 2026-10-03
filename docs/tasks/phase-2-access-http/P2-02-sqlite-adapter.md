---
id: P2-02
title: SQLite adapter for Node
phase: 2
status: review
priority: high
depends_on: [P2-01]
adr: [0006]
owner: claude-agent
---

# P2-02 — SQLite adapter for Node

## Scope
- New package `@relic-bridge/storage-sqlite` (`packages/storage-sqlite`, `runtime: node`): `openSqliteStorage(options)`
  returns a `Storage` (`kind: 'sqlite'`). Node-only code stays out of `packages/core|auth|http-app|storage` (ADR-0004).
- Decide `node:sqlite` vs `better-sqlite3` (stability in the target Node >= 24.11, native-build pain on Windows) and
  record it in ADR-0006 (addendum, not a rewrite).
- Open the file with: parent directory `0700` and file `0600` (created before SQLite touches it; best effort on
  Windows), `PRAGMA foreign_keys = ON`, `journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout`.
- Run `migrate()` on open (default); `migrate: false` only verifies that the schema is current and fails otherwise.
- Map engine errors to `ConflictError` / `InvalidInputError` / `NotFoundError`; never put column values in messages.
- Backup: `relic-bridge db backup <file> --db <path>` (consistent snapshot via `VACUUM INTO`, file `0600`, refuses to
  overwrite). `--db` or `RB_DB_PATH` names the database. Serving from the DB is P2-06, not here.
- CI: run the SQLite tests on Linux, macOS and Windows.

## Acceptance criteria
- [x] Storage contract suite passes against the SQLite adapter (file and `:memory:`); works on macOS/Windows/Linux CI.
- [x] `node:sqlite` vs `better-sqlite3` decision recorded in ADR-0006 with the reasons.
- [x] File mode `0600` (POSIX), WAL, busy timeout and foreign keys on are asserted by tests.
- [x] Migrations run on open; `migrate: false` refuses an out-of-date database.
- [x] `relic-bridge db backup <file>` produces an openable, equal copy with mode `0600` and never overwrites.
- [x] Self-hosting guide documents the DB file, permissions, backup, and the DB + master key warning (T7).

## Security notes
T7: DB file permissions; docs warn the DB + master key together expose all keys. The adapter only ever stores
ciphertext, hashes and metadata (schema guarantees); the backup file inherits the same `0600` rule.

## Docs to update
- Self-hosting guide (`docs/guide/self-hosting.md`, created here with the database part; P2-06/P2-11/P2-13 extend it).
- `docs/dev/storage.md`, `docs/guide/configuration.md`, ADR-0006, `docs/THREAT_MODEL.md` (T7 row) - done.

## Out of scope
- Serving MCP from the database, `db migrate` / `db restore` commands, encryption (P2-03), D1 (P3-02).
