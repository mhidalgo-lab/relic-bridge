---
id: P1-18
title: Require npm staged-publish approval on top of the release environment
phase: 1
status: todo
priority: high
depends_on: [P1-16]
adr: []
owner: ""
---

# P1-18 — Require npm staged-publish approval on top of the release environment

## Goal
Owner decision (pending-decisions phase 1, P1-15, 2026-10-09): a release needs **two** approvals, the GitHub
`release` environment and an npm staged-publish approval with 2FA on npmjs.com. A compromised GitHub account or
workflow alone must not be able to put a version on npm.

## Scope
- Verify the current npm CLI staged-publishing commands and trusted-publisher flag against official npm docs
  (RESEARCH §6 records `npm stage publish` / `--allow-stage-publish` from memory) and record the sources.
- `publish` job in `.github/workflows/release.yml`: stage the tarball instead of publishing it directly, keeping
  `--provenance`, `--access public` and `--ignore-scripts`.
- Rerun idempotency: a rerun while a version is staged but not yet approved must not stage it twice or fail
  confusingly; the GitHub Release is created only once the version is live on npm (or the job documents the manual
  step).
- Update `scripts/test/release.test.ts` assertions accordingly.

## Acceptance criteria
- [ ] The publish job stages, never publishes directly; tests assert it.
- [ ] Rerun behaviour for "staged, not approved" and "approved, no GitHub Release" is defined and tested.
- [ ] Owner set-up steps (trusted publisher with staged publishing allowed, approving on npmjs.com) are in
      `docs/dev/releasing.md`.

## Security notes
THREAT_MODEL T18 (release supply chain): adds a second, out-of-GitHub approval with 2FA.

## Docs to update
- `docs/dev/releasing.md`, `docs/RESEARCH.md` §6, `docs/THREAT_MODEL.md` T18, P1-15 owner steps.

## Out of scope
- Publishing `@relic-bridge/core` as a library.
