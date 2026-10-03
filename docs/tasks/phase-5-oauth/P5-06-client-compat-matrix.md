---
id: P5-06
title: "Client compatibility matrix (incl. Claude mobile)"
phase: 5
status: todo
priority: high
depends_on: [P5-05]
adr: []
owner: ""
---

# P5-06 — Client compatibility matrix (incl. Claude mobile)

## Scope
- Note (P0-07/P0-08): claude.ai custom connectors weren't available on the maintainer's account in 2026-10. Find a tester
  or account where they are, or document as community-verified.
- Verify and document: Claude Code (OAuth + header), Claude Desktop, **claude.ai web**, **Claude mobile (iOS/Android)**, MCP Inspector, Cursor, VS Code, others discovered.
- Automated where possible (Inspector CLI); manual checklist for the rest, re-run each minor release.

## Acceptance criteria
- [ ] `docs/reference/client-compatibility.md` with versions/dates.

## Security notes
none.

## Docs to update
- Client compatibility page.

## Out of scope
- —
