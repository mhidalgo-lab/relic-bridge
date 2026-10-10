---
id: P7-14
title: "Registry-friendly tool discovery (lazy auth)"
phase: 7
status: done
priority: low
depends_on: [P6-13]
adr: []
owner: claude-agent
---

# P7-14 — Registry-friendly tool discovery (lazy auth)

## Goal
Let MCP registries, inspectors and OAuth-first clients list tools before authenticating (prior-art: cloudbring/Smithery
learning), without weakening the access model: no data, no project existence oracle, no per-project access info.

## Scope
- **stdio "setup mode"**: `npx relic-bridge` with no configuration at all (no `NEW_RELIC_API_KEY`,
  `NEW_RELIC_ACCOUNT_ID`, `--config` / `RB_CONFIG`) starts anyway and lists the built-in read-only tools; every
  `tools/call` and `resources/read` answers a tool error with a clear setup message (`RB_AUTH_UNAUTHORIZED` + hint). A
  partial configuration (key without account, bad key, bad YAML) still fails startup as today.
- **Remote: opt-in public catalog** (`RB_PUBLIC_TOOL_CATALOG=on`, `publicToolCatalog` option; **off by default**):
  - `GET /.well-known/relic-bridge/tools.json`: the static catalog of the built-in read-only tool definitions (name,
    title, description, input schema, annotations), project-agnostic, the same for every caller.
  - On `/p/:slug/mcp`, a POST **without an `Authorization` header** whose body is `initialize`, `server/discover`,
    `notifications/initialized`, `ping` or `tools/list` is answered from that same static catalog, identically for
    every slug (known, unknown or malformed): no storage read, no token check. Anything else (`tools/call`,
    `resources/*`, `prompts/*`, `tasks/*`, `subscriptions/listen`, GET, DELETE, batches, unparsable bodies) gets the
    standard byte-identical 401 (with the `resource_metadata` challenge when OAuth is on). A request that carries an
    `Authorization` header always takes the normal authenticated path.
  - Rate limiting (`beforeAuth`, per IP) applies to the public requests as to any unauthenticated request.
- Node `serve` and the Worker both read `RB_PUBLIC_TOOL_CATALOG`.
- MCP Registry `server.json` (schema `2025-12-11`) for the npm package (stdio) and the OCI image; `mcpName` in
  `apps/cli/package.json` for namespace verification. A test keeps `server.json` in step with the package version and
  its environment variables. **Publishing is an owner decision** (not done here).

## Acceptance criteria
- [x] `npx relic-bridge` without env lists tools and returns a clear setup error on call (tools/call and
      resources/read); partial config still exits 1.
- [x] Remote endpoints still require auth by default (authz suite unchanged), and with the catalog off the well-known
      route is 404.
- [x] With `RB_PUBLIC_TOOL_CATALOG=on`: unauthenticated `initialize`/`tools/list` on `/p/<any>/mcp` answer the same
      bytes for a known slug, an unknown slug and a malformed slug; the list holds only static read-only tool
      definitions (no write tools, no project, grant or account data).
- [x] With the catalog on, unauthenticated `tools/call`, `resources/read`, `prompts/get`, `tasks/get`,
      `subscriptions/listen`, GET and DELETE answer the standard 401 (with `resource_metadata` when OAuth is on),
      identical for known and unknown slugs; authz matrix cases cover both hosts.
- [x] `server.json` validates against the registry schema constraints checked in a test (name pattern, description
      ≤ 100 characters, version matches the package, secret env vars flagged).
- [x] Docs: quickstart, self-hosting (`RB_PUBLIC_TOOL_CATALOG`), registry listing guide, THREAT_MODEL, RESEARCH.
- [ ] Publishing to the MCP Registry (owner decision; out of scope for the agent run).

## Security notes
T19/T20: the static catalog must not reveal project slugs or grants, and must not become a project-existence oracle.
The public answers depend on nothing but the request body and the deployment version. T23: setup mode never asks for a
key through a tool.

## Docs to update
- Quickstart, self-hosting, registry listing docs, THREAT_MODEL, RESEARCH.

## Out of scope
- Publishing to the MCP Registry, a `remotes` entry (each deployment has its own URL), MCP Server Cards (SEP-2127 is
  still a draft).
