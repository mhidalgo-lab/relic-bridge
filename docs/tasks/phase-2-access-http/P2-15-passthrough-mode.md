---
id: P2-15
title: Pass-through mode (client-supplied New Relic key)
phase: 2
status: in-progress
priority: low
depends_on: [P2-06, P2-07]
adr: [0008]
owner: claude-agent
---

# P2-15 — Pass-through mode (client-supplied New Relic key)

Split out of P2-06: it needs the rate limiter (P2-07), because a pass-through request is not tied to a grant.

Pass-through (ARCHITECTURE §3, mode E) is for a shared instance that stores no New Relic keys: each request carries
the caller's own User key in a header, the server uses it for that request only and forgets it. It is not an MCP
tool and never a tool argument (T23); there is no project, grant or access token on this route.

## Scope
- `createHttpApp({ passthrough: { … } })` registers `GET|POST|DELETE /passthrough/mcp`; without the option the route
  does not exist (404). `relic-bridge serve` turns it on with `RB_PASSTHROUGH=on` (default off). Workers (Phase 3):
  off by default too (resolves the THREAT_MODEL open question).
- Headers: `X-NewRelic-Api-Key` (a User key, `NRAK-…`), `X-NewRelic-Region` (`US` default, `EU`, `JP`; anything
  else → 400). The key is wrapped in `Secret` at once, never logged, echoed, audited or stored, and only sent to
  NerdGraph (T12). `Authorization` is ignored on this route (a relic-bridge token is never forwarded anywhere).
- Plain HTTP refused (`403 tls_required`) unless the request is https, `hsts: true` (TLS-terminating proxy) or the
  `Host` is loopback, so a misconfigured deployment fails loudly instead of collecting keys in clear text.
- Key validation: one NerdGraph `actor` query gives the key's reachable accounts; the result (accounts only) is cached
  for a short TTL (default 60 s, 0-300 s) under an HMAC-SHA-256 fingerprint of region + key with a per-app random
  secret (non-reversible, not linkable across processes). Missing/malformed/refused key, or a key that reaches no
  account → the route's single `401` (`WWW-Authenticate: NewRelic-Api-Key`), reason in log and `onAuthFailure` (so
  the per-IP auth-failure throttle and the audit `auth.denied` row apply). New Relic unreachable → `503`.
- Same pipeline as `/p/:slug/mcp`: security headers, Host/Origin checks, CORS (when configured, with the two headers
  allowed), declared and streamed body limits, the method/tool name from the body, batches refused, one deadline.
- Rate limits: per-IP and auth-failure limits (`beforeAuth` / `onAuthFailure`) as on every route, plus a per-key
  limit (`key:<fingerprint>`, default 120/60 s, `RB_RATE_LIMIT_PASSTHROUGH_KEY`) in a new `beforePassthrough` hook.
- Tools: every built-in `read` tool, default limits (`DEFAULT_LIMITS`, overridable); accounts = the key's reachable
  accounts, default = the lowest id. Tool caches are keyed by credential id `pt_<fingerprint>`, so they are isolated per
  key; concurrency is bounded per request (no per-key state kept beyond the identity cache and the rate limiter).
- Logs: one access-log line per request with `keyId` (a 12-hex prefix of the fingerprint) and region.

## Acceptance criteria
- [ ] Disabled by default (route answers 404); enabled tests over HTTP with an SDK client (both protocol eras).
- [ ] Key never appears in logs, responses or audit rows (scan test); missing/malformed/invalid key → 401.
- [ ] Rate limits apply (per key and per IP; failed keys charge the per-IP failure throttle).
- [ ] Plain HTTP to a non-loopback host refused; caches isolated per key (two keys interleaved never share data).
- [ ] The P2-12 authorization matrix lists the new routes (guard test) with their denials and a positive control.
- [ ] `serve`: `RB_PASSTHROUGH`, `RB_PASSTHROUGH_IDENTITY_TTL`, `RB_RATE_LIMIT_PASSTHROUGH_KEY`, with a start-up warning.

## Security notes
T8, T12, T20, T23. Resolve the THREAT_MODEL open question on Workers defaults.

## Docs to update
- Self-hosting guide; THREAT_MODEL; ARCHITECTURE (mode E).

## Out of scope
- Storing pass-through keys.
- Audit rows for pass-through tool calls (refusals are audited) → P2-16.
- Choosing the default account per request (a header) — tools take an `account` argument.
