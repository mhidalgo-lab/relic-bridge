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

## P2-05 — Access tokens

### P2-05 — Token shape and the `env` segment
- **Context:** the task sketched `rb_<env?>_<base62 32 bytes>_<crc32>` and an 8-character display prefix; the schema
  allows a 12-character prefix and the gitleaks rule expects a 2-8 character env.
- **Assumption made:** `env` is always present, 2-4 lowercase letters/digits, default `live` (no deployment sets anything
  else yet); the secret is 43 uniform base62 characters (≈ 256 bits); the checksum is CRC-32 in 6 base62 characters; the
  display prefix is the first 12 characters (`rb_live_Ab3d`), so tokens of the same env can be told apart.
- **Options:** as assumed; make `env` configurable per deployment (`RB_TOKEN_ENV`, e.g. `home`, `work`) in P2-06/P2-10;
  drop `env` altogether (then the second gitleaks alternative must change).
- **Needs:** owner OK before the first real token is issued (changing the shape later invalidates nothing stored, since
  only hashes are kept, but scanners and docs would need updating).

### P2-05 — Unkeyed SHA-256 at rest
- **Context:** an HMAC with a server-side pepper would make a stolen DB dump useless even for (impossible) brute force,
  but ties every token to a second secret (rotation, Worker secret) and diverges from ADR-0009 / the schema comment.
- **Assumption made:** plain SHA-256: the input is a uniformly random 256-bit secret, so the hash is not invertible or
  guessable; matches ADR-0009.
- **Options:** as assumed; HMAC-SHA-256 keyed from the master key (would need a new ADR and a re-issue of all tokens).
- **Needs:** nothing unless the owner prefers defence in depth here.

### P2-05 — Token lifetime rules
- **Context:** the task set a 90-day default and allows `never` with a warning.
- **Assumption made:** any positive TTL is accepted (no upper cap); `never` and "longer than the grant" only warn
  (`token_never_expires`, `token_outlives_grant`), because the grant's expiry is enforced on every request anyway.
  Issuing requires a live grant; a disabled project or user does not block issuing (the resolver denies at use).
- **Options:** as assumed; cap TTLs (e.g. 1 year) unless `never`; clamp to the grant's expiry.
- **Needs:** owner OK (P2-10 CLI wording).

## P2-06 — HTTP app and `serve`

### P2-06 — Default data directory and database path
- **Context:** P2-02 left the default database location to `serve`.
- **Assumption made:** `--db` > `RB_DB_PATH` > `<data dir>/relic-bridge.db`, where the data directory is `RB_DATA_DIR`,
  else `$XDG_DATA_HOME/relic-bridge` or `~/.local/share/relic-bridge` (Linux and others),
  `~/Library/Application Support/relic-bridge` (macOS), `%LOCALAPPDATA%\relic-bridge` (Windows). Docker (P2-11) will
  set `RB_DATA_DIR=/data`. The other DB commands (`db backup`, `keys rotate`, `credential revalidate`) still require
  `--db` / `RB_DB_PATH`.
- **Options:** as assumed; make every DB command use the same default (convenient, but a typo'd environment could then
  silently act on the default database); a config file listing the path.
- **Needs:** owner OK; decide whether P2-10 commands should share the default.

### P2-06 — `subscriptions/listen` is closed at once
- **Context:** Claude Code 2.1.287 opens a `subscriptions/listen` and holds it. We push no notifications yet.
- **Assumption made:** advertise `tools.listChanged: false` on HTTP; the SDK acknowledges the listen with an empty
  honoured filter and ends it gracefully in the same response. Nothing is held open (cheap on Workers, no rate-limit
  slot). The request is flagged (`listen: true`) for P2-07.
- **Options:** as assumed; hold it open with a capped duration (e.g. 5 min) and keep-alives, which only matters once
  grants can change tools live and we publish `tools/list_changed`.
- **Needs:** confirm against real clients (P5-06): if a client re-opens a closed listen in a tight loop, switch to the
  capped hold.

### P2-06 — Pass-through mode split into P2-15
- **Context:** the task listed an optional pass-through mode (client-supplied NR key) that must "still be rate-limited";
  rate limiting is P2-07, which depends on P2-06.
- **Assumption made:** moved to a new task P2-15 (depends on P2-06 and P2-07), off by default.
- **Options:** as assumed; drop pass-through from v0.2 entirely.
- **Needs:** owner OK.

### P2-06 — HTTP defaults
- **Context:** several limits had no specified values.
- **Assumption made:** access cache 30 s (configurable 0-60 s); request body 1 MiB; one 180 s deadline for the whole
  MCP exchange (tools poll NRQL for up to 120 s); Node `headersTimeout` 20 s, `requestTimeout` 200 s, keep-alive 5 s;
  per-request subrequest budget 1000 on Node; `/version` public (behind the Host check). A non-loopback bind without
  `RB_ALLOWED_HOSTS` refuses to start rather than guessing the public name; `RB_ALLOWED_HOSTS=*` is allowed with a
  warning.
- **Options:** as assumed; shorter cache (10 s) for faster revocation; hide `/version` behind auth.
- **Needs:** owner OK.

### P2-06 — Storage failures answer 503, not 401
- **Context:** T19 asks for one answer for every *denial*; a database outage is not a denial.
- **Assumption made:** storage errors during authentication answer `503` + `Retry-After` (fail closed), so clients
  don't discard a valid token. This reveals only that the server is unhealthy, independent of slug or token.
- **Options:** as assumed; answer 401 for everything (clients may then prompt for re-authentication during an outage).
- **Needs:** nothing unless the owner prefers 401.

### P2-07 — Rate limit defaults and failure behaviour
- **Context:** no figures were specified; the limiter must also not become an oracle for token validity.
- **Assumption made:** IP 600/min and auth failures 10 per 5 min (pre-auth), token 120/min, grant 300/min (a grant's own
  `rateLimit` replaces the default). All tunable via `RB_RATE_LIMIT_*` (`off` per rule or `RB_RATE_LIMIT=off`). The
  failure throttle refuses *every* request from a locked IP (valid token or not), accepting that devices behind one NAT
  share the budget. A limiter that errors fails **open** (logged). `RB_TRUSTED_PROXY_HOPS` defaults to 0 (forwarded
  headers ignored).
- **Options:** as assumed; fail closed on limiter errors (503); let valid tokens through a locked IP (leaks validity,
  rejected); a global per-credential limit now (P7-10).
- **Needs:** owner OK of the figures, once real clients (P5-06, Claude mobile) show their request patterns.

