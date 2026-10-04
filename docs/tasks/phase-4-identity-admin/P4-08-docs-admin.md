---
id: P4-08
title: "Docs — admin guide and release v0.4"
phase: 4
status: in-progress
priority: medium
depends_on: [P4-05, P4-06, P4-07]
adr: []
owner: claude-agent
---

# P4-08 — Docs — admin guide and release v0.4

## Scope
- One entry-point **admin guide** (`docs/guide/admin-guide.md`): from a running server to a team using it, phone first.
  Covers choosing a provider, **allow-lists explained plainly**, roles, the first owner, bring-your-own-key team setup,
  phone use, sessions and the sign-in rate limit, a Phase 4 settings table (including the `_FILE` variants and the
  `cf:setup --sign-in` prompts), day-two tasks (lost phone, offboarding) and a pointer to the contributor checks
  (`pnpm test:e2e`, `pnpm scan:zap`).
- Fix stale Phase 4 statements in the existing guides (identity providers, Cloudflare deploy, README, ROADMAP, CLI help)
  and verify every route, variable and command against the code and the built CLI.
- Prepare v0.4.0 only as far as earlier phases did: earlier phases left version bump, changeset and tags to the owner,
  so none is made here; "cut v0.4.0" is logged as a pending decision.

## Acceptance criteria
- [x] Admin guide covers providers, allow-lists, roles, first owner, BYO-key team setup, phone use, sessions, CSRF,
  sign-in rate limit, settings, day-two tasks and contributor checks.
- [x] Allow-lists are explained with examples and the deny-by-default rules.
- [x] Documented routes, variables and commands match the code (checked against the source and the built CLI).
- [x] Stale "planned" statements in README, ROADMAP and guides updated; `docs/reference/*` regenerated.
- [x] Screenshots from P4-11 are used; no broken links or images.
- [ ] Docs validated by a fresh agent session (not possible unattended: left for the owner).
- [ ] Release v0.4.0 published (maintainer action, not done here; see `docs/pending-decisions/phase-4.md`).

## Security notes
Explain allowlists clearly.

## Docs to update
- docs/guide/* (new `admin-guide.md`), README available/planned, ROADMAP, `docs/reference/*` if generated output changes.

## Out of scope
- Cutting the release and validating on a clean deployment.
