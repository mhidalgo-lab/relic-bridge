---
id: P5-03
title: "Client registration: CIMD and DCR"
phase: 5
status: todo
priority: high
depends_on: [P5-02]
adr: [0009]
owner: ""
---

# P5-03 — Client registration: CIMD and DCR

## Scope
- CIMD fetch failures render a 400, not a 500 (P0-08). On Node, CIMD needs the connect-time SSRF guard, otherwise it's disabled.
- CIMD (preferred): fetch & validate client metadata documents (HTTPS only, size/time limits, SSRF block-list, cache); redirect URIs held to the document.
- DCR (compat): enabled by default for client compatibility (claude.ai), rate-limited, unapproved until first consent; admin can disable DCR.
- Client list in admin with revoke.

## Acceptance criteria
- [ ] claude.ai and Claude Code register successfully; malicious metadata (private IP redirect, oversized doc) rejected.

## Security notes
T10, T11.

## Docs to update
- OAuth guide.

## Out of scope
- `private_key_jwt` clients (track upstream).
