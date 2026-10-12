---
id: P8-29
title: Stabilise timing-sensitive tests (PBKDF2 config-transfer, Windows SQLite)
phase: 8
status: done
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-29 — Stabilise timing-sensitive tests (PBKDF2 config-transfer, Windows SQLite)

## Goal
Two tests fail intermittently under load in CI: the auth config-transfer tests (PBKDF2, 600 000 iterations) and the
storage-sqlite contract tests on the `SQLite adapter (windows-latest)` job (a test timed out at ~9.5 s against the 5 s
default). Make them deterministic without weakening production behaviour.

## Scope
- Root cause: the Windows job runs the `storage-sqlite`, `storage` and `auth` projects in one vitest process, so the
  CPU-bound PBKDF2 tests starve the sqlite tests on the 2-core runner; default 5 s timeouts are too tight for that host.
- Run the Windows job's projects one after the other; set explicit test/hook timeouts for `auth` and `storage-sqlite`
  with a justification comment.
- No test-only lowering of the KDF cost: the minimum stays enforced by `checkKdf`; add a test asserting the production
  default is 600 000.

## Acceptance criteria
- [x] Windows CI job no longer runs PBKDF2 tests concurrently with the sqlite contract tests.
- [x] `auth` and `storage-sqlite` projects have documented timeouts.
- [x] A test asserts `KDF_ITERATIONS`, `MIN_KDF_ITERATIONS` and `newKdf()` stay at 600 000.
- [x] `pnpm lint && pnpm typecheck && pnpm test` pass.

## Security notes
none (production KDF parameters unchanged and asserted).

## Docs to update
- Task index (`pnpm tasks index`).

## Out of scope
- Lowering the PBKDF2 cost for tests (would need a production code path).
