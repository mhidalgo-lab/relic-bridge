---
id: P0-02
title: License and community files
phase: 0
status: review
priority: high
depends_on: [P0-01]
adr: [0002, 0003]
owner: ""
---

# P0-02 — License and community files

## Goal
Make the repo safe and welcoming to publish from day one.

## Scope
- `LICENSE` (full Apache-2.0 text from apache.org), `NOTICE`.
- `README.md`: what/why, status badge ("pre-alpha"), **unofficial / trademark disclaimer** (ADR-0002), deployment modes overview, links to docs.
- `CONTRIBUTING.md`: dev setup, task workflow (docs/tasks/README.md), Conventional Commits, **DCO sign-off**, PR checklist (tests, docs, threat model).
- `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1).
- `SECURITY.md`: supported versions, **private vulnerability reporting via GitHub Security Advisories**, response SLAs, scope, safe harbour.
- `.github/PULL_REQUEST_TEMPLATE.md` (task id, checklist), `.github/ISSUE_TEMPLATE/` (bug, feature — community intake only, per ADR-0001).
- SPDX header convention documented; a check script verifies headers.

## Acceptance criteria
- [x] All files present and linked from README.
- [x] SPDX header check runs in `pnpm lint`.

## Security notes
SECURITY.md must never ask reporters to open public issues.

## Docs to update
- README, CONTRIBUTING.

## Out of scope
- Docs site (P8-04).

## Progress notes
- 2026-10-01: LICENSE (official text), NOTICE, README, CONTRIBUTING (DCO), CODE_OF_CONDUCT (Contributor Covenant 2.1),
  SECURITY.md (GitHub private reporting), PR + issue templates, `scripts/check-spdx.ts`.
- Code of Conduct contact set to `me@mhidalgo.ar` (2026-10-02). GitHub repo
  `matiashidalgo/relic-bridge` created (private) for badges and links.
