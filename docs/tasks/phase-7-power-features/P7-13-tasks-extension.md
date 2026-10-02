---
id: P7-13
title: "Async tool runs via MCP Tasks extension"
phase: 7
status: todo
priority: low
depends_on: [P6-13]
adr: []
owner: ""
---

# P7-13 — Async tool runs via MCP Tasks extension

## Scope
- Expose long NRQL and composite reports as MCP Tasks where clients support it (fallback: `queryId` handles).

## Acceptance criteria
- [ ] Works with at least one client; fallback unchanged.

## Security notes
Task ids bound to grant.

## Docs to update
- Tool reference.

## Out of scope
- —
