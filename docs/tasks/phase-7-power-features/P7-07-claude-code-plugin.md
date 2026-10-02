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
- Plugin bundling relic-bridge MCP config (stdio or remote URL), investigation skills (incl. an **NRQL debug ladder**: preflight → `count(*)` sanity → `keyset()` → change one clause at a time → classify the failure), slash commands (e.g. `/relic-investigate`), marketplace listing. Also publish to the official MCP Registry.

## Acceptance criteria
- [ ] Installable via `/plugin`; skills reference relic-bridge tool names.

## Security notes
No secrets in plugin files.

## Docs to update
- Plugin guide.

## Out of scope
- —
