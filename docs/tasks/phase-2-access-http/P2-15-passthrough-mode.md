---
id: P2-15
title: Pass-through mode (client-supplied New Relic key)
phase: 2
status: todo
priority: low
depends_on: [P2-06, P2-07]
adr: [0008]
owner: ""
---

# P2-15 — Pass-through mode (client-supplied New Relic key)

Split out of P2-06: it needs the rate limiter (P2-07), because a pass-through request is not tied to a grant.

## Scope
- `RB_PASSTHROUGH=true` (off by default, and proposed off by default on Workers): a separate route (e.g.
  `/passthrough/mcp`) where the client supplies `X-NewRelic-Api-Key` + region (`X-NewRelic-Region`) and the server
  stores nothing.
- The key is validated per request (or cached by hash only for a short TTL), wrapped in `Secret`, never logged,
  never echoed and never forwarded anywhere but NerdGraph (T12).
- Still rate-limited (per key hash and per IP), same security headers, Host/Origin checks and body limits as P2-06.
- Tool set: all read-only tools, default limits; accounts = the key's reachable accounts.

## Acceptance criteria
- [ ] Disabled by default (route answers 404); enabled tests over HTTP with an SDK client.
- [ ] Key never appears in logs (scan test); missing/invalid key → 401.
- [ ] Rate limits apply.

## Security notes
T8, T12, T20. Resolve the THREAT_MODEL open question on Workers defaults.

## Docs to update
- Self-hosting guide; THREAT_MODEL.

## Out of scope
- Storing pass-through keys.
