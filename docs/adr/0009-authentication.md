# 0009 — Bearer tokens first, OAuth 2.1 next; Google, GitHub, Cloudflare Access

- Status: accepted (library choice verified in spike P0-08, 2026-10-01; real-client OAuth run pending)
- Date: 2026-10-01

## Context
- Claude Code / IDE clients support static `Authorization` headers.
- claude.ai web, Claude Desktop connectors and **Claude mobile** support OAuth (DCR or CIMD); static headers are a
  limited beta. The phone therefore needs OAuth.
- The owner already uses Google, GitHub and Cloudflare Access.

## Decision
1. **Phase 2:** per-device static **bearer tokens** (`rb_` prefix, 256-bit, checksum, hashed at rest).
2. **Phase 4:** **admin identity** via Google OIDC, GitHub OAuth, **Cloudflare Access** (validate `Cf-Access-Jwt-Assertion`
   against the team JWKS and AUD), and generic OIDC. An allowlist of emails, domains or GitHub orgs controls who may log in.
3. **Phase 5:** **OAuth 2.1 authorization server** for MCP clients, following spec 2026-07-28:
   - PRM (RFC 9728) per slug
   - resource indicators / audience (RFC 8707)
   - issuer (RFC 9207)
   - PKCE S256
   - **CIMD + DCR**
   - consent via the same IdPs
   On Workers this uses `@cloudflare/workers-oauth-provider`. On Node it uses the same library through a KV adapter,
   or `oidc-provider`, depending on spike P0-08.
- Cloudflare Access can also sit in front of `/admin` as an extra layer on Workers (documented, optional). It must
  **not** sit in front of `/p/*/mcp`, because MCP clients can't complete Access's browser login.

## Consequences
- Laptops work as soon as Phase 2/3 ships; the phone works from Phase 5.

## Spike P0-08 outcome (2026-10-01)

See `spikes/oauth/RESULTS.md` (29-check end-to-end suite passing on workerd and Node).

**Phase 5 implementation.** Use `@cloudflare/workers-oauth-provider` ≥ 1.2 on **both** runtimes, in a **single-origin**
topology:
- one `OAuthAuthorizationServer` (issuer = deployment origin) whose `resources` are the per-project URLs `…/p/{slug}/mcp`
- one `OAuthResourceServer` per project
- both built per request from the stored project list, cached in the isolate by project-list version

Requirements:
- Tokens are audience-bound to exactly one project (RFC 8707), and each project publishes its own RFC 9728 metadata.
- CIMD (preferred) and DCR (compatibility) are both enabled. PKCE is S256 only, and RFC 9207 `iss` is always sent.
- Our `validateToken` accepts relic-bridge static `rb_` tokens (P2-05) alongside OAuth tokens: one resource server, two
  credential types.

Node runs the library unmodified, with:
- a bundler alias for `cloudflare:workers`
- a KV-compatible table in SQLite (verified by a shared KV contract suite)
- CIMD enabled only together with a connect-time SSRF guard (undici `connect.lookup`); without that guard, Node falls back to DCR

`oidc-provider` is rejected: it would be a second implementation, and it has no CIMD support.

Consent and upstream sign-in reuse the provider's helpers (`beginConsent` / `approveConsent` / `isConsentRemembered`,
`beginUpstream` / `finishUpstream`).

**Free-plan note:** each MCP call costs 1 KV read, and each refresh costs 2 KV writes. Default access-token TTL is 8 h on `RB_PLAN=free`
and 1 h on paid, which keeps 4 devices × 2 projects at about 400 of the 1,000 free KV writes/day.
