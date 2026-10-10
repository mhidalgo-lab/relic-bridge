---
id: P5-02
title: "Per-slug Protected Resource Metadata and audience binding"
phase: 5
status: done
priority: high
depends_on: [P5-01]
adr: [0009, 0011]
owner: claude-agent
---

# P5-02 — Per-slug Protected Resource Metadata and audience binding

## Goal
MCP clients that start without a token (claude.ai web, Claude mobile, Desktop connectors) discover the authorization
server from a project's MCP endpoint alone, as the MCP spec 2026-07-28 requires (RFC 9728 Protected Resource
Metadata, `WWW-Authenticate` `resource_metadata`), and every OAuth token stays bound to exactly one project (RFC 8707).

## Scope
- `GET /.well-known/oauth-protected-resource/p/{slug}/mcp` (RFC 9728 §3.1 path insertion; the first URI the MCP spec
  tells clients to try): `resource` = `{issuer}/p/{slug}/mcp`, `authorization_servers` = `[issuer]`,
  `scopes_supported` = `["mcp:read"]` (no `offline_access`: spec §Refresh Tokens), `bearer_methods_supported` =
  `["header"]`. Built from the path only: answered alike for known, unknown and disabled projects (no slug probing,
  T19); an invalid slug is a 404. Only with the `oauth` option; same unauthenticated gate as the other OAuth routes.
  No root `/.well-known/oauth-protected-resource` (no resource lives at the root).
- `401` on `/p/{slug}/mcp` with OAuth on: `WWW-Authenticate: Bearer realm="relic-bridge",
  resource_metadata="…/p/{slug}/mcp", scope="mcp:read"` for **every** denial (device tokens included). The header is a
  function of the request path only, so all denials on one URL stay byte-identical and a known slug can't be told from
  an unknown one; no `error=` code (it would split missing from invalid tokens). An invalid slug, and OAuth off, keep
  the plain challenge.
- Authorization server metadata (RFC 8414): `issuer`, `code_challenge_methods_supported: ["S256"]`,
  `authorization_response_iss_parameter_supported: true` — already served by P5-01; tested here.
- RFC 8707 at the token endpoint: `grant_type=authorization_code` and `refresh_token` need exactly one `resource`,
  one of our per-slug resource URLs, checked before the code is consumed (a client that forgot it can retry); the
  provider then requires it to equal the grant's resource. Scheme and host compare case-insensitively at authorize and
  token (MCP spec "SHOULD accept uppercase scheme and host"); the path stays exact.
- Negative cases in the P2-12 authz matrix (OAuth suite, run on Node memory, Node SQLite and the Worker): cross-slug
  token reuse, token for a disabled project, missing / mismatched / repeated `resource` at authorize and token, OAuth
  token on the admin API.

## Acceptance criteria
- [x] PRM served per slug, identical shape for known / unknown / disabled projects, 404 for invalid slugs and with
      OAuth off; listed in the route guard.
- [x] 401 challenge carries `resource_metadata` and `scope`; every denial on one URL byte-identical (device and OAuth
      tokens); known vs unknown slug differ only in the path-derived URL.
- [x] Token endpoint: missing, foreign, repeated or other-slug `resource` refused (`invalid_target` / `invalid_request`);
      a missing resource does not burn the code.
- [x] Token for slug A → generic 401 on slug B; token for a disabled project → generic 401; OAuth token on the admin
      API → 401.
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:workers && pnpm build && pnpm bench:cpu` pass.

## Security notes
T2 (audience per slug), T19 (no project enumeration via PRM or the challenge).

## Docs to update
- `docs/dev/oauth.md`, `docs/THREAT_MODEL.md`, `docs/RESEARCH.md`, `docs/ARCHITECTURE.md` (if it describes the 401).

## Out of scope
- CORS on `/.well-known/*` and `/oauth/*` for browser-based clients (a P5-06 finding if one needs it).
- `403 insufficient_scope` step-up (no scope other than `mcp:read` exists until Phase 7 write tools).
