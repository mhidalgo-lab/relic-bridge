---
id: P4-07
title: "Admin panel security review"
phase: 4
status: review
priority: high
depends_on: [P4-04]
adr: []
owner: claude-agent
---

# P4-07 — Admin panel security review

## Goal
An adversarial review of everything Phase 4 added (P4-01 … P4-06: `git diff phase/4-identity-admin...task/P4-06-connect-page`)
before the admin panel ships, with every real finding fixed or tracked.

## Scope
- **Sign-in (P4-01):** OAuth/OIDC state, nonce, PKCE; issuer mix-up; `alg` confusion; JWKS/discovery fetch (SSRF, size,
  timeouts); `next=` open redirects; account linking / takeover; setup links; login rate limits.
- **Sessions (P4-02):** fixation, hijack, cookie flags, CSRF on every mutating route (including logout and key
  rotation), `Origin` / `Sec-Fetch-*` checks, role escalation (member → admin, admin → owner), IDOR across projects
  and users.
- **UI (P4-03 … P4-06):** stored XSS (audit content, labels, names, provider names), reflected XSS (query params),
  CSP bypass, clickjacking, error pages leaking information, cache headers on secret pages, the one-time token page
  re-issuing a token on reload, secret leakage in HTML / logs / audit / CSV export (CSV formula injection), host-header
  injection into connect snippets, DoS through audit statistics queries.
- Probe tests for each attack; fixes with regression tests that fail without the fix.
- Report: `docs/reviews/phase-4-admin-security-review.md` (findings table: severity, file:line, impact, fix/status).

## Acceptance criteria
- [x] Every attack class above probed; the report lists each finding with severity, location, impact and status.
- [x] Every real finding fixed on this branch with a regression test, or tracked as a new task file / pending
      decision.
- [x] The one-time token page no longer issues a second token on reload (or a tracked reason why not).
- [x] CSV export neutralises spreadsheet formulas.
- [x] P2-12 authorization matrix green on Node and the Worker; `pnpm lint && pnpm typecheck && pnpm test &&
      pnpm test:workers && pnpm build && pnpm bench:cpu` green.
- [x] THREAT_MODEL updated (T13, T14 and any new threat).

## Security notes
T13, T14; T4 (NRQL in audit filters), T20 (stats queries), T23.

## Docs to update
- `docs/THREAT_MODEL.md`, `docs/reviews/phase-4-admin-security-review.md`, guides touched by fixes.

## Out of scope
- External review (P8-02).
- ZAP baseline scan in CI (CI unavailable; moved to a follow-up task if still wanted).
