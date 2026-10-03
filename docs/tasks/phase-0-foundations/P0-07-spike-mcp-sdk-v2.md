---
id: P0-07
title: "Spike: MCP SDK v2 dual-era handler on Workers and Node with real clients"
phase: 0
status: done
priority: high
depends_on: [P0-01]
adr: [0005]
owner: "claude-agent"
---

# P0-07 — Spike: MCP SDK v2 dual-era handler on Workers and Node with real clients

## Goal
Prove one Hono app with `createMcpHandler(factory, { legacy: 'stateless' })` serves both protocol eras on **both runtimes**, and that the real clients we care about connect.

## Scope
- Minimal Hono app, route `/p/:slug/mcp`, one `echo` tool and one tool with `structuredContent` + output schema.
- Run on `wrangler dev`, a deployed free Worker, and `@hono/node-server`. Also `serveStdio` variant.
- Client matrix (record version + result): **Claude Code** (http + `--header`, and stdio), **Claude Desktop**, **claude.ai web connector** and **Claude mobile** (authless test URL only, short-lived), MCP Inspector, Cursor, VS Code (Copilot agent mode).
- Check: tool listing per request (factory filters tools by a fake grant), error mapping, JSON Schema 2020-12 inputs, `annotations` (`readOnlyHint`).

## Acceptance criteria
- [x] Compatibility matrix table added to RESEARCH.md §4 "Measured".
- [x] Any client that fails has a documented workaround or an ADR-0005 amendment.
- [x] Authless test deployment deleted after the spike.

## Security notes
The authless test Worker must expose only the `echo` tool and be deleted afterwards (T20).

## Docs to update
- RESEARCH.md, ADR-0005.

## Out of scope
- Auth (P0-08).

## Progress notes
- 2026-10-01: Node, workerd and stdio work for both protocol eras; Inspector CLI works; ADR-0005 amended
  (`spikes/mcp-sdk-v2/RESULTS.md`).

- 2026-10-02: echo Worker deployed (`relic-bridge-spike-echo`). Inspector CLI and Claude Code 2.1.287 (http, http+header,
  stdio) verified; remaining clients need the maintainer (see Blocker).
- 2026-10-03: GitHub Copilot Desktop verified by the maintainer. claude.ai / Desktop connectors / mobile can't be tested
  (custom connectors unavailable on the account), so that check moves to P5-06. Echo Worker deleted.
