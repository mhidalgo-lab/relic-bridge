---
id: P7-14
title: "Registry-friendly tool discovery (lazy auth)"
phase: 7
status: todo
priority: low
depends_on: [P6-13]
adr: []
owner: ""
---

# P7-14 — Registry-friendly tool discovery (lazy auth)

## Goal
Let MCP registries and OAuth-first clients list tools before authenticating (prior-art: cloudbring/Smithery learning).

## Scope
- Decide (and document) behaviour of tool listing without credentials: stdio mode can list the full catalogue without a key
  (credential checked on first call); remote mode keeps `/p/:slug/mcp` authenticated, but publishes a static catalogue
  (`/.well-known/relic-bridge/tools.json` or registry `server.json`) generated from the registry.
- MCP Registry `server.json` metadata.

## Acceptance criteria
- [ ] `npx relic-bridge` without env lists tools and returns a clear setup error on call.
- [ ] Remote endpoints still require auth (authz suite unchanged).

## Security notes
T19/T20: the static catalogue must not reveal project slugs or grants.

## Docs to update
- Quickstart, registry listing docs.

## Out of scope
- —
