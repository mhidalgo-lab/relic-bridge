# 0006 — SQLite schema for D1 and Node, YAML for stdio

- Status: accepted
- Date: 2026-10-01

## Decision
- One relational schema in **SQLite dialect**, managed with **Drizzle ORM** and SQL migrations committed to the repo.
- Adapters:
  - `d1`: Cloudflare D1 (which is SQLite)
  - `sqlite`: Node (`node:sqlite` if stable in the target LTS, otherwise `better-sqlite3`; decided in P2-02)
  - `yaml`: read-only, for stdio mode; keys referenced as `${ENV_VAR}` or keychain entries, never plaintext
    (plaintext is allowed with a loud warning)
- OAuth server state: KV on Workers. On Node, a KV-compatible table in SQLite (if the spike confirms the library is
  portable) or the Node OAuth server's own adapter.
- A `Storage` interface in `packages/storage` is the only way core and auth reach persistence.

## Consequences
- Identical migrations locally and on Cloudflare; easy backup (a single SQLite file / `wrangler d1 export`).

## Update (P2-02): `node:sqlite` for the Node adapter

Decision: the `sqlite` adapter (`packages/storage-sqlite`) uses Node's built-in `node:sqlite`, not `better-sqlite3`.

- **Availability:** unflagged since Node 22.13 and present in every Node the project supports (`engines` >= 24.11,
  CI on 24 and 26). It is still marked release candidate upstream, so it is wrapped behind our `Storage` interface and
  the contract suite; swapping the engine later touches only `packages/storage-sqlite`.
- **No native build:** nothing to compile or download at install time. That matters for `strictDepBuilds` (no new
  install scripts, THREAT_MODEL T18), Windows without build tools, and the single-file CLI bundle. `better-sqlite3`
  would add a native addon with prebuilt binaries per platform/ABI and an install script.
- **Zero new dependencies,** so nothing new for the supply-chain audit and release-age policy.
- **Features we need are there:** WAL, `busy_timeout`, `VACUUM INTO` (consistent backups), extended error codes,
  parameter binding, `BLOB` as `Uint8Array`.
- **Trade-offs accepted:** the API is synchronous (fine for a single-node personal/small-team server; repositories
  are `async` for the shared interface and D1), and Drizzle 0.45 has no `node:sqlite` driver, so the adapter uses plain
  parameterised SQL against the migrated schema (the schema-drift test in `packages/storage` keeps them aligned).
- **Revisit** if `node:sqlite` regresses in an LTS or a feature we need (for example async I/O for heavy audit
  workloads) is missing.

## Update (P3-02): D1 adapter and migrations on Workers

- The `d1` adapter (`@relic-bridge/storage/d1`) uses plain parameterised SQL against the migrated schema, like the
  `sqlite` adapter; Drizzle stays the source of the schema and the migrations, not a runtime query builder. The D1
  binding is typed structurally, so `packages/storage` does not depend on `@cloudflare/workers-types`.
- D1 has no interactive transactions: every write is a single statement checked by the engine (conditional
  `INSERT … ON CONFLICT DO NOTHING`, `UPDATE … WHERE <guard>`, partial `UPDATE … RETURNING *`), with the outcome read
  from `meta.changes` / `RETURNING`. That keeps `settings.setIfAbsent` and the credential key compare-and-swap atomic
  across isolates, which master-key verification and rotation (ADR-0007) depend on.
- **Migrations:** the embedded `MIGRATIONS` and our forward-only runner (`migrate`, checksums, `schema_migrations`)
  are the single source of truth on D1 too. The Worker applies pending migrations while its runtime boots (once per
  isolate; concurrent boots race safely because each migration is one atomic D1 `batch()`). We do **not** keep a
  `wrangler d1 migrations` directory: it would track a second history (`d1_migrations`) that could drift from ours.
  Consequence: a deploy whose migration fails answers 503 (boot fails closed, retried every 5 s) instead of failing at
  `wrangler deploy` time; migrations must stay small enough for one D1 batch.
