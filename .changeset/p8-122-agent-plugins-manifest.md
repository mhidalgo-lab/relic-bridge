---
"relic-bridge": patch
---

The repository is now also an [Agent Plugins](https://agent-plugins.org/specification) 1.0.0 plugin: a root `plugin.json`, an `mcp.json` that runs `npx -y relic-bridge` over stdio, and the investigation skills under `skills/`. Its version follows the npm package like `server.json` and the Claude Code plugin. AGENTS.md now starts with how to use relic-bridge from an agent.
