# Self-hosting: the HTTP server and its database

Self-hosted mode (Phase 2) serves MCP over HTTP to your other devices with `relic-bridge serve`, and keeps projects,
encrypted credentials, grants, device tokens, the audit log and OAuth state in one SQLite file. The Docker image is
described [below](#docker). For a complete walkthrough (server, one token per device, revoking a lost one) read the
[multi-device guide](multi-device.md).

stdio mode does not use a database: it reads `relic-bridge.yaml` or environment variables
([configuration](configuration.md)).

## Run the server

> **TLS for anything beyond this machine.** The server speaks plain HTTP. Bind it to loopback and put a TLS reverse
> proxy in front, or keep it on your machine: device tokens and query results must never cross a network unencrypted
> (this includes a home LAN). [multi-device guide](multi-device.md#tls-is-required).

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
- **As a service**: run `relic-bridge serve` under systemd (unit example in the
  [multi-device guide](multi-device.md#option-b-node-and-a-service)), launchd or a Windows service manager, as a
  dedicated unprivileged user that owns the data directory and the key file.
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
| `RB_QUERY_CACHE` | `on` | NRQL query cache in process memory (P7-02): a repeated query within its TTL is answered without a New Relic call. Entries never cross grants, credentials, keys, accounts or query limits. `off` sends every query to New Relic. See [query cache](query-cache.md). |
| `RB_QUERY_CACHE_TTL` | `30` | Seconds a result over a moving window (`SINCE 30 minutes ago`) is reused, `0`-`300`; `0` caches only fixed windows that ended at least 15 minutes ago (kept 10 minutes). |
| `RB_RATE_LIMIT` | `on` | `off` disables all rate limiting (not recommended; warned at start). |
| `RB_RATE_LIMIT_IP` | `600/60` | Requests per client IP before authentication: `<requests>/<seconds>` (bucket size / refill window) or `off`. |
| `RB_RATE_LIMIT_AUTH_FAIL` | `10/300` | Failed authentications per client IP. Past it, further **failures** from that IP get `429` instead of `401` until the bucket refills (one failure per 30 s with the default); a valid token is still served. On the pass-through route every request from that IP is refused (checking a New Relic key costs a NerdGraph call). |
| `RB_RATE_LIMIT_TOKEN` | `120/60` | Requests per access token. |
| `RB_RATE_LIMIT_GRANT` | `300/60` | Requests per grant, unless the grant has its own `rateLimit`, which replaces this. |
| `RB_RATE_LIMIT_SIGN_IN` | `60/300` | Sign-in requests (`/auth/*`: chooser, provider start, callback, logout) per client IP, on top of `RB_RATE_LIMIT_IP`. Every sign-in start stores a short-lived login state, so this bounds what an unauthenticated client can store. On Workers it is counted per isolate unless the [shared limiter](cloudflare-limits.md#shared-limiter-durable-object-optional) is on. |
| `RB_RATE_LIMIT_PASSTHROUGH_KEY` | `120/60` | [Pass-through](#pass-through-mode) requests per New Relic key. |
| `RB_RATE_LIMIT_WRITE` | `20/3600` | Write tool calls per grant ([write tools](security-basics.md#write-tools-opt-in)), on top of the token and grant limits. Fails closed: a limiter error refuses the write. |
| `RB_TRUSTED_PROXY_HOPS` | `0` | Reverse proxies in front of the server (0-5). `X-Forwarded-For` is only believed for that many hops, counted from the right; with `0` the socket address is the client. **Set it behind a proxy**, or all clients share the proxy's address and one bad device can lock the others out. |
| `RB_AUDIT` | `on` | `off` stops recording tool calls, refusals and admin changes. See the [audit log](audit-log.md). |
| `RB_AUDIT_NRQL` | `mask` | `mask` (literal values hidden), `hash`, `full` or `off`: how NRQL text is stored. |
| `RB_AUDIT_RETENTION_DAYS` | `90` | Days to keep audit rows (`0` = forever). Purged at startup and hourly; `relic-bridge audit purge` does it by hand. |
| `RB_AUDIT_CLIENT_IP` | `on` | Record the client address on refused requests. |
| `RB_OTEL`, `RB_OTEL_ENDPOINT`, `RB_OTEL_HEADERS`, `RB_OTEL_SAMPLE`, `RB_OTEL_TRACEPARENT` | `off` | Opt-in OTLP self-monitoring; see [observability](observability.md). |
| `RB_ADMIN_TOKEN` | unset (admin API off unless sign-in is configured) | Bootstrap admin token for `/api/admin/v1` ([admin API](#admin-api)); it acts as `owner`. With sign-in configured the admin API also takes [admin sessions](admin-access.md). 32-512 printable characters, no spaces, randomly generated: predictable values (fewer than 8 distinct characters, a repeated block, runs such as `abcdef…`) and placeholders (`changeme…`) are refused at start, hand-made ones start with a warning. Or `RB_ADMIN_TOKEN_FILE` (a `0600` file). |
| `RB_PASSTHROUGH` | `off` | `on` adds `/passthrough/mcp`, where callers bring their own New Relic key ([pass-through mode](#pass-through-mode)). |
| `RB_WRITE_APPROVAL` | `required` | By default every write is refused unless the client supports MCP elicitation and the person approves the exact change; clients that cannot be asked can only dry-run (refusal audited as `unavailable`). `client` is an explicit opt-down: the model sets `confirm: true` and the server logs a warning at startup. Only meaningful with `RB_WRITE_TOOLS=on`. See [write tools](security-basics.md#write-tools-opt-in). |
| `RB_WRITE_TOOLS` | `off` | `on` offers the opt-in write tools (`create_change_event`, `acknowledge_issue`, `close_issue`, `create_dashboard`). Each still needs its name in the project **and** the grant (owners only), and over OAuth the `mcp:write` scope. Needs `RB_AUDIT=on`. See [ADR-0015](../adr/0015-opt-in-write-tools.md) and [write tools](security-basics.md#write-tools-opt-in). |
| `RB_TASKS` | `on` | `off` turns the MCP Tasks extension off (P7-34): no tasks capability, no task records, slow calls answer inline, `tasks/*` unknown. |
| `RB_MCP_APPS` | `on` | `off` removes the [chart view](charts.md) (`_meta.ui` on the NRQL tools and the `ui://` resource) for every client; `on` shows it only to clients that declare MCP Apps support. |
| `RB_PUBLIC_TOOL_CATALOG` | `off` | `on` lets MCP registries, inspectors and clients list the tools before signing in: `initialize` and `tools/list` without a token answer the static read-only tool list (the same for every project URL, known or not), and `/.well-known/relic-bridge/tools.json` serves it as JSON. Tool calls, resources and prompts still need a token. See [registry listing](registry-listing.md). |
| `RB_PASSTHROUGH_IDENTITY_TTL` | `60` | Seconds a pass-through key's reachable accounts are cached, `0`-`300` (`0` asks New Relic on every request). |
| `RB_HSTS` | `auto` | `Strict-Transport-Security` when the request arrived over https; `true` behind a TLS-terminating proxy. |
| `RB_LOG_LEVEL` | `info` | One JSON line per request on stderr (never the token or the New Relic key). |
| `RB_PUBLIC_URL` | unset | Origin browsers use to reach the server (`https://…`, or `http://localhost:8787` locally). Needed by [admin sign-in](identity-providers.md); its host must be in `RB_ALLOWED_HOSTS`. |
| `RB_GOOGLE_CLIENT_ID` / `RB_GOOGLE_CLIENT_SECRET` | unset | Google sign-in. `RB_GOOGLE_HOSTED_DOMAIN` limits it to one Workspace domain. |
| `RB_GITHUB_CLIENT_ID` / `RB_GITHUB_CLIENT_SECRET` | unset | GitHub sign-in (OAuth app). |
| `RB_OIDC_ISSUER` / `RB_OIDC_CLIENT_ID` / `RB_OIDC_CLIENT_SECRET` | unset | Any OpenID Connect provider, by discovery. Optional `RB_OIDC_NAME`, `RB_OIDC_LABEL`, `RB_OIDC_SCOPES`. |
| `RB_CF_ACCESS_TEAM` / `RB_CF_ACCESS_AUD` | unset | Cloudflare Access in front of the server (team name and application AUD tag). |
| `RB_LOGIN_ALLOW_EMAILS` / `RB_LOGIN_ALLOW_DOMAINS` / `RB_LOGIN_ALLOW_GITHUB_ORGS` | unset | Who may sign in without a pre-created user. Deny by default. |
| `RB_LOGIN_AUTO_PROVISION` | `off` | `member` or `admin`: create a user for an allowlisted identity on its first sign-in. Never `owner`. |
| `RB_SESSION_IDLE_MINUTES` | `30` | Admin sessions end after this many minutes without a request (5-1440). See [admin access](admin-access.md). |
| `RB_SESSION_MAX_HOURS` | `12` | Admin sessions end this many hours after sign-in, whatever the activity (1-168). |
| `RB_OAUTH` | `off` | `on` lets MCP clients without static headers (claude.ai, Claude on your phone, Claude Code) connect with OAuth: people sign in and approve each app on a consent page. Needs sign-in (`RB_PUBLIC_URL` and a provider). See [OAuth](oauth.md). |
| `RB_OAUTH_DCR` | `on` | `off` turns dynamic client registration (`/oauth/register`) off; clients with a metadata document (claude.ai, Claude Code) still work. |
| `RB_OAUTH_DCR_LIMIT` | `30` | Dynamic registrations per hour for the whole server, or `off`. |
| `RB_OAUTH_DCR_IP_LIMIT` | `10` | Dynamic registrations per hour for one client address, or `off`. |
| `RB_OAUTH_DCR_REDIRECT_HOSTS` | unset (any) | Comma-separated https hosts dynamically registered clients may redirect to (e.g. `claude.ai`); loopback is always allowed. |
| `RB_OAUTH_ACCESS_TTL` | `1h` | Lifetime of an OAuth access token, 60 s to 24 h (seconds, or `90m`, `12h`). Never longer than the grant it was approved with. |
| `RB_OAUTH_REFRESH_TTL` | `30d` | Absolute lifetime of an app's authorization (its refresh tokens), 1 h to 365 days; refreshing does not extend it. After it the app asks the person again. |
| `RB_OAUTH_REFRESH_REUSE_WINDOW` | `30` | Refresh token reuse interval in seconds (0-120): the same app presenting a just-renewed refresh token again gets the same new tokens instead of being disconnected. `0` or `off`: strict single use. See [OAuth](oauth.md#lifetimes-and-renewal). |

### What the server enforces

- **One answer for every refusal**: a missing, malformed, unknown, revoked or expired token, a token for another
  project, an unknown or disabled project, a disabled user or an unusable key all get the same `401` with
  `WWW-Authenticate: Bearer`. The token is checked before the project is looked up, so project names can't be probed.
  The reason is in the server log (`"deny":"…"`).
- Each request gets a fresh MCP server with **only the tools its grant allows**; others are neither listed nor
  callable. `run_nrql` / `get_query_result` are hidden when raw NRQL is off.
- Request bodies over 1 MiB are refused (`413`); a request (including its response stream) is cut off after 180 s.
- One JSON-RPC message per request: batches (a JSON array body, removed from MCP in 2025-06-18) are refused with `400`.
- Security headers on every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`,
  `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store`, and HSTS as configured.
- **Rate limits** (in memory, per process): `429` with `Retry-After` and a JSON-RPC error telling the agent to slow
  down. The per-IP request limit applies before authentication. Failed authentications are counted per IP; past the
  budget, further failures get `429` instead of `401`, but a request whose token is valid is still served, so devices
  behind one NAT (or a laptop retrying an expired token) cannot lock each other out. A locked address therefore still
  learns whether a token is valid, at the per-IP request rate: harmless for 256-bit tokens and admin tokens that pass the
  strength check. Per-token and per-grant limits apply after authentication. IPv6 clients are counted per /64.
  `subscriptions/listen` isn't counted. Several server processes each keep their own counters.
- **Audit log**: every tool call, refused request and admin change is recorded without secrets or result data, after
  the response (a failed write is logged, never surfaced). What is stored and how to tune it: [audit log](audit-log.md).
- Storage errors answer `503` (fail closed), never "allowed".
- `subscriptions/listen` (opened by 2026-era clients such as Claude Code) is acknowledged and closed at once: the
  server has no change notifications to push.

## Pass-through mode

For a shared instance that should hold **no** New Relic keys: each request carries the caller's own User key, the
server uses it for that request and forgets it. It is **off** by default (the route answers `404`); turn it on with
`RB_PASSTHROUGH=on`. It works without any project, grant or device token, and doesn't replace them: the per-project
endpoints keep working beside it.

```bash
RB_PASSTHROUGH=on RB_HOST=0.0.0.0 RB_ALLOWED_HOSTS=mcp.example.com RB_HSTS=true relic-bridge serve   # behind TLS
```

Clients point at `https://mcp.example.com/passthrough/mcp` and send two headers:

| Header | Value |
|---|---|
| `X-NewRelic-Api-Key` | A New Relic **User** key (`NRAK-…`). Anything else is refused. |
| `X-NewRelic-Region` | `US` (default), `EU` or `JP`. Another value answers `400`. |

```json
{ "mcpServers": { "newrelic": { "type": "http", "url": "https://mcp.example.com/passthrough/mcp",
  "headers": { "X-NewRelic-Api-Key": "${NEW_RELIC_API_KEY}", "X-NewRelic-Region": "US" } } } }
```

- **HTTPS only.** The key travels in every request. A plain-HTTP request is refused (`403 tls_required`) unless it
  came over https, `RB_HSTS=true` declares a TLS-terminating proxy, or the `Host` is loopback. This guard catches a
  misconfiguration; it can't protect a key a client already sent in clear text, so never expose the port without TLS.
- **Nothing is stored.** The key is never written to the database, the audit log or the log, never echoed in a
  response and only sent to NerdGraph. The server keeps, for at most `RB_PASSTHROUGH_IDENTITY_TTL` seconds, the
  accounts a key reaches, filed under a keyed HMAC fingerprint whose secret is random per process (a fingerprint is
  useless outside that process and changes at every restart). Logs name the key by `keyId` (`pt_` + 12 hex characters
  of that fingerprint).
- **Access** is what the key reaches: every read-only tool, the default query limits (raw NRQL on), every account the
  key can see (the lowest id is the default; tools take an `account` argument).
- **Refusals**: a missing, malformed or refused key, or one that reaches no account, gets one `401` with
  `WWW-Authenticate: NewRelic-Api-Key` (the reason is in the log and an `auth.denied` audit row:
  `passthrough_missing_key`, `passthrough_malformed_key`, `passthrough_invalid_key`, `passthrough_no_accounts`). The
  `Authorization` header is ignored here: device tokens don't work on this route and are never forwarded. When New
  Relic can't be reached the answer is `503`.
- **Rate limits**: the per-IP request limit and failed-authentication throttle apply as on every route (a refused key
  counts as a failure, so key guessing through the server is slow), plus `RB_RATE_LIMIT_PASSTHROUGH_KEY` per key.
- **Audit**: every tool call is a `tool_call` row whose actor is the key's `pt_…` id (no user or grant), found with
  `relic-bridge audit tail --key-id any`; see the [audit log](audit-log.md#pass-through-calls).

## Management CLI

`relic-bridge` manages a local database directly, or a running instance through the admin API. Same commands for
both; full list in the [CLI reference](../reference/cli.md).

```bash
# First run on the server: master key file + database + first key, project and device token.
relic-bridge init --label main --region US --slug prod --url https://mcp.example.com   # key on stdin or hidden prompt
export RB_MASTER_KEY_FILE=~/.config/relic-bridge/master.key                            # back this file up
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
is **off** unless `RB_ADMIN_TOKEN` (or `RB_ADMIN_TOKEN_FILE`) is set or [sign-in](identity-providers.md) is
configured. Automation sends `Authorization: Bearer <admin token>` (the token acts as `owner`); a signed-in browser uses
its admin session cookie with a CSRF token instead (see [admin access](admin-access.md)). Full reference: [admin API](../reference/admin-api.md); the OpenAPI 3.1
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
  (`auth.denied`, `admin_bad_token`); the valid admin token is never refused by that throttle.
- The token must look random: `serve` refuses predictable values and placeholders at start (the error names the rule,
  never the value) and warns about hand-made ones. Use `relic-bridge admin-token generate` or `openssl rand -base64 32`.
- New Relic keys are accepted **only in request bodies**, never in URLs, and never come back: credentials are listed as
  masked metadata (label, region, last 4 characters, validation status, reachable accounts). Token hashes are never
  returned; a new device token is shown once, in the `POST /tokens` response.
- A request with an `Authorization` header is judged by that header alone: its cookies are ignored, so cross-site
  request forgery doesn't apply to bearer calls. Cookie sessions need the CSRF token, the public URL as `Origin` and
  same-origin fetch metadata ([admin access](admin-access.md)). No CORS headers are sent on admin routes, and the
  `Host` / `Origin` checks apply as everywhere else.
- Every change (and every failed attempt at one) writes an `admin` [audit](audit-log.md) row; query them with
  `GET /api/admin/v1/audit?kind=admin`.
- A change takes effect at once on the server that made it (its access cache is cleared); other server processes
  pick it up within `RB_ACCESS_CACHE_TTL`.
- Sign-in with Google, GitHub, Cloudflare Access or OIDC gives browsers an admin session with a role (`owner`,
  `admin`, `member`); the bootstrap token remains for automation and break-glass.

## Docker

The image is `ghcr.io/matiashidalgo/relic-bridge` (linux/amd64 and linux/arm64), published with each GitHub Release as
`:<version>` (and `:latest` for stable releases). **No image is published yet**: `0.1.0` in the examples below stands for
the first published version, so until then build the image yourself (see the end of this section). It is built from distroless Node 24: no shell, no package manager, runs as
uid/gid `65532`, and works with a read-only root filesystem. Its entrypoint is the CLI, so everything in this guide
applies: `docker run IMAGE keys generate`, `docker run IMAGE serve`, `docker exec CONTAINER /nodejs/bin/node /app/dist/index.mjs db backup /data/backup.db`.

| | |
|---|---|
| `/data` | The only writable path: the SQLite database (`RB_DATA_DIR=/data`). Mount a volume; it is created owned by `65532`. |
| `8787` | The server port. The container binds `0.0.0.0` (`RB_HOST`), so **set `RB_ALLOWED_HOSTS`** to the hostname clients use, and publish the port only to a TLS reverse proxy. |
| Secrets | `RB_MASTER_KEY` or `RB_MASTER_KEY_FILE`, optionally `RB_ADMIN_TOKEN` or `RB_ADMIN_TOKEN_FILE`. Nothing secret is baked into the image. |
| Health | `HEALTHCHECK` asks `/health` on loopback every 30 s. A `403 forbidden_host` answer (loopback is not in `RB_ALLOWED_HOSTS`) still counts as healthy: the server is up. |

```bash
docker run -d --name relic-bridge --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -v relic-bridge-data:/data -p 127.0.0.1:8787:8787 \
  -e RB_MASTER_KEY_FILE=/run/secrets/master_key -v "$PWD/master.key:/run/secrets/master_key:ro" \
  -e RB_ALLOWED_HOSTS=mcp.example.com -e RB_TRUSTED_PROXY_HOPS=1 -e RB_HSTS=true \
  ghcr.io/matiashidalgo/relic-bridge:0.1.0
```

**Key files and the `0600` rule.** The server refuses a key file that group or others can read, and the container user
is not root, so the file must be owned by `65532` with mode `0400`/`0600`:
`sudo chown 65532:65532 master.key && sudo chmod 0400 master.key`. Docker bind mounts and compose `file:` secrets keep
the host's owner and mode (the `uid`/`mode` options of compose secrets only apply to Swarm). Kubernetes mounts secret
files as `root`; with `defaultMode: 0400` and no `fsGroup` the pod user cannot read them, and with `fsGroup` the files
become group-readable and are refused. In Kubernetes (or whenever you cannot own the file as `65532`) pass the key as
`RB_MASTER_KEY` from a secret `env` entry instead.

**TLS.** [`deploy/docker-compose.example.yml`](../../deploy/docker-compose.example.yml) puts Caddy in front (automatic
certificates), with the settings this guide requires: the server is not published on the host, `RB_ALLOWED_HOSTS` is your
hostname, `RB_TRUSTED_PROXY_HOPS=1` and `RB_HSTS=true` (the app sees plain HTTP from Caddy; without it no HSTS header
is sent and pass-through requests are refused with `403 tls_required`). Caddy starts only once the server's health
check passes (`depends_on: condition: service_healthy`).

**Maintainers:** the release path relies on repository settings (a `release` environment with required reviewers and a
`main`-only deployment rule, and more). They are listed in [`docs/dev/releasing.md`](../dev/releasing.md).

**Verify before you run it.** Images are signed with cosign keyless signing (GitHub OIDC), carry an SBOM (syft,
CycloneDX) and a build provenance attestation. Pin what you verified by digest, not by tag: in production (and in
compose or Kubernetes manifests) use `ghcr.io/matiashidalgo/relic-bridge:0.1.0@sha256:...` (the `cosign verify`
output prints the digest). Tags are immutable by convention, and `:latest` moves with every stable release (never
backwards), so it is for trying things out only.

```bash
IMAGE=ghcr.io/matiashidalgo/relic-bridge:0.1.0
cosign verify "$IMAGE" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity https://github.com/matiashidalgo/relic-bridge/.github/workflows/docker.yml@refs/heads/main
gh attestation verify "oci://$IMAGE" --repo matiashidalgo/relic-bridge          # build provenance
cosign verify-attestation "$IMAGE" --type cyclonedx \                            # SBOM
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity https://github.com/matiashidalgo/relic-bridge/.github/workflows/docker.yml@refs/heads/main \
  | jq -r '.payload | @base64d | fromjson | .predicate.components[].name' | head
```

Build it yourself with `docker build -t relic-bridge .` from a checkout (the build uses the release configuration, with
test hooks compiled out).

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
