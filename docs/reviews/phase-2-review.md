# Phase 2 consolidation review

- **Scope:** all of Phase 2: `git diff task/P1-17-cli-warnings-docs-accuracy...task/P2-13-docs-self-hosting`
  (P2-01 … P2-16, 206 files, ~31k lines including lockfile and generated snapshots).
- **Branch:** `review/phase-2`, stacked on `task/P2-13-docs-self-hosting` (top of the Phase 2 PR stack).
- **Date:** 2026-10-03.
- **Method:**
  - Read the security-relevant source in full: `packages/http-app` (app, admin token, access cache, security,
    client IP, rate limiting, audit, pass-through, JSON-RPC peek), `packages/auth` (token format and service,
    resolver, loader, keyring, rotation) and `apps/cli/src/serve.ts`.
  - Spot-read the SQLite repositories for SQL built from input. Every value is a bound parameter; the only
    interpolations are fixed clause lists and a validated integer `PRAGMA`.
  - Checked every task's acceptance criteria against code and tests, with a sub-audit cross-checked on the points
    below.
  - Built a test-hooks CLI bundle and ran `init` + `serve` against a local NerdGraph mock (admin API and pass-through
    on), then attacked it with curl:
    - foreign `Host` / `Origin` / `null` Origin;
    - wrong slug, admin token on MCP and MCP token on admin;
    - chunked 2 MB bodies without `Content-Length` on MCP and admin;
    - JSON-RPC batches and a spoofed `Mcp-Method: subscriptions/listen`;
    - an ungranted `tools/call`, also with invalid UTF-8 in the body;
    - pass-through with a refused key, a key in `Authorization`, and literal values in NRQL;
    - control/bidi characters in names;
    - revocation through the admin API (immediate) and the local CLI (within the cache TTL, as documented).
  - Built the Docker image (`docker build .`) and ran it read-only, non-root, with `--cap-drop ALL`: `/health`,
    `403` for a foreign `Host`, HSTS with `RB_HSTS=true`, and `db backup` / `project list` through `docker exec`.
- **Checks:** `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green before and after the fixes. The
  `test:authz` matrix stays green. Every regression test added here fails with its fix reverted (checked).

## Verdict

**Ready, with fixes in this branch.** No critical findings.

- **Fixed here, with regression tests:**
  - Two high findings: the master key was created next to the database by default, and the Docker
    backup/rotation commands failed as documented.
  - Two medium findings: an audit gap for ungranted calls, and the missing `RB_HSTS` behind the proxy.
- **The core security design holds under attack:**
  - deny-by-default resolver;
  - one byte-identical 401 per route family;
  - token-before-slug;
  - hashed 256-bit tokens with offline checksum;
  - AES-256-GCM with AAD bound to credential id and key version, plus key check values and CAS rotation;
  - per-request key decryption;
  - tenant-keyed caches;
  - body and time bounds;
  - Host/Origin checks;
  - no `node:*` in core/auth/http-app.
- **The roadmap promise is met in code and offline tests:** Node/Docker server, per-project URLs, per-device
  tokens, audit log, admin API + CLI. Not yet done:
  1. **Nothing has run against real New Relic or real remote clients**, same as Phase 1. Client snippets are
     unverified.
  2. **No image has been published, and compose/Caddy have never run.** The PR smoke test now also covers the Host
     check and `db backup` in the image; P2-19 adds MCP through the image and closes the release gaps.

## Per-task completeness

| Task | Status | Evidence / gap |
|---|---|---|
| P2-01 storage interface | met | contract suite on memory/YAML/SQLite, forward-only checksummed migrations, `RESTRICT` deletes |
| P2-02 SQLite adapter | met | `node:sqlite`, `0600` file + WAL/SHM, parameterised SQL only, backup refuses overwrite. `synchronous=NORMAL` not asserted (minor) |
| P2-03 secrets | met | HKDF-derived AES-256-GCM key, AAD = purpose‖id‖version, KCV with insert-if-absent, retired/reused-key refusal, CAS rotation with read-back |
| P2-04 access model | met | pure resolver; storage errors fail closed (503); other users' personal keys refused at creation and on every request |
| P2-05 tokens | met | rejection-sampled base62, CRC checksum before any read, constant-time hash compare, label control/bidi refusal |
| P2-06 HTTP app | met | single 401, Host/Origin, CSP/nosniff/no-store/CORP, 413 before auth, 180 s deadline incl. SSE, WeakSet-guarded scope. `--help` lacks the newer `RB_*` variables → P2-18 |
| P2-07 rate limiting | met | separate pre/post-auth stores, XFF from the right only with configured hops, IPv6 /64. Lock-out of valid tokens on a shared IP is accepted → pending decision |
| P2-08 audit | met | masked NRQL by default, capped refusal rows, retention purge. Gap in ungranted-call recording: **fixed** (M1) |
| P2-09 admin API | mostly met | constant-time digest compare, strict schemas, 64 KiB cap, masked outputs, cache cleared on change. "Every failed change is audited" is overstated (schema refusals aren't); storage errors are 500 not 503 → P2-17 |
| P2-10 CLI | met (with fixes) | no secrets as flags, https-only remote, no redirects. Master key default location (**H1**) and DB path for maintenance commands (**H2**) fixed |
| P2-11 Docker | partially met | digest-pinned distroless non-root image, SHA-pinned actions, signing in a job that runs no project code. Compose lacked `RB_HSTS`: **fixed** (M2). `:latest` can roll back, arm64 unscanned, smoke test shallow (extended here) → P2-19. Last box (signed + clean) open by design |
| P2-12 authz suite | met | every route × caller kind, per-tool hostile NerdGraph, interleaved tenants. Positive control only "not 401/403" → P2-17 |
| P2-13 docs | partially met | "validated end to end" is ticked, but Docker/compose/systemd were never run and two documented commands failed (H2). Roadmap status was stale: **fixed**. Remaining contradictions → P2-18 |
| P2-14 core output | met | — |
| P2-15 pass-through | met | key only in a header, `Secret`, HMAC fingerprint, TLS guard, read-only tools, per-key limit, leak scans |
| P2-16 pass-through audit | met | `key_id` column, `pt_…` actor, no key anywhere |

## Findings

Severity is the impact if exploited or hit in normal use. Status: **fixed** (in this branch, with a regression test),
**task** (new task file), **pending** (`docs/pending-decisions/phase-2.md`, section "Phase 2 consolidation review").

### Critical

None.

### High

**H1 — `init` stored the master key next to the database it protects** — **fixed**
- `apps/cli/src/manage/init.ts:49` (old): `join(dirname(dbPath), 'master.key')`.
- **Impact:** the security guide says never to keep the master key in the same directory, volume or backup as the
  database (THREAT_MODEL T7). The default did exactly that. A copy of the data directory (a backup, a volume
  snapshot, a synced folder) therefore held the ciphertext and the key, and exposed every stored New Relic key.
- **Fix:**
  - The default is now the per-user config directory: `~/.config/relic-bridge/master.key` (`$XDG_CONFIG_HOME`,
    `%APPDATA%\relic-bridge` on Windows), via `defaultConfigDir()` in `serve.ts`.
  - An explicit `--master-key-file` in the database's own directory is refused before anything is created.
  - Tests in `manage.test.ts` and `serve.test.ts`; docs (`cli.md`, `multi-device.md`, `self-hosting.md`) and the
    P2-10 pending-decision entry are updated.

**H2 — Backup and key rotation failed in the Docker image as documented** — **fixed**
- `apps/cli/src/main.ts:83-115,167` (old): `db backup`, `keys rotate`, `credential revalidate` and `audit purge`
  read only `--db` / `RB_DB_PATH`.
- **Impact:** the image sets only `RB_DATA_DIR=/data`, so the documented commands exited 2:
  - `docker compose exec … db backup <file>`;
  - `keys rotate`, the response to a leaked database or master key.

  An operator following the guide could not take backups or rotate keys.
- **Fix:** one helper resolves the database like `serve` and the management commands do (`--db`, `RB_DB_PATH`,
  else `<data dir>/relic-bridge.db`).
- Test in `main.test.ts` (backup via `RB_DATA_DIR`). Verified in the built image with `docker exec … db backup`.

### Medium

**M1 — An ungranted tool call with an invalid UTF-8 byte in the body was not audited** — **fixed**
- `packages/http-app/src/jsonrpc.ts:41`.
- **Impact:** the P2-12 fix reads the method and tool name from a copy of the body, but with a *strict* UTF-8
  decoder. The SDK's handler decodes leniently and dispatched the same body. One stray byte (e.g. in an unused
  field) made the call invisible to the `tool.not_granted` audit row. Reproduced against the running server.
- No data was reachable: the tool is not registered for that grant. The rate limits still applied.
- **Fix:** decode exactly like the handler. Regression tests in `jsonrpc.test.ts` and `audit.test.ts`.

**M2 — Behind the documented TLS proxy, no HSTS and pass-through refused everything** — **fixed**
- `deploy/docker-compose.example.yml`, `docs/guide/self-hosting.md` (`docker run`, TLS paragraph).
- **Impact:** the app decides "is this HTTPS" from the request URL or `RB_HSTS=true`. Behind Caddy it sees plain HTTP.
  The compose example and the Docker docs omitted `RB_HSTS=true`. As a result:
  - no `Strict-Transport-Security` was ever sent;
  - with `RB_PASSTHROUGH=on`, every request got `403 tls_required`.
- **Fix:** set it in compose and the docs. A compose test in `scripts/test/docker-workflow.test.ts` checks HSTS,
  hops, the Host allowlist, no published app port, and the master key only as a `/run/secrets` file.
- Trusting `X-Forwarded-Proto` instead → pending.

**M3 — Admin API: refused changes not always audited; storage outage = 500** — **task P2-17**
- `packages/http-app/src/admin/api.ts:566` (`defaultHook` throws before `change()`), `admin/errors.ts:126`.
- **Impact:**
  - Schema-invalid change requests leave no `admin` row, although the docs and THREAT_MODEL say every failed
    change does.
  - A storage outage answers 500 instead of `503 Retry-After`, unlike the MCP route.
  - Minor items:
    - body-less `POST …/revoke` needs `Content-Type` (`415` with plain `curl -X POST`);
    - `token.create` audits `ttlSeconds: null` when the default TTL applied;
    - the authz matrix's positive control is only "not 401/403".

**M4 — Release path: `:latest` can move backwards; the image smoke test was shallow** — **task P2-19** (smoke test extended here)
- `.github/workflows/docker.yml:253-256`.
- **Impact:**
  - A re-run for an older stable tag (or a delayed `workflow_run`) retags `:latest` to the older image.
  - The `release` environment's reviewers and branch rule are assumed but not documented as required.
  - The PR smoke test (`scripts/docker-smoke.sh`) only checked `/health` and the user, so the documented maintenance
    commands were never run in the image, which is how H2 shipped. Extended here: a foreign `Host` must get `403`
    and `db backup` must work through `docker exec`. MCP through the image and the compose/Caddy path remain → P2-19.

**M5 — Docs disagree with the code in many small places** — **task P2-18** (partly fixed here)
- Fixed here: the roadmap status and decision log, `configuration.md` `--db`, `cli.md` `init`, and the master key
  path in `self-hosting.md` / `multi-device.md`.
- Remaining items (all in P2-18):
  - `--help` lacks the newer `RB_*` variables;
  - `cli.md` `--json` shapes;
  - troubleshooting deny reasons and the 504;
  - `audit-log.md` IP on post-auth rows;
  - the ARCHITECTURE audit table (`auth` kind, `key_id`);
  - the CORP header;
  - image tags that don't exist yet;
  - unverified client snippets;
  - stale pending-decision and task text.

**M6 — The auth-failure throttle also locks out valid tokens on a shared IP** — **pending**
- `packages/http-app/src/rate-limit-hooks.ts:96-105`.
- **Impact:** after 10 failures in 5 minutes from an IP, every request from it gets 429, including requests with
  valid tokens (reproduced: the probe locked out its own valid token).
- Anyone behind the same NAT or CGNAT can lock your devices out, and so can a laptop retrying a revoked token. So can
  the whole internet when a proxy runs with `RB_TRUSTED_PROXY_HOPS=0` (that case is warned in the log).
- Accepted in THREAT_MODEL (P2-07 row) to avoid a validity oracle. With 256-bit tokens that oracle is worth little,
  so the owner should decide before P3-04 reimplements it on Workers.

### Low

- **L1 — Pass-through key ids change at every restart** — **pending.** The HMAC fingerprint secret is random per
  process (`passthrough.ts:94-98`), so `pt_…` audit ids and per-key buckets don't survive restarts or span replicas.
  `PassthroughOptions.fingerprintSecret` exists but `serve` has no variable for it.
- **L2 — Image hardening gaps** — **task P2-19.**
  - arm64 is built but not Trivy-scanned.
  - The `HEALTHCHECK` counts `403 forbidden_host` as healthy (documented).
  - Compose doesn't wait for a healthy app before Caddy.
- **L3 — Client snippet puts the token on a command line** — **task P2-18.** `claude mcp add … --header
  'Authorization: Bearer rb_…'` lands in shell history. The docs should say so and show a safer form.
- **L4 — Local CLI changes reach a running `serve` only after `RB_ACCESS_CACHE_TTL`** — no action. Documented
  (`cli.md`, `self-hosting.md`); `--remote` takes effect at once.

### Checked and fine (no finding)

- **SQL injection:** none. All repository SQL uses `?` parameters; `WHERE` clauses are built from fixed strings only.
- **Token handling:**
  - offline format/checksum rejects garbage before any read;
  - SHA-256 lookup followed by a constant-time compare;
  - revoked/expired checks with an integer clock guard;
  - the access cache is keyed by `sha256(token)+slug`, capped at token/grant expiry, bounded, ciphertext only, and
    cleared on admin changes.
- **Crypto:**
  - non-extractable AES-GCM keys;
  - fresh 96-bit IVs;
  - injective AAD;
  - strict canonical base64 for master keys;
  - all-equal placeholder keys refused;
  - KCV mismatch, retired-version and reused-key checks at boot;
  - rotation is compare-and-swap with read-back and rollback.
- **Admin API:**
  - only a SHA-256 digest of the bootstrap token is held, compared in constant time;
  - the MCP token and the admin token are not interchangeable (probed);
  - no CORS on admin routes;
  - the Origin check applies (probed);
  - chunked oversize bodies get `413` (probed).
- **DNS rebinding / Origin:** the SDK validators run before routing. `null` Origin is refused. A non-loopback bind
  requires `RB_ALLOWED_HOSTS`.
- **Rate-limit bypasses:**
  - batches are refused;
  - `subscriptions/listen` is judged from the body, not the header (P2-12 tests);
  - `X-Forwarded-For` is only read from the right with configured hops;
  - Caddy's default replaces client-supplied XFF.
- **Secrets in logs and audit:** the server stderr and audit rows from all probes contain neither the NR key nor the
  device token. Pass-through NRQL literals are masked (`name = ?`).
- **Supply chain:**
  - workflow permissions default to `{}`;
  - only `publish` holds `id-token` / `packages: write`, and it checks out nothing;
  - no `pull_request_target`;
  - untrusted values go through `env:`;
  - cosign signs the digest;
  - `.dockerignore` is an allowlist.
- **AGENTS.md hard rules:**
  - no `node:*` / `process` / `Buffer` in core, auth, http-app or storage;
  - stdout untouched by `serve`;
  - no secrets accepted as flags;
  - no credential management as an MCP tool.

## What Phase 3 (Cloudflare Workers + D1) must know

1. **The app is ready to mount as a Worker.** `createHttpApp` is web-standard and holds all state per instance
   (access cache, limiter pool, identity cache, `WeakSet` of scopes). Background work goes through
   `executionCtx.waitUntil`; the default `runInBackground` already tries it. Supply `waitUntil`, a client-IP function
   (`CF-Connecting-IP`) and `hsts: true`. On Workers the URL is https, so `'auto'` also works.
2. **Rate limiting is a seam.** `RateLimiter` (`take` / `peek`, may be async) is all P3-04 implements. Decide M6
   (lock-out semantics) first. The audit refusal cap is per recorder instance, so on Workers it is per isolate.
3. **D1 adapter (P3-02):**
   - It must pass the same storage contract suite.
   - It must implement `settings.setIfAbsent` atomically (`INSERT … ON CONFLICT DO NOTHING`, check
     `meta.changes`); `verifyKeyChecks` relies on it.
   - It must implement `credentials.update` with `ifKey` compare-and-swap; rotation relies on it.
   - The migration runner question (own `schema_migrations` vs `wrangler d1 migrations`) is still pending (P2-01
     entry).
4. **Per-request budget:** `callBudget` defaults to 1000 subrequests (the Node figure). Set the Workers figure from
   ADR-0010.
5. **Cache consistency differs.** Admin changes clear only the isolate that served them. Other isolates see them
   within `RB_ACCESS_CACHE_TTL` (≤ 60 s). Document it, or lower the TTL on Workers.
6. **Pass-through on Workers** needs a shared `fingerprintSecret` (L1) if a shared limiter is used, otherwise every
   isolate fingerprints differently.
7. **Master key on Workers** comes from a secret binding, never D1. That is H1's rule applied to the cloud: the key
   and the data must not share a store or a backup.
