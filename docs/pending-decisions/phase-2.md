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
- **Update (P3-13):** the "refuse every request from a locked IP" rule was replaced: valid tokens now go through a
  locked IP (see the review entry "Auth-failure throttle also refuses valid tokens" below).


### P2-08 — Audit log defaults and shape
- **Context:** the task left masking, retention and what counts as an audited event open (THREAT_MODEL open question).
- **Assumption made:** on by default; NRQL stored masked (`RB_AUDIT_NRQL=mask`: strings and numbers become `?`, keywords,
  names, `SINCE`/`LIMIT` kept), truncated to 2000 chars; retention 90 days (`RB_AUDIT_RETENTION_DAYS`, `0` = forever),
  purged at startup and hourly. Refusal rows (new kind `auth`, one forward-only migration) include the client IP
  (`RB_AUDIT_CLIENT_IP=off` to drop) and are capped at 120/min with a summary row. Rows carry ids, not labels (the
  project slug is kept in `details`). Only `tools/call`, refusals and admin changes are audited, not `tools/list`.
- **Options:** as assumed; default `hash` or `off` for stricter privacy; store labels in rows; audit every MCP request;
  hash-chain rows for tamper evidence (would be a new task).
- **Needs:** owner OK of the defaults.

## P2-09 — Admin REST API

### P2-09 — Admin authentication is one static bootstrap token, off by default
- **Context:** ADR-0009 puts admin identity (IdPs) in Phase 4; the task asked for `RB_ADMIN_TOKEN` in the meantime.
  THREAT_MODEL T14 describes the Phase 4 bootstrap as single-use and expiring.
- **Assumption made:** `RB_ADMIN_TOKEN` (or `RB_ADMIN_TOKEN_FILE`, `0600`) enables `/api/admin/v1`; without it every
  admin path is `404`. Any 32-512 printable characters without spaces (refused at boot otherwise; `openssl rand
  -base64 32` suggested), kept in memory only as a SHA-256 digest, never stored in the database. Every holder is a full
  admin; audit rows name the actor `admin_token` (no user). Rotation = restart with a new value. No `rb_`-style format
  (so log redaction can't recognise it; it is never logged anyway). Update: `relic-bridge admin-token generate` now prints a suitable random token (P2-10); the
  format is still unrecognisable to redaction and secret scanners.
- **Options:** as assumed; require a recognisable format (`rb_adm_…`, matched by gitleaks/redaction) generated by a CLI
  command (`admin-token generate` exists since P2-10 but prints a plain random string); store a hashed admin token in the database so it can be rotated without a
  restart (and listed/revoked, like device tokens).
- **Needs:** owner OK; decide the format before P2-10 documents it.

### P2-09 — HTTP status codes and response envelope
- **Context:** the task asked for a consistent error model without fixing codes.
- **Assumption made:** `{ "error": { code, message, field?, detail? } }`; `400` validation, `401` auth, `404` not found
  (also for well-formed ids of another kind), `409` duplicate / in use / concurrent change / read-only storage, `413`,
  `415`, `422` for a rule refusal (`not_permitted`) and for a key New Relic refuses (`key_rejected`), `429`, `502` when
  New Relic can't be asked (`upstream_unavailable`, nothing stored), `503` storage/crypto. Single resources are
  `{ data, warnings? }`, lists `{ data, nextCursor }`, deletes `204`. Token lifetimes are `ttlSeconds` (or `'never'`) in
  the API, milliseconds in the service.
- **Options:** as assumed; RFC 9457 `application/problem+json`; `403` instead of `422` for `not_permitted`.
- **Needs:** owner OK before P2-10 and the admin panel (P4) depend on it.

### P2-09 — Scope additions and omissions
- **Context:** the task listed users as "later" and credentials as "create, list, rotate, delete".
- **Assumption made:** minimal user endpoints (list, get, create, update role/display name/disabled) are included, since
  user grants and personal keys need a user id; credentials also get `PATCH` (label) and `revalidate`; grants get
  `revoke` and `delete` but no general update (create a new grant instead); no user delete (disable instead) and no
  credential revoke (delete, refused while in use).
- **Options:** as assumed; add grant `PATCH` (tools, accounts, limits, expiry) when the admin panel needs it.
- **Needs:** nothing unless the owner wants grant updates in v0.2.

### P2-09 — Generated reference checked by a test, not `pnpm lint`
- **Context:** the other generators run as Node scripts in `pnpm lint`, before `pnpm build`; the admin API imports
  workspace packages that resolve to their (not yet built) `dist` outside Vitest.
- **Assumption made:** `docs/reference/admin-api.md` is a Vitest file snapshot (`packages/http-app/test/admin-docs.test.ts`):
  `pnpm test` fails when it is stale, `pnpm docs:admin-api` rewrites it.
- **Options:** as assumed; build before lint in CI and use a Node script.
- **Needs:** nothing.

### P2-09 — Lists are paged in memory
- **Context:** the `Storage` list methods return every row (no limit/cursor) except the audit log.
- **Assumption made:** the API sorts by `(createdAt, id)` and pages in memory with an opaque cursor; fine for personal
  and small-team instances (tens to hundreds of rows). The audit log pages in the database (`beforeId`).
- **Options:** as assumed; add `limit`/`after` to the storage list methods when an instance grows (contract change).
- **Needs:** nothing for v0.2.

### P2-10 — Local mode runs the admin API in-process
- **Context:** the task wants the same commands against a local database and a remote instance, and the P2-09 notes
  suggested calling the domain services directly for local mode.
- **Assumption made:** local mode mounts `createAdminApi` over SQLite in the CLI process (random per-process bearer, no
  network) and speaks the same HTTP-shaped requests as remote mode. One code path, so rules, validation, masking and
  audit cannot drift; local audit rows record `via: cli` plus the OS user (`details.cliUser`), actor ids stay empty.
- **Options:** as assumed; call the `@relic-bridge/auth` services directly (two code paths to keep in sync).
- **Needs:** nothing.

### P2-10 — Admin token is never a command-line option
- **Context:** the task text sketched `--remote https://… --admin-token …`.
- **Assumption made:** `--admin-token` does not exist (it would leak through process lists and shell history). The token
  comes from `RB_ADMIN_TOKEN` / `RB_ADMIN_TOKEN_FILE` (0600) or a hidden prompt; `--remote` can also be `RB_REMOTE`.
- **Options:** as assumed; a `--admin-token-file` flag; a stored profile file (`~/.config/relic-bridge/remotes.json`)
  once there are several instances to manage.
- **Needs:** nothing.

### P2-10 — Wizard is flag-driven with prompts only on a terminal; master key written to a file
- **Context:** `init` must work on a headless server and on a laptop.
- **Assumption made:** `init` generates the master key into a file (mode 0600, never overwritten) when
  none is configured (**changed by the Phase 2 review:** the default moved from `<data dir>/master.key` to
  `~/.config/relic-bridge/master.key`, and a path in the database's directory is refused, because the security guide
  says the key must never sit next to the database), refuses an existing database without its key, and creates the first credential/project/grant/token
  only when asked (flags, or answers on a terminal); otherwise it skips the step and prints the command to run.
  The service grant for the first device is named `<slug>-devices`. Device tokens use the server default (90 days).
- **Options:** as assumed; print the master key instead of writing it; always run all steps.
- **Needs:** owner OK before v0.2 docs are final.

### P2-10 — Client snippets
- **Context:** "ready-to-paste client configs" depend on each client's current remote-server syntax.
- **Assumption made:** Claude Code `claude mcp add --transport http … --header`, Cursor `mcpServers.<n>.{url,headers}`,
  VS Code `servers.<n>.{type:"http",url,headers}`, Claude Desktop through `npx mcp-remote` with the header in `env`.
  Snippets go to stderr (stdout carries only the token). Verify against `docs/guide/clients.md` before release.
- **Options:** as assumed; drop Desktop until it supports remote servers with static headers natively.
- **Needs:** a check against the current client docs (P2-13 / release).


### P2-11 — Container key files: keep the 0600 rule, no relaxation switch
- **Context:** Docker/Kubernetes mount secret files `0444`/`0644` (or root-owned), which the P2-03 permission check rejects,
  and the image runs as non-root (uid 65532).
- **Assumption made:** no new "allow readable key files" switch. The guide tells operators to own the file as `65532`
  with `0400` (Docker/Compose), or to pass `RB_MASTER_KEY` from a secret `env` entry (Kubernetes). The compose example
  documents the `chown 65532` step.
- **Options:** as assumed; add `RB_ALLOW_READABLE_KEY_FILES=true` for orchestrators that cannot set owner and mode (weakens
  the check for everyone who sets it); run the image as root (rejected).
- **Needs:** owner OK; revisit if the Kubernetes path proves awkward (Helm chart is post-1.0).

### P2-11 — Distroless runtime, uid 65532, images published on release only
- **Context:** the task allowed "distroless or slim".
- **Assumption made:** distroless `nodejs24-debian13:nonroot` (smaller attack surface, Trivy clean, no shell for an
  attacker); debugging uses `docker exec ... /nodejs/bin/node`. Images are pushed to GHCR only by the `Docker` workflow
  after the `Release` workflow published a GitHub Release at that commit, with `RB_RELEASE_ENABLED=true` and an approval of
  the `release` environment. `:latest` is moved only for non-prerelease versions; version tags are immutable.
- **Options:** as assumed; Debian slim with a shell; also publish `:<major>.<minor>` tags.
- **Needs:** before the first release: make the GHCR package public (or decide to keep it private), confirm the
  `release` environment also guards this workflow, and check `cosign verify` with the documented identity.

### P2-11 — Trivy ignores unfixed vulnerabilities
- **Context:** "scan clean of high/critical" can fail on base-image CVEs with no fix available.
- **Assumption made:** `ignore-unfixed: true`, so CI fails only on high/critical findings that have a fix (Renovate then
  bumps the digest-pinned base image). Secrets scanning is on as well.
- **Options:** as assumed; fail on unfixed too and maintain a `.trivyignore` with expiry dates.
- **Needs:** nothing.

### P2-12 — JSON-RPC batches refused on the MCP endpoint
- **Context:** SDK 2.2.0's legacy (2025-era) stateless path still accepts a JSON array of requests and runs every call
  in it within one HTTP request, so a batch of N tool calls cost one rate-limit charge (the per-request call budget
  still bounded NerdGraph work). Batching was removed from MCP in 2025-06-18; no current client sends batches.
- **Assumption made:** refuse any array body with `400` and a JSON-RPC `-32600` error before the MCP handler. Tested;
  documented in the self-hosting guide.
- **Options:** as assumed; accept batches and charge the rate limiter once per element (needs a hook interface change).
- **Needs:** owner OK; revisit only if a supported client turns out to batch.

### P2-12 — Make the "Authorization suite" CI job a required check
- **Context:** the acceptance criterion asks for the suite to be required; branch protection is a repository setting
  the agents don't change.
- **Assumption made:** the suite runs as its own CI job (`Authorization suite`, `pnpm test:authz`) and inside
  `pnpm test`; nothing in the repository settings was changed.
- **Options:** add `Authorization suite` to the required status checks of `main`; rely on the `check` job (already
  runs it) being required.
- **Needs:** the owner to add the required check once the stack is merged.

## P2-15 — Pass-through mode

### P2-15 — What pass-through means, and its defaults
- **Context:** ARCHITECTURE mode E and the task described a client-supplied key in a header, "off by default, proposed
  off on Workers"; details (route, headers, refusals, caching, TLS) were open.
- **Assumption made:** a separate route `/passthrough/mcp`, registered only with `createHttpApp({ passthrough })`
  (`serve`: `RB_PASSTHROUGH=on`, default off; Workers off as well — this resolves the THREAT_MODEL open question).
  Headers `X-NewRelic-Api-Key` (User keys only) and `X-NewRelic-Region` (default `US`). Every read-only tool, default
  limits (raw NRQL on), accounts = what the key reaches (default the lowest id). Key problems → one `401` with
  `WWW-Authenticate: NewRelic-Api-Key` (not `Bearer`, so MCP clients don't try OAuth discovery); New Relic down → `503`.
  The reachable accounts are cached 60 s (0-300 s, `RB_PASSTHROUGH_IDENTITY_TTL`) under an HMAC fingerprint with a
  per-process random secret; per-key limit 120/min (`RB_RATE_LIMIT_PASSTHROUGH_KEY`).
- **Options:** as assumed; let operators set pass-through limits (e.g. raw NRQL off, max window) through env; allow a
  default-account header; a stable fingerprint secret from env for multi-replica rate limiting (the option exists in
  the library, not in `serve`).
- **Needs:** owner OK on the defaults (especially raw NRQL on and the `401` scheme).

### P2-15 — Plain HTTP refused on the pass-through route
- **Context:** the key travels in every request; the app can't see TLS behind a proxy.
- **Assumption made:** refuse (`403 tls_required`) unless the request URL is https, `hsts: true` (`RB_HSTS=true`,
  already the documented setting behind a TLS proxy) or the `Host` is loopback. Library opt-out:
  `passthrough.requireTls: false` (not exposed in `serve`).
- **Options:** as assumed; only warn at start; trust `X-Forwarded-Proto` from trusted proxies instead of `RB_HSTS`.
- **Needs:** owner OK.

### P2-15 — Pass-through tool calls not audited yet (superseded: audited since P2-16)
- **Context:** the audit hooks take an `McpRequestInfo` (project, grant, token); a pass-through request has none, and a
  proper row needs an actor column decision.
- **Assumption made:** refusals are audited (existing hooks), tool calls are not; new task P2-16.
- **Options:** as assumed; record them now under `details.keyId` with the existing schema.
- **Needs:** nothing: done in P2-16 (`audit_log.key_id`).

### P2-16 — Audit actor for pass-through calls, and the key id's lifetime
- **Context:** pass-through calls have no user, grant or token; the audit row needs an actor that is not the key.
- **Assumption made:** a new nullable `audit_log.key_id` column (forward-only migration `0002_audit_key_id`, indexed with
  `ts`) holds the existing rate-limit fingerprint id `pt_` + 12 hex. It is an HMAC-SHA-256 under a secret (verified:
  not a plain hash, so it can't be brute-forced from the table without the secret). `serve` keeps the per-process
  random secret, so the id changes at every restart. Filters: `keyId=pt_…` or `keyId=any` (admin API) and
  `audit tail --key-id`. Only tool calls and rate-limit refusals carry it; `auth.denied` rows on this route do not.
- **Options:** as assumed; an `RB_PASSTHROUGH_FINGERPRINT_SECRET` env (stable ids across restarts and replicas, at the
  cost of a long-lived secret whose leak lets someone confirm a guessed key against the table); put the id in
  `details.keyId` with no migration; also record the id on `auth.denied` rows for refused keys.
- **Needs:** owner OK; say if stable ids across restarts are wanted.

### P2-13 — Release v0.2.0 and docs that name the pre-release
- **Context:** the task scope listed "Release v0.2.0". Tags, npm/GHCR publishing and the changelog are the owner's call
  and the series is still stacked PRs, so nothing was released. The new docs say "pre-release: build from a clone"
  (as the v0.1 docs do) and the compose example and Docker guide still reference image tag `0.1.0`.
- **Assumption made:** docs describe v0.2 features as implemented but not released (README says so).
- **Needs:** after the stack is merged and v0.2.0 is cut: bump the image tag in `deploy/docker-compose.example.yml` and
  the self-hosting guide, drop the pre-release notes, and tick the last P2-13 acceptance criterion.

### P2-13 — "Validated by a fresh agent session"
- **Context:** the autonomous run could not spawn an independent reader. The author ran every command in
  `docs/guide/multi-device.md` and the access-model examples against the built CLI (test-hook build, mock NerdGraph):
  init, credential/project/grant/token creation, serve, 200 vs 401, local and `--remote` revocation, expiry.
  Not run: Docker/compose, Caddy and the systemd unit, a real New Relic key, real Windows 365 / macOS clients.
- **Needs:** one real walkthrough on the owner's three devices; report discrepancies as issues.

### P2-13 — Management CLI has no flag for project/grant query limits or rate limits
- **Context:** the team example in the access-model guide uses `maxWindowDays`, which can only be set through the admin
  API today. The guide says so.
- **Options:** new task to add `--max-window-days` / `--max-limit` / `--rate-limit` to `project add|update` and `grant create`.
- **Needs:** owner priority.

## Phase 2 consolidation review (2026-10-03)

Questions raised by `docs/reviews/phase-2-review.md`. Nothing here blocks Phase 3.

### REVIEW — Auth-failure throttle also refuses valid tokens from the same IP
- **Context:** after 10 failed authentications in 5 minutes from one IP, *every* request from that IP gets `429`,
  valid token or not (so a 429 never tells a guesser it was right, T1/T19). Accepted in THREAT_MODEL (P2-07 row), but
  it means anyone sharing your IP (office NAT, mobile CGNAT, a misconfigured proxy with `RB_TRUSTED_PROXY_HOPS=0`)
  can lock your devices out for minutes, and one laptop retrying a revoked token locks out its neighbours.
- **Assumption made:** keep it (documented in `self-hosting.md`).
- **Options:** keep; let a request whose token *verifies* through the throttle (tokens are 256-bit, so "valid vs
  invalid" is not a useful oracle) and keep refusing only failures; per-IP + per-token-prefix buckets.
- **Needs:** owner choice before Phase 3 (P3-04 implements the same hooks on Workers).
- **Implemented (P3-13, autonomous run, owner not consulted):** the second option, on Node and Workers alike. The
  failure throttle is checked and charged on failure (`refuseAuthFailure` hook): past 10 failures per 5 min a further
  failure gets `429` instead of `401`, and a request whose MCP access token or admin token verifies is served from that
  IP. In exchange a locked IP learns token validity at the per-IP request rate (600/min) instead of 10 per 5 min:
  harmless for 256-bit access tokens, and admin tokens are now refused at boot when predictable (P3-13 strength check).
  The pass-through route keeps the strict rule (a locked IP is refused before its New Relic key is sent to NerdGraph).
  Reasoning in `THREAT_MODEL.md` (P3-13 row). **Reversible:** restoring the `peek` of `fail:<ip>` in `beforeAuth` for
  every scope (`packages/http-app/src/rate-limit-hooks.ts`, a few lines) brings back the old rule; the tests that pin
  the new behaviour say "P3-13". Owner: confirm, or ask for the revert (see `phase-3.md`, "P3-13").

### REVIEW — Pass-through key ids change on every restart
- **Context:** `/passthrough/mcp` fingerprints keys with an HMAC secret drawn at random per process, so `pt_…` ids in
  the audit log and rate-limit buckets don't survive a restart and differ between replicas.
- **Assumption made:** fine for a single personal server.
- **Options:** keep; add `RB_PASSTHROUGH_FINGERPRINT_SECRET` (`_FILE`, ≥ 32 bytes) wired to the existing
  `PassthroughOptions.fingerprintSecret` (Workers will need it for a shared limiter anyway).
- **Needs:** owner choice; small task if yes.

### REVIEW — "Is this request HTTPS?" behind a proxy
- **Context:** the app decides HSTS and the pass-through `tls_required` check from the request URL or `RB_HSTS=true`;
  it never reads `X-Forwarded-Proto`. The review added `RB_HSTS=true` to the compose example and the Docker docs.
- **Assumption made:** an explicit `RB_HSTS=true` is clearer than trusting a header.
- **Options:** keep; trust `X-Forwarded-Proto` only when `RB_TRUSTED_PROXY_HOPS > 0`.
- **Needs:** nothing unless the owner prefers the header.

## P2-19 Docker release hardening

### P2-19 — Repository settings for the release path cannot be set or verified from code
- **Context:** the `release` environment must have required reviewers (not self-review) and a `main`-only deployment
  rule, `v*` tags and `main` need rulesets, and the GHCR package must be linked to the repository. Agents must not
  change repository settings, so `docs/dev/releasing.md` lists them and nothing verifies them.
- **Assumption made:** the owner applies the settings before setting `RB_RELEASE_ENABLED=true`.
- **Options:** apply by hand (once); later add a scheduled workflow or script that reads the settings with a
  read-only token and fails when they drift.
- **Needs:** owner action before the first release.

### P2-19 — The release-time arm64 scan is a rebuild, not the published archive
- **Context:** Trivy cannot read a multi-arch OCI archive, so the arm64 scan runs on a docker archive built from the
  same Dockerfile and inputs just before the multi-arch archive. Base images are digest-pinned and the build has no
  cache in releases, so they match unless a build step is non-deterministic.
- **Assumption made:** acceptable; the published digest is the one built from the OCI archive, signed and attested.
- **Options:** keep; or unpack per-platform images from the OCI archive with `skopeo copy` to docker archives in
  `build` and scan those (exact, a few more steps).
- **Needs:** nothing unless the owner wants the exact-archive scan.

