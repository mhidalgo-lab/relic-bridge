# Registry listing and tool discovery

MCP registries, inspectors and some clients want to see a server's tools **before** anyone signs in. relic-bridge
supports that without weakening access: what can be listed is only the static list of read-only tool definitions, the
same for everyone; running a tool always needs a credential.

## Local (stdio): setup mode

`npx -y relic-bridge` with no configuration at all (no `NEW_RELIC_API_KEY`, no `NEW_RELIC_ACCOUNT_ID`, no `--config` /
`RB_CONFIG`; empty values and `${VAR}` references the client did not expand count as not set) starts in setup mode:

- `initialize` and `tools/list` work and list the read-only tools with their real schemas;
- every tool call (and a resource read that needs New Relic) answers
  `RB_AUTH_UNAUTHORIZED: relic-bridge is not configured yet …` with a hint naming the variables to set;
- stderr says `setup mode`; nothing is sent to New Relic (there is no key).

A partial configuration (a key without an account id, a key that isn't a User key, a broken YAML file) still stops the
server with its own error, so a mistake is not hidden behind setup mode.

## Self-hosted server: `RB_PUBLIC_TOOL_CATALOG` (off by default)

By default every request to `/p/<project>/mcp` needs a token, and every refusal is the same `401`. With
`RB_PUBLIC_TOOL_CATALOG=on` (Node `serve` and the Worker):

| Request without an `Authorization` header | Answer |
|---|---|
| `POST /p/<anything>/mcp` with `initialize`, `notifications/initialized`, `server/discover`, `ping` or `tools/list` | The static read-only tool list. The same bytes for every project URL, whether the project exists or not. |
| Anything else: `tools/call`, `resources/*`, `prompts/*`, `tasks/*`, `subscriptions/listen`, batches, `GET`, `DELETE` | The usual `401` (with the OAuth `resource_metadata` challenge when OAuth is on). |
| `GET /.well-known/relic-bridge/tools.json` | The same list as a JSON document (`name`, `version`, `note`, `tools`). |

A request that sends an `Authorization` header always takes the normal path: a valid token lists the tools of its
grant, an invalid one gets the `401`. The public list never includes write tools (even with `RB_WRITE_TOOLS=on`), never
names a project, grant or account, and is answered before the project is looked up, so it can't be used to find out
which projects exist. Unauthenticated requests count against the per-IP rate limit.

Trade-off: a client that starts sign-in only when `initialize` is refused will show the tools first and ask to sign in
at the first tool call. Leave the setting off if your clients behave better with a `401` up front.

## MCP Registry metadata (`server.json`)

The repository root holds [`server.json`](../../server.json) for the
[official MCP Registry](https://github.com/modelcontextprotocol/registry) (schema `2025-12-11`): the npm package
`relic-bridge` over stdio, with its environment variables (`NEW_RELIC_API_KEY` marked secret). The npm package carries
the matching `mcpName` (`io.github.mhidalgo-lab/relic-bridge`), which the registry checks to verify the namespace.
`node scripts/release.ts sync-version` keeps its versions equal to the CLI package's, and `pnpm lint` checks it.

There is no `remotes` entry: every self-hosted deployment has its own URL. Publishing (`mcp-publisher login github`,
then `mcp-publisher publish` after the npm release) is a maintainer step and is not automated yet.
