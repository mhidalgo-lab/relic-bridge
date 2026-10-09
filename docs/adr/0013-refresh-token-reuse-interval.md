# 0013 — Refresh token reuse interval for concurrent refreshes

- Status: accepted (P5-09, 2026-10-05; owner confirmed 2026-10-09, 30 s default, re-check after the P5-06 checklist step 5);
  supersedes the "strict single use, no grace" part of the P5-05 token lifecycle design (ADR-0009/0011 unchanged)
- Date: 2026-10-05

## Context
P5-05 made refresh tokens strictly single use (RFC 9700 §4.14.2): any second presentation of a refresh token, including
two concurrent refreshes by the same client, revokes the whole device (every access and refresh token of the provider
grant) and the person must approve the app again.

P5-06 measured the official MCP TypeScript SDK client (`@modelcontextprotocol/client` 2.2.0) against the server: it does
**not** coalesce refreshes. Three tool calls started over an expired access token sent one refresh per failed request
with the same refresh token (six in the first measurement, counting the SDK's retry). Under strict rotation the first
wins, the rest are "reuse", and the device is revoked. Claude (web, Desktop, mobile: one hosted OAuth client) refreshes
proactively up to 5 minutes before expiry and on `401` (vendor docs), so overlapping refreshes are plausible for the
clients this project exists for; real-client behaviour is not yet measured (P5-06 manual checklist). A server that
disconnects a phone on ordinary concurrent use defeats Phase 5's goal.

Industry practice (RESEARCH §21): Okta's "grace period for token rotation" keeps the previous refresh token valid for
30 s by default (0-60 s); Auth0's "refresh token reuse interval" (up to 30 days) lets the previous token be exchanged
again without breach detection and issues a *new* rotating token each time; only the previous token, never an older
one. The same failure was reported for FastMCP's OAuth proxy under concurrent `/token` requests (PrefectHQ/fastmcp#4901). The OAuth provider library has its own unconditional variant (the previous token works
once more, minting a fresh pair) that P5-05 disabled because it is unbounded in time.

## Decision
- **Reuse interval, default 30 s (Okta's default), configurable** (`refreshReuseWindowSeconds` / `RB_OAUTH_REFRESH_REUSE_WINDOW`,
  0-120 s; `0` or `off` restores strict single use).
- **Idempotent replay, not a second rotation.** The `kv.take` marker still elects exactly one request to rotate a
  refresh token (atomic on SQLite and D1). Within the window, re-presenting that token returns the **same successor
  pair** that rotation produced: nothing new is minted, so one token never forks into parallel families.
- **Stored sealed, never in plain text.** After a successful rotation the token response is stored for the window
  only (`oauth-refresh-replay:<sha256(presented token)>`, expiry = window), sealed with AES-256-GCM under a key derived
  with HKDF-SHA-256 from the **presented refresh token itself**, AAD binding user, provider grant and token hash. Only
  a holder of that refresh token can open it; a copy of the database (token hashes only) can't. The master keyring was
  not used: the OAuth runtime has no keyring dependency, and a token-derived key is strictly narrower (it is how the
  provider protects grant props too).
- **Concurrent requests wait** (bounded, about 3 s of a few `kv` reads) for the rotation that holds the marker, then
  get the replay; if that rotation gave the token back (refused without rotating) one of them rotates instead.
- **Still reuse → family revocation + `oauth.token.reuse` audit:** after the window; an **older generation** (the
  successor was itself rotated since: a replay is valid only while the successor is the grant's current refresh
  token); another `client_id`, failed client authentication (public: `client_id`; confidential: the registered
  secret, checked as the provider does); another `resource` or `scope` parameter; a revoked device. The audit row says
  why (`details.replayRefused`).
- Replays are audited (`oauth.token.replay`, `status: ok`) and logged.

## Consequences
- The SDK client (and any client that refreshes in parallel or retries a lost refresh response within 30 s) keeps its
  device; the P5-06 conformance suite asserts this by default and the old revocation in strict mode.
- **Security cost (T9/T15):** for 30 s after each rotation, a stolen copy of the *previous* refresh token yields the
  *same* tokens the client just got — no new family, no extension of lifetime, and nothing once the client rotates
  again; after the window, reuse is detected exactly as before. For public clients (all MCP clients seen so far)
  "same client" is not a proof of possession (the `client_id` is public). A thief holding the *current* refresh token is
  unaffected by this decision (strict rotation never detected that case either until the client's next refresh).
- One extra `kv` row write per refresh (the sealed replay) and, for the losers of a race, a few reads while waiting.
- Reversible by configuration (`RB_OAUTH_REFRESH_REUSE_WINDOW=0`) without migration; rows expire on their own.
