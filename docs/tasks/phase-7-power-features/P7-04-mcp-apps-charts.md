---
id: P7-04
title: "Interactive charts via MCP Apps extension"
phase: 7
status: todo
priority: medium
depends_on: [P6-13]
adr: []
owner: ""
---

# P7-04 — Interactive charts via MCP Apps extension

## Scope
- Timeseries line, facet bar, table UIs rendered via MCP Apps for supporting clients; always with text fallback. Self-contained HTML, no external scripts, CSP-safe.

## Acceptance criteria
- [ ] Renders in at least one Claude surface; graceful fallback elsewhere.

## Security notes
UI must escape all telemetry content (T6/T13).

## Docs to update
- Charts guide.

## Out of scope
- —
