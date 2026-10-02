---
id: P0-08
title: "Spike: OAuth 2.1 server on Workers and Node, per-slug resources"
phase: 0
status: blocked
priority: high
depends_on: [P0-07]
adr: [0009]
owner: "claude-agent"
---

# P0-08 — Spike: OAuth 2.1 server on Workers and Node, per-slug resources

## Goal
Decide the OAuth implementation path before the access model is built, so tokens, audiences and storage aren't redesigned later.

## Scope
- `@cloudflare/workers-oauth-provider` on Workers with:
  - two project slugs; PRM at `/.well-known/oauth-protected-resource/p/{slug}/mcp` (RFC 9728 path form)
  - resource/audience binding: token for slug A **rejected** at slug B
  - DCR and CIMD client registration; PKCE; issuer in auth response (RFC 9207)
  - a fake consent page (no real IdP yet)
- Connect **claude.ai web**, **Claude mobile** and **Claude Code** through OAuth end to end.
- Node portability: try running the same library on Node with a KV-compatible adapter over SQLite (`get/put/delete/list` + TTL). If blocked, prototype `oidc-provider` behind the same interface and compare effort.

## Acceptance criteria
- [x] Decision written to ADR-0009 (library per runtime, KV adapter yes/no).
- [x] Per-slug audience isolation demonstrated with a negative test.
- [ ] Notes on which clients use DCR vs CIMD added to RESEARCH.md §3.

## Security notes
T2, T9, T10, T11. Spike deployment protected or deleted after use.

## Docs to update
- ADR-0009, RESEARCH.md.

## Out of scope
- Real IdP integration (P4-01), production consent UI (P5-04).

## Progress notes
- 2026-10-01: 29-check OAuth e2e suite passes on workerd and Node; CIMD tested with Claude Code's public metadata document;
  ADR-0009 updated (`spikes/oauth/RESULTS.md`).

## Blocker
Real OAuth run with claude.ai web, Claude mobile and Claude Code needs the protected test Worker in
`spikes/oauth/deploy-and-test.md`. Waiting for maintainer approval. Then fill in "Real-client results" and the DCR/CIMD notes in RESEARCH §3.
