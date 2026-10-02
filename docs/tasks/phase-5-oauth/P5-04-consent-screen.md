---
id: P5-04
title: "Login and consent screen"
phase: 5
status: todo
priority: high
depends_on: [P5-03]
adr: []
owner: ""
---

# P5-04 — Login and consent screen

## Scope
- Build on the provider's `beginConsent` / `approveConsent` / `isConsentRemembered` and `beginUpstream` / `finishUpstream` helpers (P0-08).
- Authorize flow: IdP login (P4-01) → choose project/grant (pre-selected by resource) → show client name, redirect host, tools and accounts granted → approve; remember approval per client.
- Device label captured (e.g. "Pixel phone – claude.ai").
- `frame-ancestors 'none'`, CSRF, state checks, exact redirect URI matching.

## Acceptance criteria
- [ ] Playwright test of full flow; phishing-resistance review (client name + redirect host prominent).

## Security notes
T9, T10, T13.

## Docs to update
- OAuth guide with screenshots.

## Out of scope
- —
