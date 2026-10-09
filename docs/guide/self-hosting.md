# Self-hosting: the HTTP server and its database

Self-hosted mode (Phase 2) serves MCP over HTTP to your other devices with `relic-bridge serve`, and keeps projects,
encrypted credentials, grants, device tokens, the audit log and OAuth state in one SQLite file. Docker, TLS and the
multi-device walkthrough are added by the rest of Phase 2 (P2-11, P2-13).

stdio mode does not use a database: it reads `relic-bridge.yaml` or environment variables
([configuration](configuration.md)).

## Run the server

```bash
export RB_MASTER_KEY_FILE=~/.config/relic-bridge/master.key   # 0600; see secrets.md
relic-bridge serve                       # http://127.0.0.1:8787, database in the data directory
relic-bridge serve --port 9000 --db /var/lib/relic-bridge/relic-bridge.db
```

- Each project is one MCP endpoint: `http://<host>:<port>/p/<project-slug>/mcp` (Streamable HTTP, both the 2025 and
  2026-07-28 protocol eras). Clients authenticate with a per-device token: `Authorization: Bearer rb_live_…`
  ([access model](access-model.md#devices-and-access-tokens)). Projects, credentials, grants and tokens are managed
  through the [management CLI](#management-cli) or the [admin API](#admin-api).
- **Database**: `--db`, else `RB_DB_PATH`, else `relic-bridge.db` in the data directory: `RB_DATA_DIR`, else
  `$XDG_DATA_HOME/relic-bridge` or `~/.local/share/relic-bridge` (Linux), `~/Library/Application Support/relic-bridge`
  (macOS), `%LOCALAPPDATA%\relic-bridge` (Windows). It is created (`0600`) and migrated on first start.
- **Master key**: required. The server refuses to start without it, with a wrong key (`key_mismatch`) or a retired
  one, and registers a new key version on first use ([secrets](secrets.md)).
- **Binding**: `127.0.0.1` by default, so only this machine can connect. To serve other devices, bind another address
  **and** list the hostnames clients use, so requests for any other `Host` are refused (DNS rebinding protection):
  `RB_HOST=0.0.0.0 RB_ALLOWED_HOSTS=mcp.example.com relic-bridge serve`. Put it behind a TLS reverse proxy before it
  leaves your LAN, and set `RB_HSTS=true` there.
- `GET /health` answers `{"status":"ok"}` (for health checks; it reveals nothing else). `GET /version` names the
  version.

| Variable | Default | Meaning |
|---|---|---|
| `RB_PORT` / `--port` | `8787` | TCP port; `0` picks a free one (logged). |
| `RB_HOST` / `--host` | `127.0.0.1` | Address to bind. |
| `RB_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Hostnames allowed in `Host` (port-agnostic). Required for a non-loopback bind. `*` disables the check (not recommended). |
| `RB_ALLOWED_ORIGINS` | = `RB_ALLOWED_HOSTS` | Hostnames allowed in a browser `Origin` header; a request with any other `Origin` (or `null`) is refused with 403. Requests without `Origin` (every non-browser MCP client) pass. |
| `RB_CORS_ORIGINS` | none (CORS off) | Origins (`https://app.example.com`) that may call the MCP endpoints from a browser. |
| `RB_ACCESS_CACHE_TTL` | `30` | Seconds a token's resolved access is cached, `0`-`60`. A revoked token, grant or project stops working within this time; `0` disables the cache. Never longer than the token's or grant's expiry. |
| `RB_RATE_LIMIT` | `on` | `off` disables all rate limiting (not recommended; warned at start). |
| `RB_RATE_LIMIT_IP` | `600/60` | Requests per client IP before authentication: `<requests>/<seconds>` (bucket size / refill window) or `off`. |
| `RB_RATE_LIMIT_AUTH_FAIL` | `10/300` | Failed authentications per client IP. Past it, **every** request from that IP gets `429` (valid token or not) until the bucket refills (one failure per 30 s with the default). |
| `RB_RATE_LIMIT_TOKEN` | `120/60` | Requests per access token. |
| `RB_RATE_LIMIT_GRANT` | `300/60` | Requests per grant, unless the grant has its own `rateLimit`, which replaces this. |
| `RB_TRUSTED_PROXY_HOPS` | `0` | Reverse proxies in front of the server (0-5). `X-Forwarded-For` is only believed for that many hops, counted from the right; with `0` the socket address is the client. **Set it behind a proxy**, or all clients share the proxy's address and one bad device can lock the others out. |
| `RB_AUDIT` | `on` | `off` stops recording tool calls, refusals and admin changes. See the [audit log](audit-log.md). |
| `RB_AUDIT_NRQL` | `mask` | `mask` (literal values hidden), `hash`, `full` or `off`: how NRQL text is stored. |
| `RB_AUDIT_RETENTION_DAYS` | `90` | Days to keep audit rows (`0` = forever). Purged at startup and hourly; `relic-bridge audit purge` does it by hand. |
| `RB_AUDIT_CLIENT_IP` | `on` | Record the client address on refused requests. |
| `RB_ADMIN_TOKEN` | unset (admin API off) | Bootstrap admin token that enables `/api/admin/v1` ([admin API](#admin-api)). 32-512 printable characters, no spaces. Or `RB_ADMIN_TOKEN_FILE` (a `0600` file). |
| `RB_HSTS` | `auto` | `Strict-Transport-Security` when the request arrived over https; `true` behind a TLS-terminating proxy. |
| `RB_LOG_LEVEL` | `info` | One JSON line per request on stderr (never the token or the New Relic key). |

### What the server enforces

- **One answer for every refusal**: a missing, malformed, unknown, revoked or expired token, a token for another
  project, an unknown or disabled project, a disabled user or an unusable key all get the same `401` with
  `WWW-Authenticate: Bearer`. The token is checked before the project is looked up, so project names can't be probed.
  The reason is in the server log (`"deny":"…"`).
- Each request gets a fresh MCP server with **only the tools its grant allows**; others are neither listed nor
  callable. `run_nrql` / `get_query_result` are hidden when raw NRQL is off.
- Request bodies over 1 MiB are refused (`413`); a request (including its response stream) is cut off after 180 s.
- Security headers on every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`,
  `Cache-Control: no-store`, and HSTS as configured.
- **Rate limits** (in memory, per process): `429` with `Retry-After` and a JSON-RPC error telling the agent to slow
  down. Per-IP request and failed-authentication limits apply before authentication and are the same for valid and
  invalid tokens, so a `429` never tells a guesser anything; per-token and per-grant limits apply after. IPv6 clients are
  counted per /64. `subscriptions/listen` isn't counted. Devices behind one NAT share a failure budget: a device
  retrying an expired token can block the others for a few minutes. Several server processes each keep their own counters.
- **Audit log**: every tool call, refused request and admin change is recorded without secrets or result data, after
  the response (a failed write is logged, never surfaced). What is stored and how to tune it: [audit log](audit-log.md).
- Storage errors answer `503` (fail closed), never "allowed".
- `subscriptions/listen` (opened by 2026-era clients such as Claude Code) is acknowledged and closed at once: the
  server has no change notifications to push.

## Management CLI

`relic-bridge` manages a local database directly, or a running instance through the admin API. Same commands for
both; full list in the [CLI reference](../reference/cli.md).

```bash
# First run on the server: master key file + database + first key, project and device token.
relic-bridge init --label main --region US --slug prod --url https://mcp.example.com   # key on stdin or hidden prompt
export RB_MASTER_KEY_FILE=~/.local/share/relic-bridge/master.key                       # back this file up
relic-bridge credential add --label eu --region EU --key-file ./eu.key
relic-bridge project add --slug eu --default-account 2000002 --default-credential <credential id>
relic-bridge grant create --project eu --label phone
relic-bridge token create --grant <grant id> --label phone --url https://mcp.example.com

# From your laptop, against the running server (admin API enabled with RB_ADMIN_TOKEN there):
export RB_ADMIN_TOKEN=...            # relic-bridge admin-token generate
relic-bridge project list --remote https://mcp.example.com   # any management command takes --remote
relic-bridge audit tail --follow --remote https://mcp.example.com
```

- **Keys and tokens never go on the command line.** New Relic keys come from a hidden prompt, stdin, `--key-file` or
  `--key-env`; the admin token from `RB_ADMIN_TOKEN[_FILE]` or a prompt. Options that would carry a secret are refused.
- **Remote needs https** (plain `http://localhost` only with `--insecure`), and never follows redirects.
- A new device token is printed **once**, with snippets for Claude Code, Claude Desktop, Cursor and VS Code.
- Local changes made while `serve` runs reach it within `RB_ACCESS_CACHE_TTL` (default 30 s); revoke through
  `--remote` for an immediate effect.
- `--json` makes any command scriptable; exit codes are `0` ok, `1` failed, `2` usage.

## Admin API

`/api/admin/v1` manages users, New Relic credentials, projects, grants, device tokens and the audit log over JSON. It
is **off** unless `RB_ADMIN_TOKEN` (or `RB_ADMIN_TOKEN_FILE`) is set, and then every request needs
`Authorization: Bearer <admin token>`. Full reference: [admin API](../reference/admin-api.md); the OpenAPI 3.1
document is at `GET /api/admin/v1/openapi.json` (admin token required).

```bash
export RB_ADMIN_TOKEN="$(openssl rand -base64 32)"   # keep it in your secret store, not in shell history
relic-bridge serve &
H="Authorization: Bearer $RB_ADMIN_TOKEN"
# Add a New Relic User key (validated against New Relic, stored encrypted, never returned).
read -rs NR_KEY   # paste the key; it never touches the command line
jq -n --arg k "$NR_KEY" '{label:"main", region:"US", apiKey:$k}' |
  curl -s -H "$H" -H 'Content-Type: application/json' --data @- http://127.0.0.1:8787/api/admin/v1/credentials
```

- **The admin token is the keys to the instance**: whoever holds it can add keys, open projects and issue tokens. Use
  a long random value, keep it out of the database's backup set, and change it by restarting with a new value. It is
  never stored (only a digest in memory), logged or returned. It is not an MCP token, and MCP tokens don't work here.
- Failed admin authentications count toward the same per-IP failure throttle as MCP requests and are audited
  (`auth.denied`, `admin_bad_token`).
- New Relic keys are accepted **only in request bodies**, never in URLs, and never come back: credentials are listed as
  masked metadata (label, region, last 4 characters, validation status, reachable accounts). Token hashes are never
  returned; a new device token is shown once, in the `POST /tokens` response.
- Bearer-only: cookies are ignored, so cross-site request forgery doesn't apply; no CORS headers are sent on admin
  routes, and the `Host` / `Origin` checks apply as everywhere else.
- Every change (and every failed attempt at one) writes an `admin` [audit](audit-log.md) row; query them with
  `GET /api/admin/v1/audit?kind=admin`.
- A change takes effect at once on the server that made it (its access cache is cleared); other server processes
  pick it up within `RB_ACCESS_CACHE_TTL`.
- Phase 4 adds sign-in with Google, GitHub, Cloudflare Access or OIDC for the admin panel; the bootstrap token remains
  for automation.

## The database file

- The adapter uses Node's built-in `node:sqlite` (Node 24.11 or newer). There is nothing to compile or install, on
  Linux, macOS or Windows.
- On first start the file is created with mode **`0600`** inside a directory with mode `0700`. If an existing file
  is readable by group or others it is tightened on open. On Windows, protect the folder with the normal user-profile
  permissions instead (POSIX modes don't apply).
- It runs in **WAL** mode, so you will also see `<file>-wal` and `<file>-shm` next to it while it is open. They are part
  of the database: copy or move all three together when the server is stopped, or use `db backup` (below) while it runs.
- Schema migrations are applied automatically on start and are **forward-only**. A database written by a newer
  relic-bridge is refused, so keep a backup before upgrading and don't downgrade.
- Put the file on a local disk. SQLite locking is unreliable on network file systems (NFS, SMB, some synced folders).

## Back it up

```bash
relic-bridge db backup ~/backups/relic-2026-10-03.db --db /var/lib/relic-bridge/relic.db
# or: RB_DB_PATH=/var/lib/relic-bridge/relic.db relic-bridge db backup <file>
```

The command writes a consistent snapshot (SQLite `VACUUM INTO`), including recent writes still in the WAL. It is safe to
run while the server is up, opens the source read-only (it never migrates or modifies it), creates the copy with mode
`0600`, and refuses to overwrite an existing file. Run it before every upgrade.

To restore, stop the server and put the backup file in place of the database (remove stale `-wal` / `-shm` files).

## Security: the database and the master key

New Relic keys are stored only as AES-256-GCM ciphertext, and device tokens only as SHA-256 hashes. **The database
together with the master key exposes every stored New Relic key.** Therefore:

- Never keep the master key (or the admin token) in the same directory, volume, backup or repository as the database. Give it to the process
  through the environment or a secret store.
- Treat a backup exactly like the live file: it has the same contents. Encrypt backups at rest if they leave the host,
  and keep their permissions at `0600`.
- Don't commit `*.db`, `*.sqlite` or their `-wal` / `-shm` files (they are in `.gitignore`).
- If the file or a backup may have leaked, rotate the master key (`relic-bridge keys rotate`) and the New Relic keys
  stored in it.

Creating, storing, backing up and rotating the master key: [secrets](secrets.md). See also the
[threat model](../THREAT_MODEL.md) (T7).

## Re-checking stored New Relic keys

A New Relic key can be revoked or lose access to an account in New Relic at any time. Re-check every stored key
with:

```bash
relic-bridge credential revalidate --db /var/lib/relic-bridge/relic-bridge.db   # needs RB_MASTER_KEY
```

A key New Relic refuses is marked `invalid`, and every grant that uses it stops working (fail closed) until the key is
replaced or a later check passes. Valid keys get their reachable accounts refreshed, so an account the key lost is
dropped from every connection. Network errors and rate limits change nothing. The command exits `1` when any key is
invalid or could not be checked, so a daily cron job can alert you. How credentials, projects and grants combine:
[access model](access-model.md).
