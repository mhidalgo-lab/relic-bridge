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
relic-bridge --help | --version
```

| Flag | Env equivalent | Meaning |
|---|---|---|
| `--config <file>` | `RB_CONFIG` | YAML config file. Use an absolute path in client configs (`~/` is expanded). Without it, env mode is used. |
| `--project <slug>` | `RB_PROJECT` | Project to serve from the file. Optional when the file has one project. |
| `--log-level <level>` | `RB_LOG_LEVEL` | `debug`, `info` (default), `warn`, `error`. |

Flags win over env vars. There is deliberately **no flag for the API key**: command lines show up in process lists and
shell history. Unknown flags are refused.

Exit codes: `0` normal shutdown (stdin closed, SIGINT, SIGTERM), `1` configuration error, `2` usage error. Logs are
JSON lines on **stderr**; stdout is reserved for MCP messages.

## Env mode

Used when no config file is given.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `NEW_RELIC_API_KEY` | yes | | A New Relic **User** key (`NRAK-…`). Ingest and license keys can't query NerdGraph. |
| `NEW_RELIC_ACCOUNT_ID` | yes | | Default account: tools that take no account use it. |
| `NEW_RELIC_REGION` | no | `US` | `US`, `EU` or `JP` (case-insensitive). Must match the account's data center. |
| `RB_ACCOUNTS` | no | | Extra account ids this connection may query, comma-separated. The default account is always allowed. |
| `RB_TOOLS` | no | all | Tool allowlist, comma-separated (e.g. `whoami,list_accounts,run_nrql`). Unknown names stop startup. |
| `RB_LIMITS_MAX_LIMIT` | no | `1000` | Highest NRQL `LIMIT` (1–5000). |
| `RB_LIMITS_MAX_WINDOW_DAYS` | no | `7` | Longest time window a query may cover, in days (1–3660). |
| `RB_LIMITS_RAW_NRQL` | no | `true` | `false` removes `run_nrql` and `get_query_result` (agent-written NRQL). |
| `RB_LIMITS_MAX_RESPONSE_BYTES` | no | `524288` | Largest NerdGraph response accepted (1 KiB – 16 MiB). |
| `RB_LIMITS_EVENT_TYPES_ALLOW` | no | | Only these event types may be queried (comma-separated, exact case). |
| `RB_LIMITS_EVENT_TYPES_DENY` | no | | These event types may not be queried. |

See [query limits](query-limits.md) for what each limit does.

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
  block. A literal key works but logs a warning.
- `RB_LIMITS_*`, `RB_TOOLS` and `NEW_RELIC_*` are **ignored** in YAML mode; the file is the source of truth.
- On Linux and macOS a warning is logged when the file is readable by every user (`chmod 600 relic-bridge.yaml`).
- The file may be at most 1 MiB.

**One process per project.** Each MCP server entry in your client runs `relic-bridge --config … --project <slug>`, so
each project shows up as its own server with its own tools and key.

## What the server exposes

- Tools: the built-in read-only tools, filtered by `tools` / `RB_TOOLS`. With `rawNrql: false`, `run_nrql` and
  `get_query_result` are not listed at all.
- `whoami` reports the project slug (YAML mode), region, default account, limits and the enabled tools. It never shows
  the key.
- Each tool call gets its own request id and a budget of 1000 NerdGraph calls; at most 5 NerdGraph calls run at once.

## Test-only settings

`RB_TEST_NERDGRAPH_URL` points NerdGraph calls at a local mock. Only builds made with `RB_TEST_HOOKS=1` (relic-bridge's
own E2E tests) honour it, and only for loopback URLs. The published build refuses to start when it is set.
