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
- [x] GitHub topics set on the repository (`gh repo edit --add-topic`).
- [x] `pnpm lint && pnpm typecheck && pnpm test` pass (259 files, 5100 tests).
- [x] The Claude Code plugin still installs (`claude plugin marketplace add` + `claude plugin install` in a clean
      config dir: 0.13.1, read from `plugins/relic-bridge`).

## Done
- `plugin.json` (root): `$schema` 1.0.0, `name`, `version` 0.13.1, and description, author, homepage, license and
  keywords copied from `plugins/relic-bridge/.claude-plugin/plugin.json`; `repository` from `server.json`.
- `mcp.json` (root): server `relic`, `type: stdio`, `npx -y relic-bridge`, no `env` (see Decisions).
- `skills` (root): symlink to `plugins/relic-bridge/skills/` (`investigate-service`, `investigate-alert`,
  `nrql-debug-ladder`).
- `scripts/release.ts`: `AGENT_PLUGIN_JSON` and `PLUGIN_MANIFESTS`; `sync-version` writes and `--check`s both plugin
  manifests; `writePluginJsonVersion` names the file in its errors. `scripts/test/release.test.ts` covers it.
- `scripts/test/agent-plugin.test.ts`: schema constraints of both files, same metadata as the Claude Code manifest,
  every published version equal (CLI package, `server.json`, both manifests), no `env` or secrets, `skills/` resolves
  inside the repository and each skill's `name` matches its directory.
- AGENTS.md "Using relic-bridge from an agent" (about 30 lines); README "For agents" paragraph and author line with
  https://mhidalgo.ar/developers/; plugin guide and RESEARCH.md sections; changeset
  `.changeset/p8-122-agent-plugins-manifest.md`.
- GitHub topics: agent-skills, claude-code-plugin, mcp, mcp-server, nerdgraph, new-relic.

## Decisions
- MCP config is in `mcp.json`, not `plugin.json`: the spec forbids inline MCP configuration.
- No `env` in `mcp.json`: the spec expands only `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`, so `${NEW_RELIC_API_KEY:-}` would
  reach the server as literal text and override a key set in the client's environment; the spec also forbids secrets
  in `env` and has no credential field. The New Relic variables come from the client's environment.
- Skills are linked, not copied: the spec finds them only in the root `skills/` and allows links that resolve inside
  the plugin root. Windows clones need `core.symlinks=true`.
- Slash commands are not in the Agent Plugins files (v1 has no commands); AGENTS.md lists them.
- Schema validation is a constraint test like `server.json`'s: the third-party schema is neither vendored nor fetched
  in CI.

## Security notes
No new runtime surface. The manifests hold no secrets and `mcp.json` has no `env`, so no key can be put in package data
(test). The skills link resolves inside the repository (test), as the spec requires.

## Docs to update
- AGENTS.md, README.md, docs/guide/claude-code-plugin.md, docs/RESEARCH.md.

## Out of scope
- Publishing to npm, the MCP Registry or any plugin directory.
- Slash commands in the Agent Plugins format (v1 has none).
