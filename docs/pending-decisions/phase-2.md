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

### P2-02 — `node:sqlite` instead of `better-sqlite3`
- **Context:** ADR-0006 left the Node SQLite engine to P2-02. `node:sqlite` is built in (Node >= 24.11) but still
  release-candidate upstream; `better-sqlite3` is mature but a native addon (install script, per-platform binaries,
  conflicts with `strictDepBuilds` and the single-file CLI bundle).
- **Assumption made:** `node:sqlite`, behind the `Storage` interface and contract suite, with plain parameterised SQL
  (Drizzle 0.45 has no `node:sqlite` driver); recorded as an addendum to ADR-0006.
- **Options:** as assumed; `better-sqlite3` (add it to `allowBuilds`, ship prebuilds); wait for Drizzle 1.0.
- **Needs:** owner OK; revisit if `node:sqlite` regresses on an LTS.

### P2-02 — Adapter lives in its own package, `db backup` is the only DB command so far
- **Context:** Node-only code can't live in `packages/storage` (web-standard, ADR-0004).
- **Assumption made:** new source-only workspace package `@relic-bridge/storage-sqlite`, bundled into the CLI like
  `storage`; `relic-bridge db backup <file> --db <path>` (or `RB_DB_PATH`). No default DB path yet: `serve` (P2-06)
  decides the data-directory layout.
- **Options:** as assumed; publish the adapter as a separate npm package; add `db migrate` / `db restore` in P2-10.
- **Needs:** nothing unless the owner wants a default data directory earlier.

## P2-03 — Secrets encryption

### P2-03 — Master key format `v<N>:<base64>`
- **Context:** ADR-0007 says "32 random bytes, base64" and "key_version", but not how a process learns which version
  a key is.
- **Assumption made:** the version is part of the value (`v2:…`); a bare base64 value is version 1, so plain keys
  from the ADR keep working. `keys generate --key-version <n>` writes the prefix. Recorded as an update in ADR-0007.
- **Options:** as assumed; a separate `RB_MASTER_KEY_VERSION` variable; versions looked up by key check value in the
  database (no prefix, but the database must exist before the key is usable).
- **Needs:** owner OK.

### P2-03 — Derived data key and stored key check values
- **Context:** ADR-0007 allows a data key "derived from or wrapped by" the master key.
- **Assumption made:** HKDF-derived (no wrapped data key to store or lose), plus a one-way key check value per
  version in `settings` (`crypto.key_check.v<N>`) so a wrong key fails at boot with `key_mismatch`. A new key under an
  already-registered version number is refused, which forces a version bump on every new key.
- **Options:** as assumed; wrapped random data keys (rotation would re-wrap one value instead of re-encrypting rows,
  but adds a second secret to back up); no key check values.
- **Needs:** owner OK.

### P2-03 — Rotation is per row (compare-and-swap), not one transaction
- **Context:** the task asked for transactional/resumable rotation; the `Storage` interface has no transactions and D1
  has no interactive ones.
- **Assumption made:** each row is re-encrypted and written with `CredentialPatch.ifKey` (new, enforced in the SQL
  `UPDATE`); a run that stops halfway leaves a mix of versions that the two-key keyring reads, and re-running resumes.
  Rows that change concurrently are reported, not overwritten.
- **Options:** as assumed; add a `Storage.transaction()` for SQLite only.
- **Needs:** nothing unless the owner wants all-or-nothing rotation.

### P2-03 — Master key file support on Node
- **Context:** ADR-0007 mentions "env or a file with 0600 permissions" on Node.
- **Assumption made:** `RB_MASTER_KEY_FILE` / `RB_MASTER_KEY_PREVIOUS_FILE` in the CLI, refused when group or others
  can read them (POSIX); setting both the variable and the file is an error.
- **Options:** as assumed; env only.
- **Needs:** nothing.

### P2-03 — Security review: key check registration is not atomic (SR-4 residual)
- **Context:** `settings` has only `get`/`set`, so registering a key check value is check-then-set. The review added a
  read-back after writing, which makes at least one of two racing processes (different keys, same new version) fail,
  but an interleaving where both pass still exists.
- **Assumption made:** acceptable for now: it needs two instances booting at the same moment with different keys under
  the same version, a misconfiguration the read-back catches in almost every interleaving.
- **Options:** add `settings.setIfAbsent(key, value)` (SQLite `INSERT … ON CONFLICT DO NOTHING`, D1 the same) to the
  storage contract and use it in `verifyKeyChecks` (recommended, small, P2-06 or a follow-up); keep as is.
- **Needs:** owner OK; best done together with wiring the boot check into `serve` (P2-06).

### P2-03 — Security review: replay of an older ciphertext of the same credential
- **Context:** AAD binds a ciphertext to its credential id and key version, not to a row revision. Someone who can write
  the database and holds an older backup can put back that credential's previous ciphertext (e.g. an older NR key) as
  long as its version is still loaded.
- **Assumption made:** accepted: database write access is already game over for availability, and the old value is
  that credential's own earlier key. The rotation guide says to destroy pre-rotation backups when the old key may have
  leaked.
- **Options:** as assumed; add a per-row revision counter to the AAD (format change, needs a migration).
- **Needs:** nothing unless the owner wants rollback protection.


## P2-04 — Access model

### P2-04 — Which credential a grant may use
- **Context:** ADR-0008 lets a grant name a credential but says nothing about whose. Without a rule an admin could,
  by mistake, point a teammate's grant at someone else's personal NR key (their identity, RBAC and concurrency budget).
- **Assumption made:** a grant may use the project's default credential, an unowned (shared) credential, or one owned
  by the grant's own user. Anything else is refused at `createGrant` (`not_permitted`) and denied at request time
  (`credential_not_permitted`). Service grants can therefore only use the project default or a shared key.
- **Options:** as assumed; allow owners/admins to override per grant (needs a flag on the grant); no ownership rule.
- **Needs:** owner OK (affects P2-09 / P2-10 wording).

### P2-04 — A disabled or deleted credential owner stops their key everywhere
- **Context:** a team project's default credential may belong to a person; when that person leaves (user disabled),
  their key would otherwise keep serving everyone's grants.
- **Assumption made:** deny with `credential_owner_disabled` (one extra storage read, only for keys owned by someone
  other than the grant's user). Replace the project default (or re-add the key without an owner) to restore access.
- **Options:** as assumed; keep the key working until it is revoked explicitly.
- **Needs:** owner OK.

### P2-04 — Unvalidated credentials are denied
- **Context:** `reachable_account_ids` is null until a credential is validated, so the account intersection is unknown.
- **Assumption made:** deny (`credential_unvalidated`). `createCredential` always validates before storing, so only rows
  written around the services (or yaml references, which stdio doesn't resolve through this code) are affected.
- **Options:** as assumed; treat "unknown" as "project accounts" (looser, not recommended).
- **Needs:** nothing unless the yaml adapter is ever served over HTTP.

### P2-04 — What `credential revalidate` counts as a refused key
- **Context:** NerdGraph answers a revoked key with HTTP 401 (`RB_AUTH_INVALID_KEY`); a key used against the wrong data
  center gets `RB_AUTH_WRONG_REGION`; HTTP 403 / `ACCESS_DENIED` (`RB_AUTH_FORBIDDEN`) on `actor` is rarer and less clear.
- **Assumption made:** all three mark the credential `invalid` (fail closed); network errors, 429 and 5xx leave the status
  alone and make the command exit 1. A later successful run restores `valid`.
- **Options:** as assumed; treat 403 as transient.
- **Needs:** owner OK; revisit if false `invalid`s show up.

### P2-04 — Grants asking for more than the project allows
- **Context:** the task asks that such a grant "gets the intersection, never more".
- **Assumption made:** `createGrant` stores it as asked and returns warnings naming the tools/accounts with no effect, so
  widening the project later widens the grant too (up to what it asked). Unknown tool names are refused.
- **Options:** as assumed; refuse such grants outright; store only the intersection (then widening the project never
  widens the grant).
- **Needs:** owner OK (the admin API/UI will surface the warnings).
