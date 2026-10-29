# Troubleshooting

Start with the agent: ask it to run `whoami`. It reports the region, default account, limits and enabled tools, and
never shows the key. Then read the server's log (JSON lines on stderr: Claude Code `claude --debug`, Claude Desktop's
MCP log file, VS Code *MCP: List Servers > Show Output*).

Or run `relic-bridge doctor` (add `--remote https://your-server` for a deployed instance, `--offline` to avoid network
calls, `--json` for scripts). It checks Node, your config, the New Relic key and region, the master key, the database,
`RB_PUBLIC_URL`, clock skew and the remote server, and prints a fix for each problem without ever showing a secret. It
changes nothing; `relic-bridge doctor --fix` applies the one safe local fix (database file mode `0600`) and says so. See
the [CLI reference](../reference/cli.md#doctor).

If a client cannot connect to your server, run `relic-bridge doctor --client-configs --remote https://your-server`: it
checks the relic-bridge entry in your Claude Code, Claude Desktop, Cursor and VS Code files (URL, https, `/p/<slug>/mcp`
path, token shape) and, with the token in `RB_TOKEN` or `--token-file`, whether the server still accepts it.

## Server won't start or doesn't appear

| Message / symptom | Cause and fix |
|---|---|
| `NEW_RELIC_API_KEY is not set.` / `NEW_RELIC_ACCOUNT_ID is not set.` | The variable isn't in the client's `env` block for this server. Exporting it in your shell isn't enough. |
| Tools are listed, but every call answers `RB_AUTH_UNAUTHORIZED: relic-bridge is not configured yet` (stderr: `setup mode`) | Neither `NEW_RELIC_API_KEY` nor `NEW_RELIC_ACCOUNT_ID` nor a config file reached the server, so it only lists its tools. Add both variables to the client's `env` block (or `--config`) and restart the server. |
| `NEW_RELIC_ACCOUNT_ID is the unexpanded reference ${NEW_RELIC_ACCOUNT_ID}: …` (or another variable) | The client config says `"${NAME}"` and `NAME` was not set where the client started, so the client passed the text through (Claude Code does). Set it there and restart the client, or use `"${NAME:-}"` so an unset variable is empty. When none of the variables are set, the server starts in setup mode instead. |
| `apiKey refers to ${NAME}, which is not set.` | YAML mode: set `NAME` in the client's `env` block. |
| `<file> has N projects; choose one with --project.` | Add `--project <slug>` to the args. |
| `Unknown tool name(s) in the tool allowlist` | A typo in `tools` / `RB_TOOLS`; the message lists valid names (see the [tool reference](../reference/tools.md)). |
| `The configured key is not a New Relic User API key.` (`RB_AUTH_INVALID_KEY`), exit code 1 | The key doesn't look like a User key (`NRAK-` followed by letters and digits), so the server refuses to start without contacting New Relic. Ingest, license and browser keys can't query NerdGraph: create a User key. |
| `RB_PROJECT is ignored in env mode` | A warning, not a failure: `RB_PROJECT` only selects a project from a YAML file. Add `--config` / `RB_CONFIG`, or remove it. |
| `Environment variable … is deprecated since … and will be removed in …` (also `Config file key …`, `Flag …`) | A warning: the name still works until the release it names. Switch to the replacement in the message; `relic-bridge doctor` lists every deprecated name you use (`deprecated-config`). See [deprecations](versioning.md#deprecations). |
| `Config file … is readable by every user` / `… by its group` | A warning: run `chmod 600 <file>` (the file may hold a plaintext key). Not checked on Windows. |
| Unknown flag, exit code 2 | Run `relic-bridge --help`. There is no `--api-key` flag. |
| Exit code 1 right away | Configuration error: read the first stderr line. Unknown keys in YAML are errors (`apikey` vs `apiKey`). |
| `npx: command not found`, or the client shows the server as failed | The client can't see Node. Use absolute paths for `command` (`which npx`). Node 24.11 or later is required. |
| Works in a terminal, not in the client | The client's environment differs from your shell. Set variables in `env`; use absolute paths, including for `--config`. |
| Server output is garbled / client reports a protocol error | Something else wrote to stdout. Don't wrap the command in a script that prints; relic-bridge itself logs only to stderr. |
| After upgrading relic-bridge, a tool fails with `Structured content does not match the tool's output schema`, or a new parameter is rejected or missing | The client still holds the tool list from before the upgrade, and a stateless server can't tell it to refresh. Reconnect the MCP client (`/mcp` in Claude Code; remove and re-add the connector, or restart the app, elsewhere). Newer versions advertise output schemas that accept added fields, so new output fields no longer break old clients, but new parameters still need a reconnect. |
| Changes to the config have no effect | Restart the client (Claude Desktop must be fully quit) or reload the server. |

## Errors returned by tools

Tool errors carry a stable code and usually a hint.

| Code | Meaning | Fix |
|---|---|---|
| `RB_AUTH_INVALID_KEY` | New Relic rejected the key (HTTP 401): revoked, deleted, mistyped. (A key that isn't `NRAK-…` is caught at startup, see above.) | Create a new User key in New Relic and update the client config. |
| `RB_AUTH_WRONG_REGION` | New Relic refused the account in this region. | Set `NEW_RELIC_REGION` / `region` to `US`, `EU` or `JP` to match where the account lives (the New Relic URL `one.eu.newrelic.com` means EU). |
| `RB_AUTH_FORBIDDEN` | The key's user can't read this account, or the account isn't allowed on this connection (`Account N is not available on this connection`). | Check the user's roles in New Relic; add the account to `accounts` / `RB_ACCOUNTS`; use `list_accounts` to see what's available. |
| `RB_INPUT_INVALID` | The input or NRQL is invalid (e.g. double-quoted strings, empty query, bad account id). | Fix the query as the message says; NRQL strings use single quotes; one statement per `run_nrql` call (no `;`). |
| `RB_LIMIT_QUERY` | The query exceeds your limits: time window, `LIMIT`, event type allow/deny. | Shorten `SINCE`, lower `LIMIT`, or raise the limit in the config. See [query limits](query-limits.md). |
| `RB_LIMIT_RESPONSE_TOO_LARGE` | The response exceeded `maxResponseBytes`. | Narrow the query (fewer facets, shorter window, a `LIMIT`) or raise `maxResponseBytes`. |
| `RB_TOOL_DISABLED` | The tool is off: `rawNrql: false`, or it isn't in `tools`. | Use a purpose-built tool, or enable it in the config. |
| `RB_WRITE_APPROVAL_UNAVAILABLE` | A write was refused: the server requires a person's approval (`RB_WRITE_APPROVAL=required`) and this client cannot be asked. Nothing was changed. | Use a client that supports MCP elicitation on protocol 2026-07-28 (such as Claude Code), or the owner sets `RB_WRITE_APPROVAL=off`. Do not retry with `confirm: true`. See [write tools](write-tools.md). |
| `RB_WRITE_APPROVAL_DECLINED` | The person declined, cancelled or did not answer the approval prompt. Nothing was changed. | Ask again only if the person wants the change. |
| `RB_QUERY_NOT_FOUND` | `get_query_result` got a `query_id` that New Relic does not know: wrong id, or the result expired (`expiresAt`). | Rerun `run_nrql` and use the new handle. |
| `RB_NERDGRAPH_TIMEOUT` | The query took too long. | Narrow the time window or facets. |
| `RB_NERDGRAPH_RATE_LIMITED` | New Relic is rate limiting this key. | Wait, and ask for fewer parallel queries. |
| `RB_NERDGRAPH_UNAVAILABLE` | New Relic had a server or network error. | Retry shortly; check New Relic's status page. |
| `RB_BUDGET_EXHAUSTED` | One tool call needed too many NerdGraph requests (per-call limit, 1000 by default, shown by `whoami` as `limits.perCallBudget`; it is not a running total and starts again with every call). | Ask for a narrower request. |
| `RB_NERDGRAPH_ERROR` | NerdGraph returned another error; the (redacted) message is included. | Read the message; for NRQL errors, correct the query. |
| `RB_LIMIT_QUOTA` | The grant's usage quota for the day or month is used up (the error says which and when it starts again). | An administrator can raise or remove it: [Quotas](admin-guide.md#quotas-per-grant). |
| `RB_AUTH_UNAUTHORIZED`, `RB_LIMIT_RATE` | Used by the hosted modes (tokens, rate limits). On stdio, `RB_AUTH_UNAUTHORIZED` only means setup mode (no configuration at all, see above). | See [hosted server](#hosted-self-hosted-server) above. |
| `RB_INTERNAL` | A bug. The message includes a reference, and details are in the stderr log. | Report an issue with the log line (check it for secrets first). |

## Hosted (self-hosted server)

For `relic-bridge serve` ([self-hosting](self-hosting.md), [multi-device setup](multi-device.md)). The server's log
names the reason for every refusal (`"deny":"…"`); the client only ever sees a generic answer.

**The server won't start** (the error is one JSON line on stderr, with a `hint`):

| Message / `code` | Fix |
|---|---|
| `RB_MASTER_KEY is not set` (`master_key_missing`) | Set `RB_MASTER_KEY` or `RB_MASTER_KEY_FILE` ([secrets](secrets.md)). |
| `no keychain entry "…" in the …` / `secret-tool could not reach a Secret Service` | Store the entry with `relic-bridge keychain set <name>`; on Linux/WSL2 install `libsecret-tools` and run a Secret Service, or use a key file ([secrets](secrets.md#os-keychain-optional)). `relic-bridge doctor` shows the `keychain` check. |
| `RB_MASTER_KEY_FILE: … is readable by other users (mode 644)` | `chmod 600` the file (Docker: owned by uid `65532`, mode `0400`; see [self-hosting](self-hosting.md#docker)). |
| `Binding 0.0.0.0 (not loopback) needs RB_ALLOWED_HOSTS` | List the hostnames clients use: `RB_ALLOWED_HOSTS=mcp.example.com`. |
| `the master key given for version 1 does not match…` (`key_mismatch`) | Wrong key for this database. Restore the right key from your backup; a new key needs a new version (`keys generate --key-version 2`, then [rotate](secrets.md#rotate-the-key)). |
| `key_version_retired` | The key's version is older than one the database already uses: start with the current key. |
| `Cannot listen on 127.0.0.1:8787 (EADDRINUSE)` | Another process uses the port: `--port`. |
| `Database not found` (a management command) | The database is created by `init` or the first `serve`; check `--db` / `RB_DB_PATH` / `RB_DATA_DIR`. |

**A client can't connect:**

| Answer | Cause and fix |
|---|---|
| `401` (`WWW-Authenticate: Bearer`) | The log's `deny` field says why: `missing_token` (no `Authorization` header), `malformed_header` (not `Bearer <token>`), `malformed` or `bad_checksum` (not a relic-bridge token: a typo or a guess), `unknown`, `revoked`, `expired`; or, for a good token, `project_not_found` / `project_disabled` / `grant_wrong_project` (a token for another project's URL), `grant_revoked`, `grant_expired`, `user_disabled`, or a `credential_*` reason (the New Relic key is revoked, invalid, not yet validated, ...). Create a new token if needed; `relic-bridge credential list` shows keys marked `invalid`. In Claude Code an unset `${RELIC_BRIDGE_TOKEN}` stays literal and is `malformed`. |
| `403 forbidden_host` | The `Host` is not in `RB_ALLOWED_HOSTS` (the name in the URL, or the proxy forwards another host). |
| `403 forbidden_origin` | A browser `Origin` that is not allowed: `RB_ALLOWED_ORIGINS` / `RB_CORS_ORIGINS`. |
| `403 tls_required` | Pass-through route only: reach it over https. |
| `404` on `/passthrough/mcp` | Pass-through is off: `RB_PASSTHROUGH=on`. |
| `413`, `400` | Body over 1 MiB, or a JSON-RPC batch (one message per request). |
| `429` | A rate limit (`Retry-After` says when). Behind a proxy set `RB_TRUSTED_PROXY_HOPS`, or every client shares the proxy's address. Failed authentications are limited per address: past the budget further failures get `429` (valid tokens are still served) until the bucket refills. |
| `503` | Storage error (fail closed), or New Relic unreachable on pass-through. See the server log. |
| `504` (`{"error":"timeout"}`) | The request did not finish within the server's deadline (3 minutes): the body was not delivered in time, or the tool call ran too long. Narrow the query; for a slow client or proxy, check the network between them. |
| TLS or certificate errors | The reverse proxy, not relic-bridge: check DNS and ports 80/443. |

**A script gets `403`, but `curl` works.** Some deployments sit behind an edge or bot-protection rule (a CDN, a WAF,
a managed bot filter) that refuses requests by their `User-Agent`, and many HTTP libraries send a default one that
such rules treat as automated, for example Python's `urllib` (`Python-urllib/3.x`). That answer comes from the layer
in front of relic-bridge, not from relic-bridge: its own `403`s are the JSON bodies in the table above
(`forbidden_host`, `forbidden_origin`, `tls_required`), and they appear in the server's audit log and `"deny"` log
field, while a refusal at the edge never reaches the server. To check, repeat the request with `curl`, then with your
script after setting a normal `User-Agent` header (for example `User-Agent: my-tool/1.0`). If it passes, the edge rule
was the cause. An operator who wants scripted API clients allowed can adjust the bot or WAF settings of whatever fronts
the deployment (for example an exception for the MCP path); the exact setting depends on the provider and on your
plan, so check its documentation. relic-bridge does not need or configure such a rule.

**OAuth clients (claude.ai, phone)** have their own table: [troubleshooting in the phone guide](oauth-phone.md#troubleshooting).

A revoked or newly created token, grant or project takes effect within `RB_ACCESS_CACHE_TTL` seconds (default 30) on
a running server, immediately when changed with `--remote`.

## Empty or surprising results

- **No rows:** the event type or attribute may not exist in that account or window. Ask the agent to use
  `list_event_types` and `get_attributes` before querying.
- **Wrong account's data:** the default account is `NEW_RELIC_ACCOUNT_ID`; pass `account` explicitly or see
  `list_accounts`.
- **Fewer rows than expected:** a `LIMIT` above your limit is lowered (and one is added when missing); the response notes the adjustment. Windows longer than `maxWindowDays` are rejected.
- **Tools you expected are missing:** check `tools` / `RB_TOOLS` and `rawNrql: false` via `whoami`.
