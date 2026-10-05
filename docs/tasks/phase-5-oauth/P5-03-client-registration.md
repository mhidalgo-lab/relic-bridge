---
id: P5-03
title: "Client registration: CIMD and DCR"
phase: 5
status: review
priority: high
depends_on: [P5-02]
adr: [0009, 0011, 0012]
owner: claude-agent
---

# P5-03 — Client registration: CIMD and DCR

## Goal
MCP clients can identify themselves to the authorization server without an operator registering them: Client ID
Metadata Documents (CIMD, the MCP 2026-07-28 preferred method, used by claude.ai, Claude mobile and Claude Code) and
Dynamic Client Registration (RFC 7591, deprecated but still used by many clients), both hardened against SSRF,
redirect-URI abuse and registration flooding.

## Scope
- **CIMD resolved by relic-bridge, not the provider** (ADR-0012): the provider's own CIMD stays off (it needs the
  Workers flag, follows redirects and caches in the Cache API). Off unless the host passes an SSRF-guarded fetcher
  (`oauth.clientMetadataDocuments.fetch`); then `client_id_metadata_document_supported: true` in the AS metadata.
  - `client_id` checks before any fetch: canonical `https://` URL (WHATWG `href` equals the string: no dot segments,
    no uppercase host, no default port), a path, no userinfo, fragment or port other than 443, a DNS name with a dot
    (no IP literal, no `localhost`, `.local`, `.internal`, `.arpa`, …), not the issuer's own host, ≤ 512 characters.
  - Fetch: GET, no redirects (3xx = failure), 5 s timeout, 200 only, JSON media type, ≤ 5 KiB (declared or streamed).
  - Document: JSON object, `client_id` equal to the URL (string comparison), `client_name` required (≤ 100
    characters, no control, bidi or zero-width characters), no `client_secret*`, `token_endpoint_auth_method` absent or
    `none` (no `private_key_jwt`, out of scope), `grant_types` / `response_types` within what we support.
  - Redirect URIs held to the document: kept only if `https` on the `client_id`'s own host or `http` on a loopback
    host (RFC 8252); no fragment, userinfo or `*`. A document with none left is refused.
  - Cache: the validated document is stored as the provider's client record (`oauth:client:<url>`) for the HTTP cache
    lifetime clamped to 5 min – 24 h (1 h without `Cache-Control`); errors are never cached. Resolved at
    `/oauth/authorize` and at `/oauth/token` (code, refresh, revocation) when no live record exists.
  - Fetch failures and invalid documents are a 400 `invalid_client` JSON page (never a redirect, never a 500).
  - Runtimes: Node — `apps/cli` connect-time guard (`node:https` with a `lookup` that rejects any non-public address,
    IP literals checked up front, so no DNS-rebinding window); Workers — `global_fetch_strictly_public` compatibility
    flag (own-zone requests via the front door; DNS can't be resolved in a Worker, private networks are not routable
    without a binding) plus `redirect: 'manual'`.
    Hosts wire the fetcher with the `RB_OAUTH` switch (P5-04); tests inject a mock.
- **DCR (compat)**, on by default (`oauth.registration`):
  - Policy checked before the provider stores anything: `redirect_uris` 1–10, each ≤ 2,000 characters, no `*`,
    fragment or userinfo; `https` on a non-IP host or a loopback IP, or `http` on loopback; private-use schemes may be
    listed (the provider never sends codes to them); optional allow-list of `https` redirect hosts
    (`oauth.registrationRedirectHosts`); `client_name` same rules as CIMD.
  - Registration cap shared across isolates and processes: a fixed-window counter in storage (`kv.increment`, atomic on
    memory, SQLite and D1), default 30 registrations per hour per deployment (`oauth.registrationLimit`); over it →
    `429` with `Retry-After`. Per-IP `oauth` rule unchanged.
  - Unused registrations expire: a new registration lives 24 h until its first token exchange, which renews it to the
    registration TTL (`max(90 d, 2 × refresh TTL)`, renewed at half-life by the provider).
- Consent seam: `OAuthAuthorizationRequest` gains `clientKind` (`metadata_document` | `dynamic`) and `clientHost`
  (the `client_id` host for CIMD) for P5-04's screen.

## Acceptance criteria
- [x] claude.ai (CIMD document on `claude.ai`, redirect `https://claude.ai/api/mcp/auth_callback`; and its DCR
      request) and Claude Code (CIMD `https://claude.ai/oauth/claude-code-client-metadata`, loopback redirect on any
      port) complete authorize → token → MCP call with mocked documents, on Node (memory, SQLite) and Workers (D1).
- [x] Malicious metadata refused with a 400: private-IP / foreign-host / fragment / wildcard redirects, oversized
      (declared and streamed) documents, wrong content type, `client_id` mismatch, redirects, timeouts, secrets, IP
      literal / loopback / non-canonical client ids; nothing is fetched for a refused `client_id`.
- [x] Node fetcher: loopback, private, link-local, CGNAT, ULA, IPv4-mapped and metadata addresses refused at connect
      time (every resolved address checked), redirects not followed, body and time bounded (unit tests, no network).
- [x] DCR: invalid redirect URIs refused; the shared cap returns 429 across app instances; unused registrations expire
      after 24 h, used ones are renewed.
- [x] CIMD off (no fetcher): URL client ids refused at authorize and token, metadata says unsupported.
- [x] `kv.increment` in the storage contract suite (memory, SQLite, D1).
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:workers && pnpm build && pnpm bench:cpu` pass.

## Security notes
T9 (redirect URIs held to the document / registration), T10 (registration cap shared across isolates, short-lived
unused registrations), T11 (SSRF: connect-time guard on Node, strictly-public fetch on Workers, no redirects, size and
time limits, no IP literals).

## Docs to update
- `docs/dev/oauth.md`, `docs/THREAT_MODEL.md`, `docs/RESEARCH.md`, ADR-0012, `docs/pending-decisions/phase-5.md`.

## Out of scope
- `private_key_jwt` clients (track upstream).
- Registered-client list and revoke in the admin UI/API, and a runtime (admin) switch for DCR → P5-08. Until then DCR
  is turned off with the `registration: false` option (the P5-04 host switch exposes it).
- Logo prefetching (`logo_uri` is not stored or shown).
