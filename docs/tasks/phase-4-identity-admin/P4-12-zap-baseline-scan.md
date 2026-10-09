---
id: P4-12
title: "ZAP baseline scan of the admin panel"
phase: 4
status: todo
priority: low
depends_on: [P4-07]
adr: []
owner: ""
---

# P4-12 — ZAP baseline scan of the admin panel

## Goal
P4-07 reviewed the admin panel by hand and with probe tests; its original scope also asked for an OWASP ZAP baseline
(passive) scan against a local instance. CI was unavailable during the review, so the scan moves here.

## Scope
- A script (`pnpm scan:zap`) that starts `relic-bridge serve` on a temporary SQLite database with a mock IdP (no real
  keys), signs in through a setup link, and runs the ZAP baseline scan (pinned container image digest) against
  `/admin`, `/auth/*` and `/api/admin/v1` with the session cookie.
- A rules file (`.zap/rules.tsv`) documenting each ignored alert and why (e.g. CSP reports already covered by P4-03).
- A CI job (pinned actions, scheduled or manual) or a documented manual run: owner's choice (CI minutes).

## Acceptance criteria
- [ ] The scan runs locally from one command and fails on any unreviewed medium or high alert.
- [ ] Alerts found are fixed or listed with a reason in the rules file; THREAT_MODEL T13 cites the scan.

## Security notes
T13, T14. Test credentials only; the scan report must not contain a real key, token or email.

## Docs to update
- `CONTRIBUTING.md` (how to run it), `docs/THREAT_MODEL.md`.

## Out of scope
- Active scanning against a deployed instance; external review (P8-02).
