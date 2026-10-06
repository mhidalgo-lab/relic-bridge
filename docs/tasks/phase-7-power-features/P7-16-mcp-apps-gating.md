---
id: P7-16
title: "MCP Apps: capability-gated UI metadata and an operator switch"
phase: 7
status: todo
priority: low
depends_on: [P7-04]
adr: []
owner: ""
---

# P7-16 — MCP Apps: capability-gated UI metadata and an operator switch

## Goal
P7-04 always advertises the chart UI (`_meta.ui` on the NRQL tools, the `ui://` resource) when `run_nrql` is
allowed; clients without MCP Apps ignore it. The spec suggests servers check the client's
`extensions["io.modelcontextprotocol/ui"].mimeTypes` first, and an operator may want the UI off entirely.

## Scope
- Find how the client's declared capabilities reach a per-request server on the stateless HTTP transport
  (ADR-0005, MCP 2026-07-28) and on stdio; when known, add `_meta.ui` and the UI resource only for clients that
  declare `text/html;profile=mcp-app`.
- `RB_MCP_APPS=on|off` (default on) for `serve`, stdio and the Worker, documented in the configuration guide.

## Acceptance criteria
- [ ] With the switch off, `tools/list` and `resources/list` show no UI fields or resource (tests on Node and Worker).
- [ ] Capability gating implemented where the capabilities are available, documented where they are not.

## Security notes
None beyond P7-04 (less surface when off).

## Docs to update
- `docs/guide/charts.md`, `docs/guide/configuration.md`.

## Out of scope
- New chart types.
