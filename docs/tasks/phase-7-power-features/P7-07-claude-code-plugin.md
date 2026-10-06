---
id: P7-07
title: "Claude Code plugin (MCP config + skills + commands)"
phase: 7
status: todo
priority: medium
depends_on: [P6-13]
adr: []
owner: ""
---

# P7-07 — Claude Code plugin (MCP config + skills + commands)

## Scope
- `plugins/relic-bridge/` plugin: `.claude-plugin/plugin.json`, `.mcp.json` (local stdio server, key from the environment),
  `mcp-remote.example.json` (remote HTTP template, token from `${RELIC_BRIDGE_TOKEN}`; not loaded automatically),
  `skills/` (`nrql-debug-ladder`: preflight with `whoami`/`list_event_types`/`get_attributes` → `count(*)` sanity →
  `keyset()` → change one clause at a time → classify the failure; `investigate-service`; `investigate-alert`) and
  `commands/` (`/relic-investigate`, `/relic-nrql-debug`, `/relic-status`).
- Marketplace manifest `.claude-plugin/marketplace.json` at the repo root (installable from a local checkout or the GitHub repo).
- Validation test: parses the manifests and frontmatter and checks every tool name used in skills/commands exists in the registry.
- Guide `docs/guide/claude-code-plugin.md`.
- Skills state the untrusted-data rule and use the current tool names and arguments (`docs/reference/tools.md`).

## Acceptance criteria
- [ ] Plugin files pass `claude plugin validate` (plugin and marketplace) and a repo test.
- [ ] Installable via `/plugin` from the local marketplace; skills reference relic-bridge tool names.
- [ ] Every tool name in skills/commands is checked against the registry by a test.
- [ ] No secrets in plugin files (env expansion only); test asserts it.
- [ ] Guide written; clients guide links to it.
- [ ] Publishing to a marketplace and to the official MCP Registry: **not done**, logged as an owner decision.

## Security notes
No secrets in plugin files. Skills tell the agent that tool results are untrusted data.

## Docs to update
- Plugin guide, clients guide.

## Out of scope
- Publishing to any marketplace or the MCP Registry (owner decision).
- Bundling a pinned relic-bridge binary (the plugin uses `npx -y relic-bridge`, available after the v0.1 npm release).
