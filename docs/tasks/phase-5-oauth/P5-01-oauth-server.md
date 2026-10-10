---
id: P5-01
title: "OAuth 2.1 authorization server integration"
phase: 5
status: done
priority: high
depends_on: [P4-08]
adr: [0009, 0011]
owner: claude-agent
---

# P5-01 — OAuth 2.1 authorization server integration

## Goal
Mount `@cloudflare/workers-oauth-provider` (ADR-0009, spike P0-08) inside the shared HTTP app so the same
authorization server and the same MCP token check run on Node and on Workers, with OAuth access tokens going through
the deny-by-default access resolver exactly like `rb_` device tokens.

## Scope
- Pin `@cloudflare/workers-oauth-provider` (1.2.1, the spike's version). Node: bundler/test alias for
  `cloudflare:workers` (10-line shim), loaded lazily so stdio and token-only servers never import it.
- Provider state in the storage `kv` table on **both** runtimes (SQLite on Node, D1 on Workers) through a
  KV-namespace adapter under the `oauth:` key prefix — strongly consistent, covered by the existing KV contract suite
  (ADR-0011 records why D1 instead of Workers KV).
- Authorization codes are **single-use under concurrency**: a marker written at approval time is consumed with the
  atomic `kv.take` before the code reaches the provider; a replayed code is refused and its grant revoked.
- Per-request construction of the authorization server from the declared resources (`{issuer}/p/{slug}/mcp`),
  isolate-cached by resource set (configuration only, T21). Issuer = configured public URL, never the `Host` header.
- Routes (unauthenticated, per-IP rate limited under a new `oauth` scope, bounded bodies):
  `GET /.well-known/oauth-authorization-server` (RFC 8414), `GET /oauth/authorize`, `POST /oauth/token`
  (token + refresh + RFC 7009 revocation), `POST /oauth/register` (RFC 7591 DCR; hardening in P5-03).
- `/oauth/authorize`: `resource` required and must be one of our per-slug resource URLs; PKCE S256 required for
  every client; client and redirect URI validated by the provider (exact match) before any redirect; then a
  **consent seam** (`OAuthConsentHandler`) decides. P5-01 ships no consent UI: the handler is a constructor option
  (tests inject one); hosts expose no switch yet, so OAuth cannot be turned on in a deployment before P5-04.
- Approval (`api.approve({ userId, grantId })`) re-runs `resolveAccess` for that slug and refuses grants of another
  user, service grants, revoked/expired grants, disabled users and the owner-key boundary (an admin cannot use an
  owner's key) before any code is minted. Token props carry `grantId`, `projectSlug`, `userId`, `clientId`
  (encrypted by the provider); the provider `userId` is the opaque `usr_…` id (T25), grant metadata is empty.
- MCP route: an `rb_…` token takes the P2-05 path unchanged; any other bearer is validated by the provider for this
  slug's resource only (RFC 8707 audience), then props are cross-checked (slug, user, client) and the grant goes
  through `resolveAccess` (same cache, hooks, audit and denial shape as device tokens). Audit rows carry the OAuth
  `clientId`; rate limits key the device by the provider grant id.
- Same OAuth integration suite (ported from `spikes/oauth/scripts/e2e.ts`) on Node (http-app on memory storage, and
  the CLI's SQLite storage) and on Workers (`createWorker` on local D1 in workerd); OAuth routes added to the P2-12
  authorization matrix (route guard + OAuth MCP principals).

## Acceptance criteria
- [x] Same OAuth integration test suite passes on Node and Workers.
- [x] Code replay and concurrent redemption of one code yield at most one token set; replay revokes the grant.
- [x] PKCE `plain` / missing refused; unknown or missing `resource` refused; refresh cannot retarget; cross-slug
      OAuth token → the generic 401.
- [x] OAuth token for a revoked grant, disabled user, other user's grant or owner key used by an admin → 401 via
      `resolveAccess`; `rb_` tokens keep working with OAuth on.
- [x] OAuth routes in the P2-12 matrix (guard test) and OAuth principals on the MCP routes.
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:workers && pnpm build && pnpm bench:cpu` pass.

## Security notes
T9 (PKCE S256 only, exact redirect matching by the provider, RFC 9207 `iss`), T10 (per-IP limit on the unauthenticated
endpoints; DCR flood cap shared across isolates is P5-03), T12 (OAuth tokens never forwarded; NR keys stay
server-side), T15 (access cache capped at token expiry), T25 (opaque user ids, no grant metadata).

## Docs to update
- `docs/dev/oauth.md` (new), `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`, ADR-0011, `docs/RESEARCH.md`.

## Out of scope
- Protected Resource Metadata and the `WWW-Authenticate` `resource_metadata` challenge (P5-02).
- CIMD, DCR hardening (shared registration cap, admin disable, client list) (P5-03).
- Login + consent screen, `RB_OAUTH` host switches (P5-04).
- Plan-dependent TTL presets, refresh reuse detection, admin revoke per client (P5-05).
