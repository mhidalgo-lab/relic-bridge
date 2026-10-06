# Claude Code plugin

The `relic-bridge` plugin bundles, for [Claude Code](https://code.claude.com/docs/en/plugins): the MCP server
configuration, investigation skills and slash commands. It lives in `plugins/relic-bridge/` and the repository root has
a marketplace manifest (`.claude-plugin/marketplace.json`).

> **Status.** Not published to any marketplace or to the MCP Registry yet (owner decision). Install it from a checkout.
> The MCP config uses `npx -y relic-bridge`, which works after the v0.1 npm release; before that, edit
> `plugins/relic-bridge/.mcp.json` to run `node /absolute/path/to/apps/cli/dist/index.mjs` (see [clients](clients.md)).

## Install (from a checkout or the GitHub repo)

```text
/plugin marketplace add /absolute/path/to/relic-bridge
/plugin install relic-bridge@relic-bridge
```

Validate the files offline with `claude plugin validate plugins/relic-bridge` and `claude plugin validate .`.

## Credentials

Nothing secret is stored in the plugin. Claude Code expands `${VAR}` from the environment it starts in:

| Mode | Variables | Notes |
|---|---|---|
| Local stdio (default `.mcp.json`) | `NEW_RELIC_API_KEY`, `NEW_RELIC_ACCOUNT_ID`, optional `NEW_RELIC_REGION` (default `US`) | See the [local quickstart](quickstart-local.md). |
| Remote server | `RELIC_BRIDGE_URL` (`https://<host>/p/<project>/mcp`), `RELIC_BRIDGE_TOKEN` | Copy `mcp-remote.example.json` over `.mcp.json`, or add it with `claude mcp add` ([clients](clients.md#claude-code)). The New Relic key stays on the server. |

A missing variable without a default makes Claude Code refuse to load that server config: set the variables, restart,
and check `/mcp`.

## What is in it

| Kind | Name | Purpose |
|---|---|---|
| Skill | `nrql-debug-ladder` | Preflight (`whoami`, `time_range`, `list_event_types`), `count(*)` sanity, attribute check (`get_attributes`, `keyset()`), change one clause at a time, classify the failure. |
| Skill | `investigate-service` | Health overview, errors, deployments, latency, logs and dependencies of an entity. |
| Skill | `investigate-alert` | What is firing, why, who is affected and what changed. |
| Command | `/relic-investigate <target>` | Pick the right investigation skill. |
| Command | `/relic-nrql-debug <query>` | Run the debug ladder. |
| Command | `/relic-status` | Check identity, region, accounts and granted tools. |

The skills name tools exactly as in the [tool reference](../reference/tools.md) and tell the agent that tool results are
untrusted data. A test (`scripts/test/claude-plugin.test.ts`) checks every tool and argument named in a skill or
command against the registry, so a rename breaks the build until the skills are updated.
