---
id: P2-06
title: HTTP app (Hono) with per-project MCP endpoints
phase: 2
status: done
priority: high
depends_on: [P2-05]
adr: [0004, 0005]
owner: claude-agent
---

# P2-06 — HTTP app (Hono) with per-project MCP endpoints

## Goal
Serve MCP over HTTP to remote devices: one endpoint per project, authenticated with the per-device tokens from P2-05,
built per request with only the tools the caller's grant allows. The app is web-standard (it runs on Workers in
Phase 3); the Node server entry is `relic-bridge serve`.

## Scope
- `packages/http-app` (web-standard only, no module state): `createHttpApp(options)` → a Hono app.
  - Routes: `POST|GET|DELETE /p/:slug/mcp` (SDK v2 `createMcpHandler(factory, { legacy: 'stateless' })`, one handler
    per app instance, a fresh `McpServer` per request through `authInfo.extra`), `GET /health` (`{"status":"ok"}`, no
    version, storage or config detail), `GET /version`. Everything else 404.
  - Middleware order: request id → security headers → Host/Origin validation (T24) → CORS (off by default) →
    body size limit → bearer auth + access resolution (isolate cache) → `beforeMcp` hook (rate limiting, P2-07) →
    MCP handler → `afterMcp` hook (audit, P2-08) and one structured access-log line.
  - **Auth** (request flow from P2-05): `bearerToken` → `verifyAccessToken` (its `touch` handed to `waitUntil`, or
    fire-and-forget with error logging on Node) → `resolveAccess({ slug, principal: { grantId } })` →
    `openCredential` per request. Every denial (missing/malformed header, bad checksum, unknown/revoked/expired token,
    unknown slug, token of another project, disabled project, any access deny reason) returns the **same 401** with
    `WWW-Authenticate: Bearer`. The token is verified before the slug is looked at, so slugs can't be probed without a
    valid token (T19). Storage errors → 503 (fail closed), never "allowed".
  - **Access cache**: per app instance, keyed by SHA-256(token) + slug, holding the resolved access and the credential
    *record* (ciphertext only; keys are decrypted per request, T21). TTL configurable 0-60 s (default 30 s, 0 disables),
    never past the token's or grant's expiry, bounded size.
  - Registered tools = `access.tools` only (raw-NRQL tools already removed when `rawNrql` is off); `ToolContext` per
    request with accounts/limits from the access, `connection` filled, a fresh budget, and a per-credential limiter pool.
  - **`subscriptions/listen`**: we have no server-initiated notifications, so the server advertises
    `tools.listChanged: false`; the SDK then acknowledges a listen with an empty filter and closes it gracefully at
    once (no held stream). Listen requests are flagged (`Mcp-Method` header) so the rate-limit hook can skip them.
  - `Mcp-Method` / `Mcp-Name` headers (sanitised, length-capped) used in logs and passed to the hooks.
  - Host and Origin validation with the SDK's `validateHostHeader` / `validateOriginHeader` against allowlists
    (default: localhost names). CORS: disabled by default; allowlist option.
  - Security headers on every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
    `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`,
    `Cache-Control: no-store`, `Cross-Origin-Resource-Policy: same-origin`; HSTS when the request arrived over TLS
    (or when forced for a TLS-terminating proxy).
  - Body limit (default 1 MiB) before auth reads anything; request timeout on the MCP exchange.
- `relic-bridge serve [--port] [--host] [--db]` (Node, `@hono/node-server`, `apps/cli`): defaults `127.0.0.1:8787`;
  default database in a per-user data directory (`RB_DATA_DIR`); opens/migrates SQLite, loads the master key
  (`loadKeyringFromEnv`), runs `verifyKeyChecks` at boot (refuses to start on a wrong key); a non-loopback `--host`
  requires an explicit `RB_ALLOWED_HOSTS`; Node server timeouts; graceful shutdown.
- Close review finding SR-4: `settings.setIfAbsent` in the storage interface (memory, SQLite, yaml read-only) +
  contract test, used by `verifyKeyChecks` to register key check values atomically.

## Acceptance criteria
- [x] Integration tests over HTTP with an SDK client (both protocol eras): allowed tools only listed; disallowed call
  rejected; token for another project → 401.
- [x] Negative authz tests for every route: missing token, malformed header, bad checksum, unknown/revoked/expired
  token, wrong/unknown slug, token for another project, disabled project; all 401 responses byte-identical.
- [x] Revocation takes effect within the cache TTL and immediately with TTL 0; cache never outlives token/grant expiry.
- [x] Security headers present (HSTS when TLS, `X-Content-Type-Options`, `Referrer-Policy`, CSP); Host/Origin
  rejection; CORS off by default; body limit → 413; `/health` leaks nothing.
- [x] `subscriptions/listen` is acknowledged and closed immediately.
- [x] No secret (NR key, token) in logs (scan test).
- [x] E2E: the built CLI `serve` on an ephemeral port, SQLite seeded with a project/grant/token, SDK Streamable HTTP
  client with the token, NerdGraph mocked.
- [x] `settings.setIfAbsent` contract test; `verifyKeyChecks` uses it.

## Security notes
T2, T3, T15, T19, T20, T21, T24. T12 is unchanged (client tokens never forwarded; pass-through mode moved to P2-15).

## Docs to update
- Self-hosting guide (serve section); THREAT_MODEL; ARCHITECTURE §5 if the flow changes; CLI help.

## Out of scope
- Admin routes (P2-09), OAuth (P5; resolving the slug before delegating to the OAuth provider happens there),
  rate limiting itself (P2-07: only the hook), audit writes (P2-08: only the hook).
- Pass-through mode (`RB_PASSTHROUGH`, client-supplied NR key) → **P2-15** (needs the rate limiter from P2-07).
