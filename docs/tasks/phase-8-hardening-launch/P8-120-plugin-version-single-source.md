---
id: P8-120
title: Claude Code plugin - one version, kept in step with the npm package
phase: 8
status: todo
priority: low
depends_on: []
adr: []
owner: ""
---

# P8-120 — Claude Code plugin: one version, kept in step with the npm package

## Goal
The marketplace entry (`.claude-plugin/marketplace.json`) says `0.1.0`, `plugins/relic-bridge/.claude-plugin/plugin.json`
says `0.7.0`, and the npm package the plugin launches is at `0.13.1`. Claude Code uses the `plugin.json` value without
warning and `claude plugin validate .` reports the mismatch. Installs from a git-hosted marketplace stay on their cached
copy until that string changes, so a version left behind means users never get skill or command fixes.

## Scope
- Remove `version` from the marketplace entry; `plugin.json` is the one source (Claude Code docs: set it in one place).
- `node scripts/release.ts sync-version` also writes `plugin.json`'s `version` from `apps/cli/package.json`, and
  `sync-version --check` (already in `pnpm lint`) fails when it differs. `version-packages` therefore bumps the plugin
  on every release.
- Set it to the current CLI version (`0.13.1`).

## Acceptance criteria
- [ ] `claude plugin validate .` and `claude plugin validate plugins/relic-bridge` pass with no version warning.
- [ ] Tests: sync-version writes and checks `plugin.json`; the plugin test asserts the marketplace entry has no `version`.

## Security notes
None: version metadata only.

## Docs to update
- `docs/guide/claude-code-plugin.md` (the plugin version follows the npm package).
- `docs/RESEARCH.md` (Claude Code plugin version precedence, with source).

## Out of scope
- Publishing the plugin to a marketplace.
