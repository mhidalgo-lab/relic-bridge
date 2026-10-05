---
id: P5-06
title: "Client compatibility matrix (incl. Claude mobile)"
phase: 5
status: in-progress
priority: high
depends_on: [P5-05]
adr: []
owner: claude-agent
---

# P5-06 — Client compatibility matrix (incl. Claude mobile)

## Goal
Say, per client and per OAuth/MCP behaviour, what is proven, what only the vendor documents and what is unknown, and
give the owner the exact manual steps for what cannot be proven without a real account (phone, claude.ai).

## Scope
- Note (P0-07/P0-08): claude.ai custom connectors weren't available on the maintainer's account in 2026-10. The agent
  that implemented this task has no access to any real client account either, so real-client cells stay open.
- **Automated conformance suite** (`client-conformance-suite.ts`, memory + SQLite + Worker/D1): the official MCP
  TypeScript SDK client (`@modelcontextprotocol/client` 2.2.0) acts as each client family — CIMD with an https callback
  (claude.ai, Desktop, mobile), CIMD with loopback (Claude Code), DCR with loopback or custom-scheme redirects (Cursor,
  VS Code, MCP Inspector), DCR with the claude.ai callback. Covers: 401 → PRM → AS metadata discovery, CIMD and DCR
  registration, PKCE S256, `resource` on authorize/token/refresh, `iss`, Streamable HTTP tool call, automatic refresh
  after expiry with rotation, parallel refresh behaviour, RFC 7009 revocation, behaviour once the device is gone,
  audience binding, the scopes claude.ai is documented to send.
- **Research** each client's documented behaviour from current official docs and record it with sources and dates.
- `docs/reference/client-compatibility.md`: the matrix (each cell: verified by automated conformance test / documented
  by vendor, unverified / unknown), versions and dates, the re-run procedure per minor release.
- The owner's manual verification checklist (phone + claude.ai) goes in `docs/pending-decisions/phase-5.md`.
- Real bugs or incompatibilities found become fixes with regression tests, or a new task / pending decision when the
  fix is a trade-off.

## Acceptance criteria
- [ ] `docs/reference/client-compatibility.md` with versions/dates.
- [ ] Conformance suite green on memory, SQLite and the Worker (local D1).
- [ ] Matrix cells for Claude mobile and claude.ai web verified against a real account (**owner**, see pending
      decisions; not possible in an autonomous run).
- [ ] Claude Desktop, Cursor, VS Code, MCP Inspector verified against the real app (**owner / community**).

## Security notes
none.

## Docs to update
- Client compatibility page, `docs/dev/oauth.md` (tests), pending decisions.

## Out of scope
- Changing refresh-reuse policy (pending decision; see new task P5-09).
