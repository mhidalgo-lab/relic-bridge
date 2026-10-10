# Client setup guides

The sections below start relic-bridge as a **local stdio** server. To connect to a server you host (Phase 2) instead,
see [remote servers](#remote-servers-self-hosted-http). For stdio, read the [local quickstart](quickstart-local.md)
first for the key, account id and region. In the examples replace `<your User key>` with your `NRAK-…` key and
`1234567` with your account id.

> **Pre-release.** Until relic-bridge is published to npm (first release: 0.7.0), replace `npx -y relic-bridge` with
> `node /absolute/path/to/relic-bridge/apps/cli/dist/index.mjs` (after `pnpm install && pnpm build`). In JSON configs
> that means `"command": "node"` and `"args": ["/absolute/path/to/relic-bridge/apps/cli/dist/index.mjs"]`.

Two rules apply to every client:

1. **Put `NEW_RELIC_*` in the server's `env` block.** Clients start stdio servers with a minimal environment (see
   [configuration](configuration.md)).
2. **Don't commit the file that holds your key.** For project-level config files, use the secret-prompt options shown
   below or keep the key in a user-level file.

For several projects, use YAML mode: add `--project <slug> --config /absolute/path/relic-bridge.yaml` to the args and
put the `${VAR}` variables the YAML refers to in `env` (see [quickstart, section 2](quickstart-local.md)).

## Claude Code

```sh
claude mcp add relic \
  --env NEW_RELIC_API_KEY=<your User key> \
  --env NEW_RELIC_ACCOUNT_ID=1234567 \
  --env NEW_RELIC_REGION=US \
  -- npx -y relic-bridge
```

- The default scope is `local` (only you, only this project, stored in `~/.claude.json`). Add `--scope user` to use the
  server in every project. Avoid `--scope project`: it writes `.mcp.json` into the repository, and you would commit your
  key.
- Check it: `claude mcp list`, or `/mcp` inside a session. Remove it with `claude mcp remove relic`.
- Debug output: `claude --debug` shows the server's stderr.
- Prefer a bundle? The [Claude Code plugin](claude-code-plugin.md) adds investigation skills and slash commands.

## Claude Desktop

Open *Settings > Developer > Edit Config*, which opens `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

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

Quit and restart Claude Desktop completely after editing. The tools appear under the connectors/tools menu of a new
chat. Logs: `~/Library/Logs/Claude/mcp-server-relic.log` (macOS) or `%APPDATA%\Claude\logs\` (Windows).

Desktop doesn't use your shell's `PATH`: if `npx` isn't found, use the absolute path to `npx` (or to `node` in the
pre-release setup) as `command`. On Windows, if `npx` fails to start, use `"command": "cmd"` with
`"args": ["/c", "npx", "-y", "relic-bridge"]`.

## Cursor

Create `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project; don't commit it with a key). The shape is
the same `mcpServers` object as Claude Desktop:

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

Then open *Settings > Tools & MCP* (older versions: *MCP*) and make sure `relic` is enabled with a green status.

## VS Code (GitHub Copilot agent mode)

VS Code reads `.vscode/mcp.json` (workspace) or the user-level file from the command *MCP: Open User Configuration*.
The top-level key is `servers` (not `mcpServers`), and `inputs` lets VS Code prompt for the key and store it, so it
never sits in the file:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "newrelic-api-key",
      "description": "New Relic User API key (NRAK-...)",
      "password": true
    }
  ],
  "servers": {
    "relic": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "relic-bridge"],
      "env": {
        "NEW_RELIC_API_KEY": "${input:newrelic-api-key}",
        "NEW_RELIC_ACCOUNT_ID": "1234567",
        "NEW_RELIC_REGION": "US"
      }
    }
  }
}
```

Start the server from the *Start* code lens above it in the file (or *MCP: List Servers*), then pick the tools in
Copilot Chat in **Agent** mode.

## Remote servers (self-hosted HTTP)

A server started with `relic-bridge serve` ([self-hosting](self-hosting.md), [multi-device setup](multi-device.md))
is reached over Streamable HTTP at `https://<your host>/p/<project>/mcp` (on Cloudflare: [deploy guide](cloudflare-deploy.md)) with a per-device token in an
`Authorization: Bearer rb_live_…` header. Nothing runs on the device, and the New Relic key never leaves the server.
**Use https**: a token sent over plain HTTP can be read on the way. Create a token per device with
`relic-bridge token create` (it prints these snippets with your values filled in, once) or in the admin panel, whose
**Connect** page (`/admin/connect`) shows the same snippets for each project ([admin panel](admin-panel.md)).

| Client | Remote config |
|---|---|
| Claude Code | `claude mcp add --transport http` (below) |
| Cursor | `url` + `headers` in `mcp.json` |
| VS Code | `"type": "http"` + `headers` in `mcp.json` |
| Claude Desktop | through the `mcp-remote` bridge (below) |
| claude.ai web, Claude mobile | OAuth, no token: [phone and claude.ai guide](oauth-phone.md) (not yet verified with the real apps) |

### Claude Code

```sh
claude mcp add --transport http --scope user relic-prod https://mcp.example.com/p/prod/mcp \
  --header "Authorization: Bearer rb_live_<your device token>"
```

This line contains the token, so it ends up in your shell history (and `relic-bridge token create` prints it that way
too). Keep it out: start the command with a space (bash with `HISTCONTROL=ignorespace`, zsh with
`setopt HIST_IGNORE_SPACE`), or skip the literal token and use the `${RELIC_BRIDGE_TOKEN}` JSON form below, or read it
from a file (`--header "Authorization: Bearer $(cat ~/.config/relic-bridge/prod.token)"`, file mode `0600`). If a token
did land in history, remove that entry and revoke the token (`relic-bridge token revoke <id>`).

The same in a JSON file (`.mcp.json`, or `~/.claude.json` for user scope). Claude Code expands `${VAR}` in `headers`,
so the token can stay in the environment; define `RELIC_BRIDGE_TOKEN` where Claude Code starts (a shell profile, or a
user environment variable on Windows) and restart it:

```json
{
  "mcpServers": {
    "relic-prod": {
      "type": "http",
      "url": "https://mcp.example.com/p/prod/mcp",
      "headers": { "Authorization": "Bearer ${RELIC_BRIDGE_TOKEN}" }
    }
  }
}
```

`--scope project` writes `.mcp.json` into the repository: use it only with the `${VAR}` form, never with the literal
token. Check with `claude mcp list` or `/mcp`. (Checked against Claude Code's current documentation and its
`claude mcp add --help`.)

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json`). Cursor expands `${env:NAME}` in `url` and `headers`:

```json
{
  "mcpServers": {
    "relic-prod": {
      "url": "https://mcp.example.com/p/prod/mcp",
      "headers": { "Authorization": "Bearer ${env:RELIC_BRIDGE_TOKEN}" }
    }
  }
}
```

### VS Code

`.vscode/mcp.json` or the user configuration. Let VS Code prompt for the token once and keep it out of the file:

```json
{
  "inputs": [
    { "type": "promptString", "id": "relic-token", "description": "relic-bridge device token", "password": true }
  ],
  "servers": {
    "relic-prod": {
      "type": "http",
      "url": "https://mcp.example.com/p/prod/mcp",
      "headers": { "Authorization": "Bearer ${input:relic-token}" }
    }
  }
}
```

### Claude Desktop

Desktop's built-in connectors are added in claude.ai and use OAuth ([guide](oauth-phone.md)); to use a bearer token instead, go through the
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge, which Desktop starts as a stdio server. The header is
passed through `env` so the token is not a visible command-line argument (and a space-free `--header` value works on
Windows):

```json
{
  "mcpServers": {
    "relic-prod": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.example.com/p/prod/mcp", "--header", "Authorization:${RB_AUTH}"],
      "env": { "RB_AUTH": "Bearer rb_live_<your device token>" }
    }
  }
}
```

Restart Desktop fully after editing; the `command`/`PATH` notes in the Claude Desktop section above apply.

Only the Claude Code snippet was checked (against its documentation and its CLI). The Cursor, VS Code and Claude
Desktop snippets follow each client's documentation but haven't been run by the maintainers. For
problems, see [troubleshooting](troubleshooting.md#hosted-self-hosted-server).

## Write tools and your client

If your server offers write tools ([write tools](security-basics.md#write-tools-opt-in)), they show up only on a
connection whose project and grant name them (and, over OAuth, whose app asked for `mcp:write` and you ticked "Also allow
changes"). They are annotated `readOnlyHint: false` (`close_issue` also `destructiveHint: true`), so clients that ask
before running non-read-only tools (Claude Code, Claude Desktop, VS Code) do. **Don't add them to auto-approve lists**
(`permissions.allow` in Claude Code, "always allow" in Desktop, `chat.tools.autoApprove` in VS Code): the client's prompt
is the one approval the model cannot give itself. Each call also needs `confirm: true`; `dry_run: true` previews.

If your client supports **MCP elicitation** (a form the server can show you), relic-bridge also asks you, in that form,
to approve the exact change just before it is made (what, where, the values; text from New Relic is shown in quotes).
Decline or cancel and nothing is changed; the answer is recorded in the [audit log](audit-log.md). This works on stdio
and, over HTTP, with clients speaking protocol 2026-07-28; an older client over HTTP cannot be asked and only the
`confirm: true` flow applies. Never set your client to auto-accept these forms. Which clients show them is not yet
verified: [client compatibility](../reference/client-compatibility.md).

## Slow queries and MCP Tasks

A NRQL query that is still running after `timeout_seconds` comes back as a handle: the agent calls `get_query_result`
with the `queryId` later. On a remote server (`serve`, Cloudflare), a client that supports the MCP **Tasks** extension
(`io.modelcontextprotocol/tasks`, protocol 2026-07-28) gets a task instead and polls it itself; the result is the same
as a normal call. Task results are kept for 15 minutes, only for the device (token or OAuth sign-in) that started the
query. Nothing to configure. Which clients support it: [client compatibility](../reference/client-compatibility.md#mcp-tasks-p7-13-2026-10-06).

On a Tasks-declaring client, `generate_alert_insights_report` is also a task: the call looks the issue up and returns the task, and each poll
runs up to three report sections inside its own request budget and quota. The finished report is the same as the synchronous one;
you get it from the last poll. Clients without Tasks get the report in one call as before.
`generate_user_impact_report`, `entity_health` and `dependency_health` work the same way: the creating call does the cheap
preparation and each poll runs a few lookups, queries or sections inside its own request budget and quota, so a big check no
longer has to fit one request. The finished answer equals the synchronous one.

Tasks are also served on **stdio** (a 2026-07-28 client that declares the extension; records live in the process only
and are lost when it exits) and on the **pass-through** route (a task is visible only to the same New Relic key and
region; a restart, or another replica without a shared `passthrough.fingerprintSecret`, loses it). Both are poll-only:
there are no status notifications, so the client asks with `tasks/get`.

## Other clients and MCP Inspector

Any client that can launch a stdio server works: give it the command `npx -y relic-bridge` and the three `env`
variables. To test without an AI client:

```sh
NEW_RELIC_API_KEY=<your User key> NEW_RELIC_ACCOUNT_ID=1234567 \
  npx @modelcontextprotocol/inspector npx -y relic-bridge
```

(The Inspector passes its own environment to the server.)

## Check that it works

Ask the agent: "Use whoami, then run `SELECT count(*) FROM Transaction SINCE 1 hour ago`." You should see your user,
region and account, then a count (an empty result is fine if the account has no APM data: try `list_event_types`).

If it doesn't work, see [troubleshooting](troubleshooting.md).

## Compatibility status

The server speaks standard MCP over stdio and was verified with the MCP TypeScript SDK client and the MCP Inspector
(P0-07, P1-12). Claude Code's `claude mcp add` syntax was checked against its `--help`. The config shapes for Claude
Desktop, Cursor and VS Code follow each client's current documentation but haven't been run by the maintainers yet;
report problems as issues.
