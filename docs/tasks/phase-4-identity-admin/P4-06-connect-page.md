---
id: P4-06
title: "Connect page: client config snippets"
phase: 4
status: review
priority: high
depends_on: [P4-04]
adr: []
owner: claude-agent
---

# P4-06 — Connect page: client config snippets

## Scope
- `GET /admin/connect[?project=<id>]` (admin and owner; nav item "Connect"): pick a project, get copy-paste snippets
  for Claude Code (`claude mcp add --transport http … --header`, and `.mcp.json`), Cursor, VS Code, Claude Desktop
  (through `mcp-remote`) and generic clients. claude.ai / mobile are listed as "needs OAuth (Phase 5)".
- The MCP URL is built from the configured public origin (`RB_PUBLIC_URL`), never from the Host header.
- Snippets never contain an existing token (hashed). Shell and `${VAR}` snippets read `RELIC_BRIDGE_TOKEN`
  (`read -rs`, no shell-history leak, P2-18). Only the Desktop snippet holds a literal token, and only on the one-time
  token page.
- "Create token for this device": inline form on the Connect page posting to the existing `POST /admin/tokens`; the
  one-time answer page repeats the snippets with the new token filled in (`no-store`).
- Copy buttons are progressive enhancement (existing static `admin.js`); phone-friendly (scrolling `<pre>`).

## Acceptance criteria
- [x] Snippet formats checked against current official docs (Claude Code, Cursor; VS Code and Desktop as in the clients guide; not run in real clients, see pending decisions).
- [x] Endpoint comes from the public origin; a hostile Host header changes nothing.
- [x] No token in any snippet on the Connect page; the real token appears only on the one-time page, never in a shell command.
- [x] Authorization matrix row, member/anonymous refusals, axe, escaping tests.
- [x] Client guides link to the page; admin-ui guide and threat model updated.

## Security notes
Token shown once; warn against pasting in shared places.

## Docs to update
- Client guides link here.

## Out of scope
- Running every snippet in the real client (maintainer-run matrix; the formats are checked against documentation).
- claude.ai connector URL until Phase 5.
