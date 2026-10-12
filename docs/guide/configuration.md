# Configuration (stdio CLI)

`relic-bridge` runs as a local MCP server over stdio. It reads its settings from **environment variables** (one
connection) or from a **YAML file** (one or more projects). This page is the reference; for a first setup see the
[local quickstart](quickstart-local.md).

> **Set variables in the MCP client's `env` block.** MCP clients start stdio servers with a minimal environment and
> don't reliably pass on your shell variables (measured in P0-07). Put `NEW_RELIC_*` (and any variable your YAML file
> references) in the client's server entry, not only in `~/.bashrc`.

## Command line

```text
relic-bridge [stdio] [--config <file> [--project <slug>]] [--log-level <level>]
relic-bridge db backup <file> [--db <path>]
relic-bridge --help | --version
```

| Flag | Env equivalent | Meaning |
|---|---|---|
| `--config <file>` | `RB_CONFIG` | YAML config file. Use an absolute path in client configs (`~/` is expanded). Without it, env mode is used. |
| `--project <slug>` | `RB_PROJECT` | Project to serve from the file. Optional when the file has one project. |
| `--log-level <level>` | `RB_LOG_LEVEL` | `debug`, `info` (default), `warn`, `error`. |
| `--db <path>` | `RB_DB_PATH` | SQLite database for `serve`, the management commands, `db backup`, `keys rotate`, `credential revalidate` and `audit purge`; default `<data dir>/relic-bridge.db` (`RB_DATA_DIR`, see [self-hosting](self-hosting.md)). |
| — | `RB_MASTER_KEY` / `RB_MASTER_KEY_FILE` / `RB_MASTER_KEY_KEYCHAIN` | Master key that encrypts stored New Relic keys (remote modes, `keys rotate`, `credential revalidate`). See [secrets](secrets.md). |
| — | `RB_MASTER_KEY_PREVIOUS` / `RB_MASTER_KEY_PREVIOUS_FILE` / `RB_MASTER_KEY_PREVIOUS_KEYCHAIN` | Previous master key, only while rotating. |
| `--key-version <n>` | — | Version written into a key by `keys generate` (default 1). |

Flags win over env vars. There is deliberately **no flag for the API key**: command lines show up in process lists and
shell history. Unknown flags are refused.

Exit codes: `0` normal shutdown (stdin closed, SIGINT, SIGTERM), `1` configuration error, `2` usage error. Logs are
JSON lines on **stderr**; stdout is reserved for MCP messages.

## Env mode

Used when no config file is given. When neither `NEW_RELIC_API_KEY` nor `NEW_RELIC_ACCOUNT_ID` is set either, the
server starts in **setup mode** (P7-14): it lists the read-only tools and every call answers `RB_AUTH_UNAUTHORIZED`
with what to configure. Setting only one of the two is a configuration error (exit code 1).

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `NEW_RELIC_API_KEY` | yes | | A New Relic **User** key (`NRAK-…`). Ingest and license keys can't query NerdGraph. |
| `NEW_RELIC_ACCOUNT_ID` | yes | | Default account: tools that take no account use it. |
| `NEW_RELIC_REGION` | no | `US` | `US`, `EU` or `JP` (case-insensitive). Must match the account's data center. |
| `RB_ACCOUNTS` | no | | Extra account ids this connection may query, comma-separated. The default account is always allowed. |
| `RB_TOOLS` | no | all | Tool allowlist, comma-separated (e.g. `whoami,list_accounts,run_nrql`). Unknown names stop startup. Write tools must be listed here by name. |
| `RB_WRITE_APPROVAL` | no | `required` | `required`: a write needs a person's approval through MCP elicitation; a client that cannot be asked can only dry-run and is refused (stdio, `serve`, Worker). `client` is an explicit opt-down (the model sets `confirm: true`; logs a startup warning when writes are on). |
| `RB_WRITE_TOOLS` | no | `off` | `on` offers the opt-in [write tools](security-basics.md#write-tools-opt-in) (`create_change_event`, `acknowledge_issue`, `close_issue`, `create_dashboard`); each still needs its name in `RB_TOOLS` / `tools`. Each write is logged on stderr. |
| `RB_LIMITS_MAX_LIMIT` | no | `1000` | Highest NRQL `LIMIT` (1–5000). |
| `RB_LIMITS_MAX_WINDOW_DAYS` | no | `7` | How far back a query may reach and how wide its window may be, in days (1–3660): `now − SINCE` and `UNTIL − SINCE` (plus `COMPARE WITH`) must each be at most this, and exactly this many days is allowed. |
| `RB_LIMITS_RAW_NRQL` | no | `true` | Accepts `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off` (case-insensitive); anything else stops startup. `false` removes `run_nrql` and `get_query_result` (agent-written NRQL). |
| `RB_MCP_APPS` | no | `on` | `off` removes the [chart view](charts.md) (`_meta.ui` on `run_nrql` / `get_query_result` and the `ui://` resource) for every client. `on`: only clients that declare MCP Apps support see it. Same name for `serve` and the Worker. |
| `RB_TASKS` | no | `on` | `off` is the kill switch for the MCP Tasks extension (P7-34): no tasks capability in `server/discover`, no task record is written, a slow call answers inline (`run_nrql` returns its `get_query_result` handle; composite reports run in one request), and `tasks/*` are unknown methods. Applies to stdio, `serve`, the Worker and pass-through. Same name everywhere. |
| `RB_LIMITS_MAX_RESPONSE_BYTES` | no | `524288` | Largest NerdGraph response accepted (1 KiB – 16 MiB). |
| `RB_LIMITS_EVENT_TYPES_ALLOW` | no | | Only these event types may be queried (comma-separated, exact case). |
| `RB_LIMITS_EVENT_TYPES_DENY` | no | | These event types may not be queried (comma-separated, case-insensitive). |

See [query limits](query-limits.md) for what each limit does.

The NRQL query cache (both modes) is set with `RB_QUERY_CACHE` (`on` by default, `off`) and `RB_QUERY_CACHE_TTL`
(seconds a result over a moving window is reused, `0`-`300`, default `30`). It lives in the process memory and is gone
when the process exits; see [query cache](query-cache.md).

## YAML mode

```yaml
# relic-bridge.yaml (keep it chmod 600)
version: 1                      # optional
projects:
  - slug: acme                  # lowercase letters, digits, dashes
    name: Acme production       # optional, for humans
    region: EU                  # US (default) | EU | JP
    apiKey: ${NEW_RELIC_API_KEY_ACME}
    defaultAccount: 1234567
    accounts: [1234567, 7654321]  # optional; must include defaultAccount. Default: [defaultAccount]
    tools: [whoami, list_accounts, run_nrql, search_entities]  # optional; default: all read-only tools
    limits:                     # optional; same meaning as RB_LIMITS_*
      maxLimit: 500
      maxWindowDays: 3
      rawNrql: true
      maxResponseBytes: 524288
      eventTypes:
        deny: [Log]
  - slug: side-project
    apiKey: ${NEW_RELIC_API_KEY_SIDE}
    defaultAccount: 2222222
```

Rules:

- The file is validated at startup. Unknown keys are errors (a typo such as `apikey` or `rawnrql` fails instead of being
  ignored). Slugs must be unique.
- `apiKey` should be exactly `${ENV_VAR}`: the key is read from that variable, which must be set in the client's `env`
  block. Or `keychain:<name>`: the key is read from the OS keychain entry you stored with
  `relic-bridge keychain set <name>` (see [secrets](secrets.md#os-keychain-optional); nothing secret is then in the
  client's config at all, and a missing entry stops startup with a fix). A literal key works but logs a warning.
- These variables are **ignored** in YAML mode; the file is the source of truth: `NEW_RELIC_API_KEY`,
  `NEW_RELIC_ACCOUNT_ID`, `NEW_RELIC_REGION`, `RB_ACCOUNTS`, `RB_TOOLS` and every `RB_LIMITS_*`. (Variables your
  `${VAR}` references name are read, of course.) These still apply: `RB_CONFIG`, `RB_PROJECT` (unless `--project`
  is given) and `RB_LOG_LEVEL`.
- Conversely, `RB_PROJECT` is ignored in env mode (a warning is logged).
- On Linux and macOS a warning is logged when the file is readable by every user or by its group
  (`chmod 600 relic-bridge.yaml`).
- The file may be at most 1 MiB.

**One process per project.** Each MCP server entry in your client runs `relic-bridge --config … --project <slug>`, so
each project shows up as its own server with its own tools and key.

## What the server exposes

- Tools: the built-in read-only tools, filtered by `tools` / `RB_TOOLS`. With `rawNrql: false`, `run_nrql` and
  `get_query_result` are not listed at all.
- `whoami` reports the project slug (YAML mode), region, default account, limits and the enabled tools. It never shows
  the key.
- Each tool call gets its own request id and a budget of 1000 NerdGraph calls; at most 5 NerdGraph calls run at once.
- Results of NRQL queries are reused for a short time ([query cache](query-cache.md)); `run_nrql` takes
  `cache: "bypass"` for a fresh answer.

## Test-only settings

`RB_TEST_NERDGRAPH_URL` points NerdGraph calls at a local mock. Only builds made with `RB_TEST_HOOKS=1` (relic-bridge's
own E2E tests) honour it, and only for loopback URLs. The published build refuses to start when it is set.
