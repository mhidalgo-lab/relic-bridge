---
id: P8-122
title: Agent Plugins manifest and agent-facing discoverability
phase: 8
status: review
priority: medium
depends_on: [P8-120]
adr: []
owner: claude-agent
---

# P8-122 — Agent Plugins manifest and agent-facing discoverability

## Goal
Agent-readiness scanners found no Agent Plugins manifest and no agent configuration when they followed the author's
site to this repository. Describe relic-bridge in the Agent Plugins format, tell agents how to use it from AGENTS.md,
and make the README point at both, without changing the Claude Code plugin.

## Scope
- Root `plugin.json` per [Agent Plugins 1.0.0](https://agent-plugins.org/specification): `$schema`, `name`, and
  version, description, author, homepage, repository, license and keywords from the existing manifests.
- Root `mcp.json` (the spec forbids inline MCP config): the `npx -y relic-bridge` stdio server. No `env`: the spec does
  not expand `${VAR}` and forbids secrets there, so the credentials come from the client's environment.
- Root `skills/` as a symlink to `plugins/relic-bridge/skills/` (the spec discovers skills only at that fixed location;
  a link inside the plugin root is allowed, and avoids a copy).
- `node scripts/release.ts sync-version` writes and checks the root `plugin.json` version too.
- Test against the 1.0.0 schema constraints (like `server.json`) and a test that fails when any published version
  differs.
- AGENTS.md: a short "Using relic-bridge from an agent" section. README: agent pointer and the author's agent page.
- GitHub topics: mcp, mcp-server, agent-skills, claude-code-plugin, new-relic, nerdgraph.

## Acceptance criteria
- [x] `plugin.json` and `mcp.json` meet the 1.0.0 schema constraints (`scripts/test/agent-plugin.test.ts`).
- [x] `pnpm version-packages` keeps `plugin.json` in step; `pnpm lint` and a test fail when versions differ.
- [x] `claude plugin validate .` and `claude plugin validate plugins/relic-bridge` pass; the Claude Code plugin
      manifests are unchanged.
- [x] AGENTS.md section under about 40 lines, quoting only commands that exist.
- [x] README names AGENTS.md and every plugin manifest and links https://mhidalgo.ar/developers/.
- [ ] GitHub topics set (owner action: repository settings, done when the branch is pushed).

## Security notes
No new runtime surface. The manifests hold no secrets and `mcp.json` has no `env`, so no key can be put in package data
(test). The skills link resolves inside the repository (test), as the spec requires.

## Docs to update
- AGENTS.md, README.md, docs/guide/claude-code-plugin.md, docs/RESEARCH.md.

## Out of scope
- Publishing to npm, the MCP Registry or any plugin directory.
- Slash commands in the Agent Plugins format (v1 has none).
