---
id: P7-16
title: "MCP Apps: capability-gated UI metadata and an operator switch"
phase: 7
status: done
priority: low
depends_on: [P7-04]
adr: []
owner: claude-agent
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
- [x] With the switch off, `tools/list` and `resources/list` show no UI fields or resource (tests on Node and Worker).
- [x] Capability gating implemented where the capabilities are available, documented where they are not.

## Result
- `buildMcpServer({ mcpApps })` (default true). Off: the app resource is not registered, so no tool links to it.
  On: capabilities are read per request (`server.getClientCapabilities()`; the SDK fills it from the 2026-07-28
  envelope, or from `initialize` on stdio) and the tool `_meta` / resource `enabled` flags are getters, because the SDK's
  `tools/list` and `resources/list` handlers get no request context. `clientAppsSupport()` answers yes / no / unknown;
  only `no` hides. A stateless 2025-era HTTP request has no capabilities (`unknown`) and still gets the view.
- `RB_MCP_APPS` in `serve`, stdio (including setup mode) and the Worker; invalid values stop startup.

## Security notes
None beyond P7-04 (less surface when off).

## Docs to update
- `docs/guide/charts.md`, `docs/guide/configuration.md`.

## Out of scope
- New chart types.
