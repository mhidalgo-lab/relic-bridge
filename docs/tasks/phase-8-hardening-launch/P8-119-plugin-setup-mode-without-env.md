---
id: P8-119
title: Claude Code plugin - start in setup mode when the New Relic variables are not set
phase: 8
status: todo
priority: medium
depends_on: []
adr: []
owner: ""
---

# P8-119 — Claude Code plugin: start in setup mode when the New Relic variables are not set

## Goal
First install of the plugin (2026-10-28, 0.13.1 from npm, Claude Code on Linux): with `NEW_RELIC_API_KEY`,
`NEW_RELIC_ACCOUNT_ID` and `NEW_RELIC_REGION` unset in the shell Claude Code started from, `/mcp` shows
`plugin:relic-bridge:relic` as failed with only "Connection closed", and `/relic-bridge:relic-status` has no tools to
call. The user learns nothing about what to set.

The server already handles this case: with neither variable set (an empty value counts as unset, `isUnconfigured` in
`apps/cli/src/stdio.ts`) it starts in setup mode, lists the tools and answers every call with what to configure.
The plugin's `.mcp.json` references `${NEW_RELIC_API_KEY}` and `${NEW_RELIC_ACCOUNT_ID}` without a default, so the
server never gets that far. With `${VAR:-}` defaults, an unconfigured install would connect and `/relic-status`
would explain the next step.

## Scope
- Reproduce first and record the cause in this file: does Claude Code refuse the config for an unset `${VAR}` with no
  default, or does the server start and exit (or time out on the first `npx` download)? Check `claude --debug` /
  the MCP log.
- `plugins/relic-bridge/.mcp.json`: give `NEW_RELIC_API_KEY` and `NEW_RELIC_ACCOUNT_ID` an empty default
  (`${NEW_RELIC_API_KEY:-}`, `${NEW_RELIC_ACCOUNT_ID:-}`); keep `${NEW_RELIC_REGION:-US}`.
- `relic-status` command: when the tools answer with the setup message, say which variables to set, that Claude Code
  must be restarted from a shell that has them, and that `/mcp` should then show the server connected.
- If the cause turns out to be the first `npx` download exceeding the client's startup timeout, document it (and
  `MCP_TIMEOUT`) in the plugin guide instead of, or as well as, the defaults.

## Acceptance criteria
- [ ] Cause recorded in this file.
- [ ] With the variables unset, a fresh install connects (`/mcp`) and `/relic-bridge:relic-status` reports what to set,
      without asking for the key as a tool argument.
- [ ] With only one of the two variables set, startup still fails with its own error (partial configuration is not
      setup mode).
- [ ] `scripts/test/claude-plugin.test.ts` updated for the new `env` values; `claude plugin validate` passes for the
      plugin and the marketplace.

## Security notes
T23: setup mode never asks for the key as a tool argument; the setup message only names the variables. The empty
default sends no secret anywhere. No change to how a set key is handled or logged.

## Docs to update
- `docs/guide/claude-code-plugin.md` (Credentials: what happens when the variables are missing, how to check with
  `/mcp`).
- Changeset (patch) if the published plugin files change.

## Out of scope
- The marketplace entry's `version` (`0.1.0`) not matching `plugin.json` (`0.7.0`): separate task.
- The plugin's skills naming tools by bare name when several relic-bridge servers are connected.
- Publishing the plugin to a marketplace.
