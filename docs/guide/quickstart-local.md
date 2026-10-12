# Quickstart: local stdio

Run relic-bridge on your machine and connect your MCP client to it. You need Node.js 24.11 or later and a New Relic
**User** API key (`NRAK-…`; create one under *API keys* in New Relic, type *User*; see New Relic's
[API keys docs](https://docs.newrelic.com/docs/apis/intro-apis/new-relic-api-keys/)). Ingest and license keys don't
work. Use a dedicated key ([security basics](security-basics.md)).

Your region is where your account lives: `US` for `one.newrelic.com`, `EU` for `one.eu.newrelic.com`, `JP` if New
Relic set you up in Japan. Your account id is shown in the account picker of the New Relic UI.

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

**JSON config** (Claude Desktop, Cursor and others use this shape; VS Code differs, see the [client guides](clients.md))

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

## 4. Check it works

Ask the agent "who am I in New Relic?": it calls `whoami` and shows your user, region and default account. Then try
"which event types does my account have?" (`list_event_types`) and a query such as
`SELECT count(*) FROM Transaction SINCE 1 hour ago`.

### Started without a key?

With no configuration at all (no `NEW_RELIC_API_KEY`, no `NEW_RELIC_ACCOUNT_ID`, no `--config`), relic-bridge still
starts in **setup mode**: it lists its read-only tools, so a client, an MCP inspector or a registry can show what it
offers, and every tool call answers `RB_AUTH_UNAUTHORIZED` with what to set. Nothing reaches New Relic. Add the
variables above and restart the server. A partial configuration (for example a key without an account id) is still an
error at startup.

## Next steps

- Per-client setup (Claude Code, Claude Desktop, Cursor, VS Code): [client guides](clients.md)
- [Security basics](security-basics.md): dedicated key, read-only tools, prompt-injection note
- Something wrong? [Troubleshooting](troubleshooting.md)
- Listing relic-bridge in an MCP registry: [registry listing](registry-listing.md)
