---
id: P8-07
title: CI supply-chain hardening follow-ups
phase: 8
status: todo
priority: medium
depends_on: [P1-16]
adr: []
owner: ""
---

# P8-07 — CI supply-chain hardening follow-ups

## Goal
Tighten the GitHub Actions set-up beyond what v0.1 needed. Found in the Phase 1 consolidation review
(`docs/reviews/phase-1-review.md`, L-items).

## Scope
- `step-security/harden-runner`: add it to every job (`live.yml`, `ci.yml` dco/actionlint/pr-title, `security.yml`)
  and switch the release jobs to `egress-policy: block` with an allowlist once audit runs show the endpoints.
- `ci.yml` actionlint download: pin the expected sha256 in the workflow (or use a SHA-pinned action) instead of
  trusting a checksums file from the same release.
- `scripts/check-package.ts`: add NR license keys (40 hex + `NRAL`), the `rb_` master key form, AWS/Cloudflare token
  shapes and `C:\Users\` / `/root/` paths; check `exports`/`main`, `publishConfig` and `bundledDependencies`; require
  exact dependency versions.
- Document (and ask the owner to set) deployment-branch rules for the `live` environment so a `workflow_dispatch`
  from a feature branch cannot run unreviewed test code with `RB_LIVE_API_KEY`.

## Acceptance criteria
- [ ] actionlint passes; every job has harden-runner.
- [ ] `scripts/test/check-package.test.ts` covers each new pattern.
- [ ] CONTRIBUTING.md lists the environment settings.

## Security notes
T18. Update THREAT_MODEL T18 row.

## Docs to update
- `docs/THREAT_MODEL.md`, CONTRIBUTING.md.

## Out of scope
- Splitting the publish job (P1-16).
