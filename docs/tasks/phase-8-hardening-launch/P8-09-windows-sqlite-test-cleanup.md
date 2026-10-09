---
id: P8-09
title: Fix EPERM temp-dir cleanup in the SQLite tests on Windows
phase: 8
status: todo
priority: medium
depends_on: []
adr: []
owner: ""
---

# P8-09 — Fix EPERM temp-dir cleanup in the SQLite tests on Windows

## Goal
The `SQLite adapter (windows-latest)` CI job fails: `packages/storage-sqlite/test/sqlite.test.ts` `afterAll` removes
its `rb-sqlite-*` temp directory while a database file in it is still open (`EPERM ... syscall: 'rm'`). Windows
refuses to delete open files, so some test leaves a handle open.

## Scope
- Find the test(s) that leave a `DatabaseSync` / storage handle open (or WAL/SHM files locked) and close them; make
  cleanup robust (close before rm). Check the other test files of the `storage-sqlite`, `storage`, `auth` and `cli`
  projects that the Windows job runs for the same pattern.

## Acceptance criteria
- [ ] The `sqlite-os` matrix job passes on `windows-latest` and `macos-latest`.
- [ ] No test hides the error (no swallowing `EPERM` in cleanup).

## Security notes
None (test-only).

## Docs to update
- None.

## Out of scope
- Product code changes unless a handle leak is in product code (then fix it and say so in the PR).
