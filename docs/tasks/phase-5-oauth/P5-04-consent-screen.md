---
id: P5-04
title: "Login and consent screen"
phase: 5
status: done
priority: high
depends_on: [P5-03]
adr: [0009, 0011, 0012]
owner: claude-agent
---

# P5-04 — Login and consent screen

## Goal
A person using claude.ai (web or phone), Claude Code or another MCP client can connect it to one of their projects
with OAuth: sign in with the instance's identity provider, see which app is asking and where it sends the answer,
choose which of their own grants on the project it gets, and approve or deny. Operators turn it on with one switch.

## Scope
- **Host switch** `RB_OAUTH=on` (off by default) on Node (`relic-bridge serve`) and Workers; needs sign-in
  (`RB_PUBLIC_URL` + a provider), refused at boot otherwise. Wires the CIMD fetchers (Node `createCimdFetch()`,
  Workers `strictlyPublicCimdFetch()`, CIMD off with a warning without the flag) and exposes the P5-03 DCR settings:
  `RB_OAUTH_DCR` (on/off), `RB_OAUTH_DCR_LIMIT` (registrations per hour or `off`), `RB_OAUTH_DCR_REDIRECT_HOSTS`.
  One shared parser (`oauthSettingsFromEnv`, web-standard) for both hosts.
- **Built-in consent handler** (`oauth.consent` becomes optional; tests may still inject a stand-in):
  - `GET /oauth/authorize` (validated by P5-01..03): no session → `303 /auth/login?next=/oauth/authorize?…`
    (same-origin `next`, its cap raised from 512 to 2048 characters; longer authorize URLs are refused with a 400 page).
    The consent request is re-validated from the query on every step (stateless: no pending state is stored).
  - Signed in: the consent page, built from the validated request, never from client input other than escaped text:
    client name (untrusted, escaped; "Unnamed app" when absent), **client host** for CIMD clients ("identified by
    `claude.ai`") or "not verified" for DCR clients, **redirect host** prominent, a warning when the redirect is a
    loopback address ("an app on this computer"), the project (bound to the `resource` slug), and the user's **own**
    grants on that project that resolve (each with its tools and accounts from the effective access); none → a page
    that explains it and still offers Deny. Device label field (stored as the provider grant's label, for P5-05's
    device list). "Remember" checkbox (off by default).
  - `POST /oauth/consent?…` (the same query): session, `Origin`/fetch metadata, urlencoded ≤ 16 KiB, `_csrf` (exactly
    one), then the request is re-validated; Approve needs a grant id from the user's own usable list (a forged id is
    refused before `approve()`, which re-checks with `resolveAccess`: other users' grants, service grants, the owner-key
    boundary, revoked/expired, other projects); Deny → `error=access_denied` to the registered redirect URI only
    (`api.deny()`, with `state` and `iss`). `client_refused` (CIMD document gone) → a page, never a redirect.
  - Remembered approval per user + client + redirect URI + resource (server-side `kv` row `oauth-consent:…`, 30 days,
    only after an explicit approval with the box ticked, scopes must be a subset); a remembered approval re-runs
    `approve()` (grant still usable, CIMD document still valid) and is dropped if that fails. Unknown clients are never
    auto-approved.
  - **Revoke remembered approvals**: `GET /oauth/approvals` lists the signed-in user's remembered approvals; `POST
    /oauth/approvals/forget` removes one (CSRF). (Revoking issued tokens per device is P5-05.)
  - Headers: the UI CSP with `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `no-store`; on the consent page
    `form-action` also allows the redirect URI's origin (browsers apply `form-action` to the redirect after the form
    post). Fetch metadata: cross-site requests other than top-level navigations are refused.
  - Audit (`admin` rows): `oauth.consent.approve` (ok, remembered or not; denied with the resolver's reason),
    `oauth.consent.deny`, `oauth.consent.forget`. Never codes, tokens, `state` or PKCE values.
- Deviation from the original scope: the provider's `beginConsent` / `approveConsent` / `isConsentRemembered` helpers
  are not used (their `__Host-` cookies don't work on an http loopback instance, a remembered-consent cookie can't
  carry the chosen grant nor be revoked server-side, and the transaction adds a storage write per unauthenticated
  request). `beginUpstream` / `finishUpstream` are not needed: sign-in already has its own transaction (P4-01).
- Authz matrix rows for the new routes, negative tests (no session, other cookies/bearers ignored, CSRF/origin
  defects, forged grants), on the HTTP app and the Worker.

## Acceptance criteria
- [x] Playwright test of the full flow in Chromium (DCR client → authorize → sign-in → consent → approve → code at a
      loopback redirect → token → MCP `tools/list`; deny path; remembered approval; no CSP violations), at 1280 px and
      320 px.
- [x] Phishing-resistance review written down (`docs/dev/oauth.md`): client name escaped and marked unverified for DCR,
      client host and redirect host prominent, loopback warning, no auto-approval of unknown clients.
- [x] Integration tests: owner boundary (an admin's grant on the owner's key is not offered and a forged id is
      refused), other users' and service grants refused, CSRF/origin/clickjacking headers, deny redirect, remember +
      forget, `client_refused`, audit rows; on memory, SQLite and the Worker (D1).
- [x] `RB_OAUTH` parsing tests on both hosts (off by default, needs sign-in, DCR settings).
- [x] axe-core on the consent, no-access and approvals pages.
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:workers && pnpm build && pnpm bench:cpu && pnpm test:e2e`.

## Security notes
T9 (deny/approve only to the validated redirect URI, exact match, `state` and `iss`), T10 (phishing consent: client
host, redirect host, unverified marking, remembered approvals scoped per client + redirect + resource + user), T13
(CSRF, clickjacking, fetch metadata, CSP), T25 (the device label is the only grant metadata).

## Docs to update
- `docs/dev/oauth.md` (consent section, phishing review, settings), `docs/guide/` (enabling OAuth, screenshots),
  `docs/THREAT_MODEL.md`, `docs/pending-decisions/phase-5.md`, configuration reference.

## Out of scope
- Per-device revocation of issued tokens and a device list (P5-05); admin client list (P5-08).
- Access-token TTL presets per plan (P5-05).
