# Phase 2 — pending decisions

Decisions that agents could not make alone during the autonomous run (2026-10-03). Each entry says what was
assumed so work could continue. Review, then answer in place or move the outcome into an ADR / task file.

Format: `### <task id> — <short title>` then **Context**, **Assumption made**, **Options**, **Needs**.

## Workflow

### ALL — stacked PRs instead of merging to `main`
- **Context:** The owner was away. Every task PR targets the previous task's branch (the first one targets
  `phase/2-access-http` (itself stacked on the tip of Phase 1, `task/P1-17-cli-warnings-docs-accuracy`)), so nothing is merged into `main`.
- **Assumption made:** A dependency counts as satisfied when its task is `review` and its branch is lower in the
  stack. Tasks stay `review`, not `done`, until their PRs are merged.
- **Options:** merge the stack bottom-up (retarget each PR to `main` after its parent merges), or squash-merge the
  tip into `main` in one go.
- **Needs:** owner's merge strategy; then mark merged tasks `done` and run `pnpm tasks index`.

## P2-01 — Storage

### P2-01 — Drizzle 0.45 (stable) rather than the 1.0 release candidate
- **Context:** npm `latest` is `drizzle-orm` 0.45.3 / `drizzle-kit` 0.31.11; 1.0 is still `rc` (it adds a
  `node:sqlite` driver and a new migration folder layout). `drizzle-kit` 0.31 pulls an old esbuild through
  `@esbuild-kit`, overridden to 0.25.12 in `pnpm-workspace.yaml`.
- **Assumption made:** pin the stable 0.x line; migrations are plain SQL, so moving to 1.0 later only touches the
  generator (`scripts/gen-migrations.ts`) and the SQL adapters.
- **Options:** stay on 0.x until 1.0 is final (recommended); adopt the RC now for `node:sqlite` support in P2-02.
- **Needs:** owner OK; revisit when 1.0 ships.

### P2-01 — Own migration runner and `schema_migrations` table
- **Context:** ARCHITECTURE §4 names `schema_migrations`; drizzle's migrator uses `__drizzle_migrations` and
  `wrangler d1 migrations` uses `d1_migrations`, and neither works on both runtimes without file access.
- **Assumption made:** a small runner (`packages/storage/src/migrate.ts`) applies the embedded drizzle-kit SQL on
  Node and D1 alike, with a checksum per migration (forward-only) and one atomic batch per migration.
- **Options:** keep it (one path everywhere); on Workers use `wrangler d1 migrations apply` at deploy time instead
  (P3-02 would then need the SQL in wrangler's folder layout).
- **Needs:** confirm before P3-02.

### P2-01 — Deletion rules
- **Context:** the schema needs `ON DELETE` behaviour for every reference.
- **Assumption made:** deleting a project removes its grants and tokens; deleting a grant removes its tokens;
  deleting a user removes their grants; a credential still referenced by a project or grant can't be deleted
  (`RESTRICT`, so a grant never silently falls back to another key) and a user who owns credentials can't be
  deleted. Revocation (`revoked_at`, `disabled_at`) is the normal path; audit rows have no foreign keys and stay.
- **Options:** as assumed; soft-delete only (no hard deletes at all).
- **Needs:** owner OK (affects P2-09 admin API and P2-10 CLI wording).

### P2-01 — stdio CLI reads the YAML adapter's records synchronously
- **Context:** the `Storage` interface is async; `apps/cli` resolves its project synchronously at startup.
- **Assumption made:** the CLI uses `yamlRecords()` (the same records `createYamlStorage()` serves) so `main` stays
  synchronous; the YAML schema and parser moved to `packages/storage`. `serve` (P2-06) will use `Storage` directly.
- **Options:** as assumed; make `main` async and read through `createYamlStorage()`.
- **Needs:** nothing unless the owner prefers the async route.
