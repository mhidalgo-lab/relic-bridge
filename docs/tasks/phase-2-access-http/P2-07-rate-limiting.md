---
id: P2-07
title: Rate limiting (pluggable)
phase: 2
status: in-progress
priority: high
depends_on: [P2-06]
adr: [0010]
owner: claude-agent
---

# P2-07 — Rate limiting (pluggable)

## Goal
Throttle brute-force attempts and runaway agents on the HTTP server without leaking whether a token is valid, behind
an interface that Workers (P3-04) and a Durable Object limiter (P7-10) can implement.

## Scope
- `packages/http-app` (web-standard, no module state):
  - `RateLimiter` interface: `take(key, rule, cost?)` (consume tokens if available) and `peek(key, rule)` (would a
    take succeed, without consuming), both returning `{ allowed, retryAfterMs, remaining }`. A rule is
    `{ requests, perSeconds }`; token bucket (capacity `requests`, refill `requests / perSeconds`).
  - `MemoryRateLimiter` (Node, single process): bounded (`maxKeys`), idle (fully refilled) buckets are dropped
    first, then the least recently used; injectable clock.
  - `createRateLimitHooks(options)` → `HttpAppHooks`: pre-auth per-IP request limit; per-IP **auth-failure** limit
    (stricter): checked with `peek` before authentication and charged in `onAuthFailure`; post-auth per-token and
    per-grant limits in `beforeMcp` (grant default overridden by the grant's own `rateLimit`; `subscriptions/listen`
    is not counted). `mergeHooks(...)` composes hook sets (P2-08 audit will need it).
  - 429 answers: JSON-RPC style error body telling the agent to slow down, `Retry-After` (whole seconds, >= 1).
  - Client IP is supplied by the host (`getClientIp`); IPv6 is bucketed by /64. `resolveClientIp` implements
    trusted-proxy handling by hop count from the right of `X-Forwarded-For`; default is to trust no proxy.
  - Limiter failures fail open (logged); the authentication and access checks remain.
- `relic-bridge serve`: in-memory limiters wired in by default, client IP from the socket (`getConnInfo`), settings
  `RB_RATE_LIMIT` (`off` disables all), `RB_RATE_LIMIT_IP`, `RB_RATE_LIMIT_AUTH_FAIL`, `RB_RATE_LIMIT_TOKEN`,
  `RB_RATE_LIMIT_GRANT` (each `<requests>/<seconds>` or `off`), `RB_TRUSTED_PROXY_HOPS`.
- Defaults (personal use; one MCP request is at most a handful of NerdGraph calls, against NRQL 3,000/min/account):
  IP 600/min, auth failures 10 per 5 min per IP, token 120/min, grant 300/min.
- P2-15 (pass-through) reuses the limiter with its own keys (`key:<hash>`, `ip:`); nothing here is grant-specific.

## Acceptance criteria
- [ ] Token-bucket tests: burst, refill, retry-after, cost, peek, rule change, clock jumps, bounded memory and
      eviction (idle first, LRU), key isolation.
- [ ] Auth-failure throttling: after N failures an IP is refused (429) for valid and invalid tokens alike; other IPs
      unaffected; recovers after the refill; X-Forwarded-For is ignored unless trusted proxies are configured.
- [ ] Per-token and per-grant limits over HTTP with an SDK client; the grant's `rateLimit` overrides the default;
      listen requests are not counted; 429 has `Retry-After`.
- [ ] Negative tests: the 429 for an IP does not depend on token validity; no secret in 429 bodies/logs.
- [ ] `serve` settings parsing and an end-to-end throttle through Node.

## Security notes
T1, T5, T20. Single-process limits only: with several replicas each has its own buckets (P7-10).

## Docs to update
- Self-hosting guide (configuration reference), THREAT_MODEL, ARCHITECTURE request flow if it names rate limits.

## Out of scope
- Global distributed limiter (P7-10); Workers implementation (P3-04); per-credential/per-account limiter shared
  across projects (P7-10).
