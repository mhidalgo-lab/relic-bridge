---
id: P7-17
title: "doctor: client config files and remote token validity"
phase: 7
status: todo
priority: low
depends_on: [P7-05]
adr: []
owner: ""
---

# P7-17 — doctor: client config files and remote token validity

## Scope
- `relic-bridge doctor --client-configs`: read the MCP client config files `init`/`token create` write (Claude Code
  `.mcp.json` / `~/.claude.json`, Claude Desktop, Cursor, VS Code; paths as in `manage/configs.ts`) and check that the
  relic-bridge entry points at the `--remote` URL (host, `/p/<slug>/mcp` path), uses https, and that its token has the
  `rb_` shape. Report fingerprints only.
- Token validity: with the device token supplied through `RB_TOKEN` or `--token-file` (never an argument), call the
  remote's `whoami`-equivalent endpoint and report valid / expired / revoked.

## Acceptance criteria
- [ ] Each mismatch has an actionable fix; tokens are never printed (fingerprint only).
- [ ] Tests with in-memory file systems for each client format.

## Security notes
Config files hold tokens: read-only, never echoed, scrubbed like the rest of doctor output.

## Docs to update
- CLI reference, troubleshooting.

## Out of scope
- Rewriting client files (that is `token create`).
