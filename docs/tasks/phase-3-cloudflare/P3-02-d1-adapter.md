---
id: P3-02
title: D1 storage adapter
phase: 3
status: done
priority: high
depends_on: [P3-01]
adr: [0006]
owner: "claude-agent"
---

# P3-02 — D1 storage adapter

## Goal
The Worker stores everything in Cloudflare D1 through the same `Storage` contract as the Node `sqlite` adapter, so
`apps/worker` serves real routes (MCP, admin API, `/health`) instead of answering 503.

## Scope
- `createD1Storage(db, options)` in `@relic-bridge/storage` (subpath `@relic-bridge/storage/d1`, web-standard,
  ADR-0004). Plain parameterised SQL against the migrated schema, like the `sqlite` adapter (no Drizzle query
  builder at runtime; the Drizzle schema stays the single source of the migrations). The D1 binding is typed
  structurally, so `packages/storage` takes no dependency on `@cloudflare/workers-types`.
- **Atomic writes without interactive transactions** (D1 has none): every write is one statement whose condition is
  evaluated by the engine, and success is read from `meta.changes` / `RETURNING`:
  - `settings.setIfAbsent`: `INSERT … ON CONFLICT(key) DO NOTHING`, true iff one row changed (key check values, P2-03).
  - Credential compare-and-swap (`CredentialPatch.ifKey`): the guard is in the `UPDATE … WHERE` (master-key rotation).
  - `update` methods write only the patched columns in one `UPDATE … RETURNING *` (no read-modify-write window, so
    two concurrent patches of different fields never undo each other).
- Engine errors (UNIQUE / FOREIGN KEY / CHECK / NOT NULL, as D1 reports them) map to the storage error hierarchy.
- **Foreign keys:** verify D1 enforces them without a `PRAGMA` (cascade and restrict as on Node).
- **Migrations — one source of truth:** the embedded `MIGRATIONS` (drizzle-kit SQL, checksummed) applied by our own
  forward-only runner (`migrate`) when the Worker's runtime boots (once per isolate, as part of the existing lazy
  boot), through a D1 driver whose `batch` is a D1 `batch()` (atomic). Two isolates migrating at once: the loser's
  batch rolls back and it re-runs from the versions now recorded instead of failing the boot. No separate
  `wrangler d1 migrations` directory (that would be a second history to keep in sync). Documented in ADR-0006.
- `apps/worker`: `openD1Storage` opens the D1 adapter (replaces the P3-01 stub); missing binding still fails closed.

## Acceptance criteria
- [x] Storage contract suite (`runStorageContract`) passes against D1 inside workerd (`pnpm test:workers`).
- [x] D1-specific tests: concurrent `setIfAbsent` has exactly one winner; a stale `ifKey` changes nothing; foreign keys
      are enforced (unknown reference → `ConflictError`, project delete cascades to grants and tokens); migrations are
      idempotent, refuse a newer/edited database, and two concurrent opens on an empty database both succeed.
- [x] The deployed entry (`src/index.ts` + `wrangler.jsonc`) serves end to end on local D1: `/health` 200, a token
      issued through storage → MCP `initialize` + `tools/list`; wrong token 401.
- [x] Access cache hit = 0 D1 calls (counted with a wrapped binding); the cache-miss count is measured and documented
      (5 reads in 3 sequential waves + the throttled `last_used_at` write; P3-09 brings it to 1).
- [x] `wrangler dev` boots with local D1 and `/health` answers 200 (checked by hand with wrangler 4.144.0, state in a
      temporary `--persist-to` directory).

Also: `createD1Storage(db, { migrate: false })` only verifies the schema version (read-only), like `sqlite`.
`PRAGMA foreign_keys` statements in migrations are skipped by the D1 driver (no-ops inside the batch transaction).

## Security notes
No new data: same schema, ciphertext-only credentials (T7), hashed tokens. Atomic `setIfAbsent` and the key CAS keep
master-key verification and rotation safe across isolates (T7/T8). Errors carry constraint names only, never values.

## Docs to update
- `docs/dev/storage.md` (D1 adapter, atomicity, migrations), ADR-0006 update section, `apps/worker/README.md`,
  `docs/THREAT_MODEL.md`, `docs/RESEARCH.md` (D1 facts).

## Out of scope
- Resolving access in a single D1 query (one joined read instead of three round trips): needs a new `Storage` method
  and changes in `@relic-bridge/auth` → **P3-09**.
- Audit retention purge on Workers (P3-08). Binding-backed rate limiting (P3-04). Required CI job (P3-06).
