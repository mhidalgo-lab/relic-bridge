---
id: P4-01
title: "Identity providers: Google, GitHub, Cloudflare Access, generic OIDC"
phase: 4
status: in-progress
priority: high
depends_on: [P3-07]
adr: [0009]
owner: "claude-agent"
---

# P4-01 — Identity providers: Google, GitHub, Cloudflare Access, generic OIDC

Admin identity for the admin panel (ADR-0009 step 2). This task ends at a **verified, allowlisted user record**;
turning that into a browser session (cookie, CSRF, roles) is P4-02, which plugs into the `onLogin` seam defined here.

## Scope
- `packages/auth/src/identity` (web-standard only, ADR-0004):
  - `IdentityProvider` interface → `VerifiedIdentity { idp, subject, email, emailVerified: true, displayName, orgs? }`.
    Two kinds: **redirect** providers (authorization code + PKCE S256 + `state`; OIDC ones also `nonce`) and the
    **header** provider (Cloudflare Access).
  - ID-token / Access-JWT verification with `jose` (WebCrypto): exact `iss`, `aud` (and `azp` when several
    audiences), `exp`/`iat`/`nbf` with 60 s skew, `nonce`, asymmetric algorithm allowlist (never `none` / `HS*`),
    JWKS cached per provider instance with refetch-on-unknown-`kid` (rotation) and a cooldown.
  - **Generic OIDC** via discovery (`/.well-known/openid-configuration`): metadata `issuer` must equal the configured
    issuer exactly; endpoints must be https (http only for loopback issuers); RFC 9207 `iss` callback parameter
    checked when present (required when the IdP advertises it); `email_verified === true` required.
  - **Google**: OIDC preset (`https://accounts.google.com`, both documented `iss` forms), optional hosted-domain
    restriction (`hd` request hint **and** `hd` claim check).
  - **GitHub**: OAuth app, PKCE S256 + `state`, subject = numeric user id, email = **primary and verified** address
    from `GET /user/emails`, optional org restriction via `GET /user/memberships/orgs/{org}` (`state: active`).
  - **Cloudflare Access**: validate `Cf-Access-Jwt-Assertion` against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`,
    `iss` = team domain, `aud` contains the application AUD tag, RS256, `exp`; service-token JWTs (no email) refused.
  - Outbound IdP calls: injected `fetch`, timeout, `redirect: 'manual'`, response-size cap, JSON only.
- **Login transactions** in storage, never isolate memory: `kv` row keyed by the SHA-256 of `state`, 10 min TTL,
  consumed **atomically once** (new `kv.take`, all adapters + contract suite), bound to the browser by a
  `__Host-rb_login` cookie (plain `rb_login` on http loopback) whose hash is stored in the transaction.
- **User mapping** (`resolveLoginUser`): match by (idp, subject), else by email (binds an unbound user; a user bound to
  another subject or IdP is a conflict, denied). Disabled users denied. Unknown identities: **deny by default**; allowed
  only when they match the allowlist (emails, domains, GitHub orgs) **and** auto-provisioning is on
  (`member` or `admin`, never `owner`).
- **First-owner bootstrap**: `POST /api/admin/v1/setup-links` (admin token) issues a single-use, expiring setup link
  (hash in `kv`); a login that carries it makes that identity `owner`, bypassing the allowlist but not verification.
- HTTP routes (mounted only when identity is configured): `GET /auth/login` (provider chooser),
  `GET /auth/login/:provider`, `GET /auth/callback/:provider`, `GET /auth/cf-access`. Exact redirect URI
  `${RB_PUBLIC_URL}/auth/callback/<provider>`; `next` limited to same-origin relative paths.
  Every outcome audited (`auth` / `login.ok`, `login.denied` with a stable reason); one generic failure answer.
- Configuration from `RB_*` variables shared by `serve` and the Worker (`identitySettingsFromEnv`).
- P2-12 authorization matrix: the new routes (Node and Worker hosts).

## Acceptance criteria
- [ ] Mock-IdP tests (self-generated JWKS, no network): wrong `aud`, wrong `iss`, expired, `alg: none`, HS256 key
      confusion, unknown `kid` → JWKS refetch (rotation), wrong `nonce`, unverified email, not in allowlist, GitHub
      unverified primary email and org membership, Google `hd` mismatch, CF Access wrong AUD / expired / missing header.
- [ ] State replay, missing/foreign binding cookie, provider mix-up (state of provider A at callback B) and RFC 9207
      `iss` mismatch are refused; `next` cannot redirect off-origin.
- [ ] Setup link: single use, expires, makes the identity `owner`.
- [ ] `kv.take` in the storage contract suite (memory, SQLite, D1).
- [ ] Works on Node (localhost redirect, `serve` with a local mock IdP) and Workers (workerd tests).
- [ ] New routes in the P2-12 matrix (guard test passes on both hosts).
- [ ] Real Google / GitHub / Cloudflare Access apps exercised end to end (owner, see pending decisions).

## Security notes
T14 (and T13 for the login cookie). State + nonce + PKCE everywhere; deny by default.

## Docs to update
- `docs/guide/identity-providers.md` (how to create Google/GitHub OAuth apps, CF Access app).
- `docs/guide/configuration.md`, `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`, `docs/RESEARCH.md`, admin API reference.

## Out of scope
- Sessions, CSRF, roles enforcement in the admin API (P4-02); the admin UI (P4-03+).
- MCP-client OAuth (P5).
