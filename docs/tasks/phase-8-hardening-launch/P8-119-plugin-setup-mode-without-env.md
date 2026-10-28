---
id: P8-119
title: Claude Code plugin - start in setup mode when the New Relic variables are not set
phase: 8
status: review
priority: medium
depends_on: []
adr: []
owner: claude-agent
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
- [x] Cause recorded in this file.
- [x] With the variables unset, a fresh install connects (`/mcp`) and `/relic-bridge:relic-status` reports what to set,
      without asking for the key as a tool argument.
- [x] With only one of the two variables set, startup still fails with its own error (partial configuration is not
      setup mode).
- [x] `scripts/test/claude-plugin.test.ts` updated for the new `env` values; `claude plugin validate` passes for the
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

## Cause (2026-10-28)
Two separate failures, both from Claude Code's MCP log (`~/.cache/claude-cli-nodejs/<project>/mcp-logs-plugin-relic-bridge-relic/`):

1. **"Connection closed"**: with `NEW_RELIC_ACCOUNT_ID` unset, Claude Code passed the literal text
   `${NEW_RELIC_ACCOUNT_ID}` (no default in `.mcp.json`) instead of refusing the config or passing `''`. The server saw a
   non-empty value, so not setup mode, and exited with `NEW_RELIC_ACCOUNT_ID must be a positive integer.`
2. **"connection timed out after 30000ms"** (two later sessions starting at the same time, with about 20 other MCP
   servers): `npx -y relic-bridge` answered `initialize` after more than 30 s. Without that load it answers in 2-5 s
   (the binary alone in 1-4 s). Pinning the version does not let `npx` skip the registry.

## Done
- `.mcp.json`: `${NEW_RELIC_API_KEY:-}` and `${NEW_RELIC_ACCOUNT_ID:-}`.
- CLI: a value that is a whole `${NAME}` / `${NAME:-x}` reference counts as unset for setup mode; when the rest of the
  configuration is set, startup names the variable ("… is the unexpanded reference ${NAME}: the variable is not set
  where your MCP client started."). This also covers hand-written client configs without a default.
- `/relic-status` says what to set when the tools answer with the setup message.
- Plugin guide: setup mode, `MCP_TIMEOUT`, global install; troubleshooting, quickstart and registry guides; THREAT_MODEL
  T33 row; patch changeset.
