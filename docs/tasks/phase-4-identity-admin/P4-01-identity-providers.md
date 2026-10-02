---
id: P4-01
title: "Identity providers: Google, GitHub, Cloudflare Access, generic OIDC"
phase: 4
status: todo
priority: high
depends_on: [P3-07]
adr: [0009]
owner: ""
---

# P4-01 — Identity providers: Google, GitHub, Cloudflare Access, generic OIDC

## Scope
- `IdentityProvider` interface → `{ idp, subject, email, emailVerified, orgs? }`.
- Google OIDC (PKCE, nonce, `hd` hint), GitHub OAuth (verified primary email, optional org membership), **Cloudflare Access** (validate `Cf-Access-Jwt-Assertion`: team JWKS, `aud`, `iss`, `exp`), generic OIDC (discovery).
- Login allowlist: emails, domains, GitHub orgs; first-owner bootstrap via single-use, expiring setup link (replaces `RB_ADMIN_TOKEN` for UI).
- Pure WebCrypto JWT verification (e.g. `jose`), JWKS caching.

## Acceptance criteria
- [ ] Tests with mocked IdPs incl. wrong `aud`, expired, unverified email, not in allowlist.
- [ ] Works on Node (localhost redirect) and Workers.

## Security notes
T14. State + nonce + PKCE everywhere.

## Docs to update
- `docs/guide/identity-providers.md` (how to create Google/GitHub OAuth apps, CF Access app).

## Out of scope
- MCP-client OAuth (P5).
