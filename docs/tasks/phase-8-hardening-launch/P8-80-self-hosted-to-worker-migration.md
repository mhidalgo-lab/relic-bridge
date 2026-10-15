---
id: P8-80
title: Supported migration from a self-hosted server to the Cloudflare Worker
phase: 8
status: in-progress
priority: high
depends_on: []
adr: [0006, 0007]
owner: claude-agent
---

# P8-80 — Supported migration from a self-hosted server to the Cloudflare Worker

## Goal
Moving a `relic-bridge serve` database onto a Worker had to be done by hand (owner's deploy report, finding 1): a
hand-built D1 SQL dump, `cf:setup` generating a master key that was then replaced with `wrangler secret put`, and an
import that only worked because the dump happened to replace the key check value in `settings` (otherwise the Worker
answers `503 key_mismatch`). The generated key was shown and written to `--backup-file` as "the only copy", then became
obsolete. Make this a supported, documented flow that keeps device tokens, encrypted New Relic keys, projects, grants
and the audit log.

## Scope
- `relic-bridge db export <file> [--format d1] [--db <path>] [--no-audit] [--force]`: writes a SQL file that
  `wrangler d1 execute <db> --remote --file <file>` imports into the Worker's D1 database.
  - Reads a consistent snapshot (one read transaction on a read-only connection; safe while `serve` runs). Never
    decrypts: credentials stay ciphertext, tokens stay hashes. Needs no master key.
  - Refuses a database whose `schema_migrations` or schema differs from this build's embedded migrations.
  - Schema exactly as the embedded migrations produce it (`CREATE … IF NOT EXISTS`), the `schema_migrations` rows (so
    the Worker's boot migration check accepts the database), `PRAGMA defer_foreign_keys = true`, no
    `BEGIN`/`COMMIT`, one row per statement, each statement within D1's 100 KB statement limit.
  - A guard that makes the import fail (D1 rolls a remote import back) when the target already holds users,
    credentials, projects, grants or tokens; stale key check values of the target are replaced by the server's.
  - Excluded: the whole `kv` table (sign-in sessions, login transactions, setup links, OAuth clients, OAuth grants,
    codes and refresh tokens, remembered consents, task records, counters): ephemeral or bound to the old public URL.
    Audit log included by default, `--no-audit` leaves it out.
  - File created `0600`, never overwritten without `--force`; strings with control characters or NUL and BLOBs are
    written as hex literals.
- `pnpm cf:setup --master-key-stdin`: use the existing master key (piped on stdin, or a hidden prompt on a terminal)
  instead of generating one. Never printed, never written to `--backup-file`; replaces an existing Worker key only with
  `--replace-master-key`; restoring a missing key next to an existing `RB_ADMIN_TOKEN` is allowed.
- Round-trip test: SQLite database with the real migrations and representative rows → export → import into D1 in
  workerd → Worker booted with the same master key: the token authenticates and the credential decrypts.
- Docs: "Migrate from a self-hosted server" section of the Cloudflare guide, CLI reference and help, THREAT_MODEL,
  changeset.

## Acceptance criteria
- [ ] `db export` writes a D1-importable file from a live database without decrypting anything; mode `0600`; refuses an
      existing file unless `--force`; refuses a schema that does not match this build.
- [ ] The file has the embedded-migration schema, the `schema_migrations` rows, `PRAGMA defer_foreign_keys = true`,
      no transaction statements, no `kv` rows; audit rows unless `--no-audit`.
- [ ] Unit tests: escaping (quotes, NUL and control characters, blobs, unicode, large integers), file mode, overwrite
      refusal and `--force`, exclusions, statement size limit, schema mismatch refusal.
- [ ] Round-trip test in workerd: export → D1 import → Worker with the same master key serves the token and decrypts
      the credential; a second import into the populated database is refused by the guard.
- [ ] `cf:setup --master-key-stdin` sends the given key, never reveals it or writes it to the backup file, validates
      its format; tests.
- [ ] "Migrate from a self-hosted server" section: order, what moves and what does not, rollback, never regenerate
      the master key; CLI reference and help; THREAT_MODEL; changeset.
- [ ] Verified against a real Cloudflare account (left to the owner: needs a live deploy).

## Security notes
T7 (the export holds credential ciphertext and token hashes: it must never sit next to the master key; `0600`; no
plaintext), T8 (the master key travels on stdin only, never argv, never printed or written to the backup file), T17
(audit log preserved by default), T23 (no secret as a flag).

## Docs to update
- `docs/guide/cloudflare-deploy.md` (new "Migrate from a self-hosted server" section only, plus cross-links),
  `docs/reference/cli.md`, `apps/cli/src/args.ts` help, `docs/THREAT_MODEL.md`, `docs/RESEARCH.md` (D1 import facts),
  changeset.

## Out of scope
- Findings 2-8 of the same report (other tasks).
- The reverse direction (D1 to SQLite) and moving OAuth connections or sessions.
