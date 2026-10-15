---
id: P8-74
title: CLI fixes - read-only doctor, purge argument checks, import cap, audit-off warning
phase: 8
status: review
priority: low
depends_on: []
adr: []
owner: claude-agent
---

# P8-74 — CLI fixes: read-only doctor, purge argument checks, import cap, audit-off warning

## Goal
Four small CLI defects found in review. All are in `apps/cli`.

1. **`doctor` is not read-only.** `checkDatabase` (`apps/cli/src/manage/doctor.ts`) reads the file mode, then calls
   `openSqliteStorage({ path, migrate: false })`. That function runs `prepareDatabaseFile`
   (`packages/storage-sqlite/src/file.ts`), which `chmod`s a group/world-accessible file to `0600`, and sets
   `PRAGMA journal_mode = WAL` (`packages/storage-sqlite/src/index.ts`). The "run: chmod 600" warning is then printed from
   the stale pre-open mode, for a file that has just been fixed.
2. **`audit purge --older-than-days` validation.** `parseCliArgs` (`apps/cli/src/args.ts`) already rejects `NaN`, fractions
   and values below 1 (`/^\d{1,5}$/`), so the command line is guarded; but `auditPurge` (`apps/cli/src/audit.ts`) trusts
   its input (`Number(options.olderThanDays)`) and `apps/cli/test/audit.test.ts` covers `0` and `x` only, not `1.5`,
   `NaN`, `1e3` or whitespace. A non-CLI caller (or a future parser change) can pass `NaN`, which skips the `days <= 0`
   guard.
3. **Config import caps disagree.** `MAX_IMPORT_BYTES` is 1 MiB in `apps/cli/src/manage/transfer.ts` while the Admin API's
   default body limit is 64 KiB (`DEFAULT_ADMIN_MAX_BODY_BYTES` in `packages/http-app/src/admin/api.ts`), so the CLI
   accepts files the API then refuses.
4. **The `RB_AUDIT=off` warning understates the effect.** `auditSettings` in `apps/cli/src/serve.ts` warns that "tool calls
   and refused requests are not recorded", while `docs/guide/self-hosting.md` says it also stops admin changes: no audit row
   of any kind is written.

## Scope
- `doctor`: open the database without side effects (no chmod, no WAL change, no migration) by adding a read-only open (or an
  option such as `{ readOnly: true, repair: false }`) to `openSqliteStorage`, or by checking with a plain read-only
  connection. Report the mode, and print the fix command. Moving the fixes to an explicit flag (`doctor --fix`) or command
  is allowed but must be opt-in and say what it changed.
- `auditPurge`: validate with the same rule as the parser (shared helper), return a usage error for anything but a whole
  number of at least 1. Add tests for `1.5`, `NaN`, `Infinity`, `1e3`, ` 5 `, `-1`, `0x10` at both layers.
- Choose one import cap (decision: keep the API's 64 KiB, or raise the API default for this route to the CLI's value) and
  make the CLI and the API agree; the CLI should refuse early with the number in the message.
- Warning text: "`RB_AUDIT=off` disables every audit row (tool calls, refusals and admin changes)". Check the other
  places that describe it (`docs/guide/audit-log.md`, `docs/guide/configuration.md`).

## Acceptance criteria
- [x] Running `doctor` on a database with mode `0644` leaves mode, journal mode and file content unchanged (test with a
      temporary database, comparing before and after) and prints the chmod hint.
- [x] `audit purge` refuses every non-integer or less-than-1 value at the parser and in `auditPurge` (tests above).
- [x] The import file cap and the API body cap are the same documented number (test of the CLI refusal and of the API).
- [x] The `RB_AUDIT=off` warning names every kind of row that is lost (test on the warning text).
- [x] If an explicit fix flag is added, it is covered by a test and appears in `docs/reference/cli.md`.

## Outcome and decisions
- `openSqliteStorage({ readOnly: true })`: no file creation, chmod, journal-mode/synchronous pragma or migration;
  writes fail. SQLite may still create the `-wal`/`-shm` side files of a WAL database in order to read it (documented).
  `doctor` uses it. `doctor --fix` (opt-in) sets the database file mode to `0600` and reports the change in the
  `database` line. Without `--fix`, the warning gives the `chmod 600` command and mentions `--fix`.
- `parseOlderThanDays` (in `apps/cli/src/args.ts`) is shared by the parser and `auditPurge`. Surrounding blanks are
  accepted (` 5 ` is 5), as the parser already did. Every other non-integer and anything below 1 is refused, and
  `auditPurge` exits 2 with nothing deleted.
- **Import cap: 1 MiB for both.** The API's `POST /config/import` now takes `CONFIG_IMPORT_MAX_BYTES` (1 MiB); the
  other admin routes keep 64 KiB. Keeping 64 KiB would have refused bundles the schema allows: `secrets.sealed`
  alone may be 300,000 characters, plus 200 users, 100 keys, 100 projects and 500 grants. The body is still read only
  after authentication, and the Worker's outer 1 MiB limit is the same. The CLI checks both the file and the JSON
  request it builds (YAML can grow when converted to JSON).
- `AUDIT_OFF_WARNING` (http-app) is the one string used by `serve` and the Worker. The audit-log guide now also says
  that local management commands still record their rows. `configuration.md` does not describe `RB_AUDIT`
  (stdio has no audit), so it is unchanged, and the wording in `self-hosting.md` was already right.

## Security notes
T28 (doctor must not change the system it diagnoses; printed strings stay scrubbed), T17 (the audit-off warning must not
understate a loss of accountability), T29 (import size cap).

## Docs to update
- `docs/reference/cli.md`, `docs/guide/troubleshooting.md`, `docs/guide/migrating-config.md`, `docs/guide/audit-log.md`,
  `docs/guide/self-hosting.md` if wording changes, changeset.

## Out of scope
- Changing the default retention; changing database file permissions policy at `serve` start-up.
