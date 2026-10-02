---
id: P2-10
title: CLI management commands (local and remote)
phase: 2
status: todo
priority: high
depends_on: [P2-09]
adr: []
owner: ""
---

# P2-10 — CLI management commands

## Scope
- `relic-bridge init` (wizard: storage path, master key generation, first credential/project, first device token).
- `credential add|list|rotate|remove`, `project add|list|update`, `grant create|list|revoke`, `token create|list|revoke`, `audit tail`.
- Target local DB directly or a remote instance: `--remote https://… --admin-token …` (via Admin API) — same commands work against the Worker.
- Prints ready-to-paste client configs (Claude Code command, JSON for Desktop/Cursor/VS Code).

## Acceptance criteria
- [ ] E2E: init → add 2 credentials (US+EU fixtures) → 2 projects → tokens → MCP call succeeds per project.

## Security notes
Keys entered via hidden prompt or stdin, never as CLI args (shell history).

## Docs to update
- CLI reference, self-hosting guide.

## Out of scope
- —
