---
id: P4-12
title: "ZAP baseline scan of the admin panel"
phase: 4
status: in-progress
priority: low
depends_on: [P4-07]
adr: []
owner: claude-agent
---

# P4-12 — ZAP baseline scan of the admin panel

## Goal
P4-07 reviewed the admin panel by hand and with probe tests; its original scope also asked for an OWASP ZAP baseline
(passive) scan against a local instance. CI was unavailable during the review, so the scan moves here.

## Scope
- `pnpm scan:zap` (`e2e/zap.ts`): reuses the P4-11 harness (built CLI, temporary SQLite, mock IdP and NerdGraph on
  loopback, random fake keys), signs in through a setup link and runs ZAP (container image pinned by digest, host
  network, loopback target only) three times: `/auth/login` signed out, `/admin` spidered with the owner's session
  cookie, and `/api/admin/v1` (its OpenAPI document, bearer admin token, passive `-S` mode). Reports go to the
  git-ignored `zap-reports/`; a report holding a secret value fails the run.
- `.zap/rules.tsv`: one line per ignored alert, each with a written reason above it.
- CI: a manual-only workflow (`workflow_dispatch`, pinned actions, read-only permissions): CI minutes are scarce, and
  the scan needs Docker and a browser-free but multi-minute run.

## Acceptance criteria
- [ ] The scan runs locally from one command and fails on any unreviewed medium or high alert.
- [ ] Alerts found are fixed or listed with a reason in the rules file; THREAT_MODEL T13 cites the scan.
- [ ] Real findings fixed with regression tests; the review doc gets a ZAP section.
- [ ] Manual workflow added; actionlint passes.

## Security notes
T13, T14. Test credentials only; the scan report must not contain a real key, token or email.

## Docs to update
- `CONTRIBUTING.md` (how to run it), `docs/THREAT_MODEL.md`.

## Out of scope
- Active scanning against a deployed instance; external review (P8-02).
