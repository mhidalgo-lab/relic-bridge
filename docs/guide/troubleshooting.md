# Troubleshooting

Start with the agent: ask it to run `whoami`. It reports the region, default account, limits and enabled tools, and
never shows the key. Then read the server's log (JSON lines on stderr: Claude Code `claude --debug`, Claude Desktop's
MCP log file, VS Code *MCP: List Servers > Show Output*).

## Server won't start or doesn't appear

| Message / symptom | Cause and fix |
|---|---|
| `NEW_RELIC_API_KEY is not set.` / `NEW_RELIC_ACCOUNT_ID is not set.` | The variable isn't in the client's `env` block for this server. Exporting it in your shell isn't enough. |
| `apiKey refers to ${NAME}, which is not set.` | YAML mode: set `NAME` in the client's `env` block. |
| `<file> has N projects; choose one with --project.` | Add `--project <slug>` to the args. |
| `Unknown tool name(s) in the tool allowlist` | A typo in `tools` / `RB_TOOLS`; the message lists valid names (see the [tool reference](../reference/tools.md)). |
| `The configured key is not a New Relic User API key.` (`RB_AUTH_INVALID_KEY`), exit code 1 | The key doesn't look like a User key (`NRAK-` followed by letters and digits), so the server refuses to start without contacting New Relic. Ingest, license and browser keys can't query NerdGraph: create a User key. |
| `RB_PROJECT is ignored in env mode` | A warning, not a failure: `RB_PROJECT` only selects a project from a YAML file. Add `--config` / `RB_CONFIG`, or remove it. |
| `Config file … is readable by every user` / `… by its group` | A warning: run `chmod 600 <file>` (the file may hold a plaintext key). Not checked on Windows. |
| Unknown flag, exit code 2 | Run `relic-bridge --help`. There is no `--api-key` flag. |
| Exit code 1 right away | Configuration error: read the first stderr line. Unknown keys in YAML are errors (`apikey` vs `apiKey`). |
| `npx: command not found`, or the client shows the server as failed | The client can't see Node. Use absolute paths for `command` (`which npx`). Node 24.11 or later is required. |
| Works in a terminal, not in the client | The client's environment differs from your shell. Set variables in `env`; use absolute paths, including for `--config`. |
| Server output is garbled / client reports a protocol error | Something else wrote to stdout. Don't wrap the command in a script that prints; relic-bridge itself logs only to stderr. |
| Changes to the config have no effect | Restart the client (Claude Desktop must be fully quit) or reload the server. |

## Errors returned by tools

Tool errors carry a stable code and usually a hint.

| Code | Meaning | Fix |
|---|---|---|
| `RB_AUTH_INVALID_KEY` | New Relic rejected the key (HTTP 401): revoked, deleted, mistyped. (A key that isn't `NRAK-…` is caught at startup, see above.) | Create a new User key in New Relic and update the client config. |
| `RB_AUTH_WRONG_REGION` | New Relic refused the account in this region. | Set `NEW_RELIC_REGION` / `region` to `US`, `EU` or `JP` to match where the account lives (the New Relic URL `one.eu.newrelic.com` means EU). |
| `RB_AUTH_FORBIDDEN` | The key's user can't read this account, or the account isn't allowed on this connection (`Account N is not available on this connection`). | Check the user's roles in New Relic; add the account to `accounts` / `RB_ACCOUNTS`; use `list_accounts` to see what's available. |
| `RB_INPUT_INVALID` | The input or NRQL is invalid (e.g. double-quoted strings, empty query, bad account id). | Fix the query as the message says; NRQL strings use single quotes. |
| `RB_LIMIT_QUERY` | The query exceeds your limits: time window, `LIMIT`, event type allow/deny. | Shorten `SINCE`, lower `LIMIT`, or raise the limit in the config. See [query limits](query-limits.md). |
| `RB_LIMIT_RESPONSE_TOO_LARGE` | The response exceeded `maxResponseBytes`. | Narrow the query (fewer facets, shorter window, a `LIMIT`) or raise `maxResponseBytes`. |
| `RB_TOOL_DISABLED` | The tool is off: `rawNrql: false`, or it isn't in `tools`. | Use a purpose-built tool, or enable it in the config. |
| `RB_NERDGRAPH_TIMEOUT` | The query took too long. | Narrow the time window or facets. |
| `RB_NERDGRAPH_RATE_LIMITED` | New Relic is rate limiting this key. | Wait, and ask for fewer parallel queries. |
| `RB_NERDGRAPH_UNAVAILABLE` | New Relic had a server or network error. | Retry shortly; check New Relic's status page. |
| `RB_BUDGET_EXHAUSTED` | One tool call needed too many NerdGraph requests (limit 1000). | Ask for a narrower request. |
| `RB_NERDGRAPH_ERROR` | NerdGraph returned another error; the (redacted) message is included. | Read the message; for NRQL errors, correct the query. |
| `RB_AUTH_UNAUTHORIZED`, `RB_LIMIT_RATE` | Reserved for the hosted modes (tokens, OAuth, per-token rate limits). v0.1 stdio never returns them. | Not applicable in v0.1. |
| `RB_INTERNAL` | A bug. The message includes a reference, and details are in the stderr log. | Report an issue with the log line (check it for secrets first). |

## Empty or surprising results

- **No rows:** the event type or attribute may not exist in that account or window. Ask the agent to use
  `list_event_types` and `get_attributes` before querying.
- **Wrong account's data:** the default account is `NEW_RELIC_ACCOUNT_ID`; pass `account` explicitly or see
  `list_accounts`.
- **Fewer rows than expected:** a `LIMIT` above your limit is lowered (and one is added when missing); the response notes the adjustment. Windows longer than `maxWindowDays` are rejected.
- **Tools you expected are missing:** check `tools` / `RB_TOOLS` and `rawNrql: false` via `whoami`.
