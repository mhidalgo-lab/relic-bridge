---
id: P2-06
title: HTTP app (Hono) with per-project MCP endpoints
phase: 2
status: todo
priority: high
depends_on: [P2-05]
adr: [0004, 0005]
owner: ""
---

# P2-06 — HTTP app (Hono) with per-project MCP endpoints

## Scope
- Routes: `POST|GET /p/:slug/mcp` (SDK v2 `createMcpHandler`, dual era), `GET /health`, `GET /version`.
- Middleware order: request id → security headers → body size limit → auth (bearer) → access resolution (isolate cache, TTL ≤ 60 s, configurable) → rate limit → MCP handler (server factory with only allowed tools) → audit.
- Unknown slug and bad token return the **same** 401 challenge (no enumeration). `http-app` resolves the slug before delegating to the OAuth provider (P0-08).
- Use the SDK's `validateHostHeader` / `validateOriginHeader` helpers for T24.
- Handle `subscriptions/listen` (opened by Claude Code 2.1.287 and held open) deliberately: we have no server-initiated
  notifications yet, so decide between closing it immediately or holding it with a capped duration. Either way, never block
  isolate resources or count it against rate limits like a tool call.
- CORS: disabled by default; allowlist option. `Host` + `Origin` validation against an allowlist (DNS-rebinding protection for local `serve`) (T24).
- `Mcp-Method`/`Mcp-Name` headers used for logging/rate-limit keys where present.
- Optional **pass-through mode** (`RB_PASSTHROUGH=true`, off by default): client supplies `X-NewRelic-Api-Key` + region; nothing stored; still rate-limited.
- `relic-bridge serve --port --host` (Node, `@hono/node-server`), defaults to `127.0.0.1`.

## Acceptance criteria
- [ ] Integration tests over HTTP with an SDK client: allowed tools only listed; disallowed call rejected; token for another project → 401.
- [ ] Security headers present (HSTS when TLS, `X-Content-Type-Options`, `Referrer-Policy`, CSP on HTML routes).

## Security notes
T2, T3, T12, T15, T19, T20.

## Docs to update
- Self-hosting guide; THREAT_MODEL.

## Out of scope
- Admin routes (P2-09), OAuth (P5).
