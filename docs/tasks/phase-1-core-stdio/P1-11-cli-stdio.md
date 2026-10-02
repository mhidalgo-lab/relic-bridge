---
id: P1-11
title: CLI with stdio mode (env and YAML config)
phase: 1
status: todo
priority: high
depends_on: [P1-06, P1-07]
adr: [0005, 0006]
owner: ""
---

# P1-11 — CLI with stdio mode (env and YAML config)

## Goal
`npx relic-bridge` works locally in under two minutes, for one or several projects.

## Scope
- `apps/cli` binary `relic-bridge`; default command `stdio`.
- **Env mode**: `NEW_RELIC_API_KEY`, `NEW_RELIC_REGION` (US|EU), `NEW_RELIC_ACCOUNT_ID`, optional `RB_TOOLS`, `RB_LIMITS_*`.
- **YAML mode**: `--config relic-bridge.yaml` with `projects: [{slug, region, apiKey: ${ENV}, accounts, defaultAccount, tools, limits}]` and `--project <slug>` (one stdio process per project — matches one MCP server entry per project in clients). Schema-validated; plaintext key triggers a warning.
- `serveStdio` dual-era; graceful shutdown; logs to **stderr** only.
- Docs and the `init` output use each client's explicit `env` block for `NEW_RELIC_*`: stdio clients don't reliably inherit
  shell env vars (P0-07).
- `relic-bridge --version`, `--help`.

## Acceptance criteria
- [ ] E2E test spawning the CLI over stdio with fixtures (mock NerdGraph via env override of endpoint — test-only flag, refused in production builds).
- [ ] Works with Claude Code `claude mcp add relic-acme -- npx -y relic-bridge --project acme --config …`.

## Security notes
T8: never print keys; config file permission warning if world-readable.

## Docs to update
- `docs/guide/quickstart-local.md`, configuration reference.

## Out of scope
- HTTP serve (P2-06).
