---
id: P5-12
title: "OAuth protocol nits from the Phase 5 review"
phase: 5
status: done
priority: low
depends_on: [P5-04]
adr: []
owner: claude-agent
---

# P5-12 — OAuth protocol nits from the Phase 5 review

## Goal
Phase 5 review L7-L9 (`docs/reviews/phase-5-review.md`): small deviations, none exploitable alone.

## Scope
- **`prompt=none`** shows the consent page instead of redirecting with `consent_required` / `login_required`
  (OIDC Core §3.1.2.6, used by some clients for silent re-authorization).
- **`redirect_uri` optional at the token endpoint.** The provider checks it only when sent (PKCE binds the code
  anyway, OAuth 2.1 drops the requirement). Decide whether to require it when the authorization request carried one
  (RFC 6749 §4.1.3), after checking real clients (P5-06 list).
- **`form-action` for IPv6 loopback.** A registered `http://[::1]:port/...` redirect widens the consent page's CSP to
  `form-action 'self' http:` (CSP host sources can't spell IPv6 literals; `packages/admin-ui/src/headers.ts`). The page
  also carries the sign-out form. Not exploitable without an HTML injection (none known). Options: refuse `[::1]`
  redirects at registration in favour of `127.0.0.1`, or answer the consent post with a same-origin interstitial that
  navigates to the client (no form redirect).
- **Confusable client names.** Mixed-script names (Cyrillic look-alikes of "Claude") pass `safeClientName`; the
  consent page already shows the vouching host / "not verified". Consider flagging mixed-script names.

## Acceptance criteria
- [x] `prompt=none` without a remembered approval redirects with `consent_required` (with `state` and `iss`).
- [x] Decision on `redirect_uri` recorded; tests match it.
- [x] No consent page response carries a scheme-wide `form-action` source.

## Security notes
T9, T10, T13.

## Docs to update
- `docs/dev/oauth.md`, `docs/reference/client-compatibility.md`.

## Out of scope
- Anything requiring a new ADR.
