---
id: P5-02
title: "Per-slug Protected Resource Metadata and audience binding"
phase: 5
status: todo
priority: high
depends_on: [P5-01]
adr: [0009]
owner: ""
---

# P5-02 — Per-slug Protected Resource Metadata and audience binding

## Scope
- `/.well-known/oauth-protected-resource/p/{slug}/mcp` (RFC 9728) + `WWW-Authenticate: Bearer resource_metadata=…` on 401.
- Authorization server metadata (RFC 8414) with `issuer`, PKCE S256 only, `authorization_response_iss_parameter_supported`.
- RFC 8707: `resource` required; token audience = exact per-slug resource URL; reject mismatches.

## Acceptance criteria
- [ ] Negative tests: token for slug A at slug B → 401; missing resource → error.

## Security notes
T2.

## Docs to update
- OAuth architecture doc.

## Out of scope
- —
