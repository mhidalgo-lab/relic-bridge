# Quickstart: local stdio

Run relic-bridge on your machine and connect your MCP client to it. You need Node.js 24.11 or later and a New Relic
**User** API key (`NRAK-…`; create one under *API keys* in New Relic, type *User*). Ingest and license keys don't work.

> Until v0.1 is published to npm (P1-15), build from a clone instead of `npx`:
> `pnpm install && pnpm build`, then use `node /path/to/relic-bridge/apps/cli/dist/index.mjs` wherever the examples say
> `npx -y relic-bridge`.

## 1. One account: env mode

Give the client the key, your account id and the region (`US`, `EU` or `JP`) in the server's `env` block. Clients
don't reliably pass your shell environment to stdio servers, so don't rely on `export`.

**Claude Code**

```sh
claude mcp add relic \
  --env NEW_RELIC_API_KEY=<your User key> \
  --env NEW_RELIC_ACCOUNT_ID=1234567 \
  --env NEW_RELIC_REGION=US \
  -- npx -y relic-bridge
```

**JSON config** (Claude Desktop, Cursor and others use this shape)

```json
{
  "mcpServers": {
    "relic": {
      "command": "npx",
      "args": ["-y", "relic-bridge"],
      "env": {
        "NEW_RELIC_API_KEY": "<your User key>",
        "NEW_RELIC_ACCOUNT_ID": "1234567",
        "NEW_RELIC_REGION": "US"
      }
    }
  }
}
```

Ask the agent "who am I in New Relic?": it calls `whoami` and shows your user, region and default account.

## 2. Several projects: YAML mode

Create `~/.config/relic-bridge/relic-bridge.yaml` (any path works) and `chmod 600` it:

```yaml
projects:
  - slug: acme
    region: US
    apiKey: ${NEW_RELIC_API_KEY_ACME}
    defaultAccount: 1234567
  - slug: side-project
    region: EU
    apiKey: ${NEW_RELIC_API_KEY_SIDE}
    defaultAccount: 7654321
```

Add one MCP server per project, each with its own key variable:

```sh
claude mcp add relic-acme \
  --env NEW_RELIC_API_KEY_ACME=<acme User key> \
  -- npx -y relic-bridge --project acme --config /home/you/.config/relic-bridge/relic-bridge.yaml
```

Use an absolute path for `--config`: the client decides the working directory.

## 3. Restrict what the agent can do (optional)

- `tools: [whoami, list_accounts, search_entities, get_golden_metrics]` exposes only those tools.
- `limits: { rawNrql: false }` removes the free-form NRQL tools; purpose-built tools keep working.
- `accounts: [...]` lists every account the agent may query.

All options: [configuration reference](configuration.md). How limits behave: [query limits](query-limits.md).

## Troubleshooting

The server logs JSON lines to stderr (Claude Code: `claude --debug`, or the client's MCP log).

| Message | Fix |
|---|---|
| `NEW_RELIC_API_KEY is not set` | Put the variable in the client's `env` block for this server. |
| `apiKey refers to ${…}, which is not set` | Same, with the variable named in the message. |
| `RB_AUTH_INVALID_KEY` | Use a User key (`NRAK-…`). |
| `… has N projects; choose one with --project` | Add `--project <slug>`. |
| `Unknown tool name(s)` | Fix the name in `tools` / `RB_TOOLS`; the message lists the valid ones. |
| Wrong-region error from a tool | Set `region` / `NEW_RELIC_REGION` to the account's data center. |
