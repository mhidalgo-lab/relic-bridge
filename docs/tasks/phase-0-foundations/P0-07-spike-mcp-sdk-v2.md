---
id: P0-07
title: "Spike: MCP SDK v2 dual-era handler on Workers and Node with real clients"
phase: 0
status: blocked
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
- [ ] Compatibility matrix table added to RESEARCH.md §4 "Measured".
- [x] Any client that fails has a documented workaround or an ADR-0005 amendment.
- [ ] Authless test deployment deleted after the spike.

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

## Blocker
Real-client matrix (Claude Desktop, claude.ai web, Claude mobile, Cursor, VS Code) needs the short-lived echo-only test
Worker in `spikes/mcp-sdk-v2/deploy-and-test.md`. Waiting for maintainer approval. This doesn't block Phase 1; if it's still
open at P0-11, it moves into P5-06.
