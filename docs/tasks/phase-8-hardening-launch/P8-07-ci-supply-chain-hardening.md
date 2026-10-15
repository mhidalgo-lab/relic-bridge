---
id: P8-07
title: CI supply-chain hardening follow-ups
phase: 8
status: done
priority: medium
depends_on: [P1-16]
adr: []
owner: claude-agent
---

# P8-07 — CI supply-chain hardening follow-ups

## Goal
Tighten the GitHub Actions set-up beyond what v0.1 needed. Found in the Phase 1 consolidation review
(`docs/reviews/phase-1-review.md`, L-items).

## Scope
Refined on 2026-10-14 against today's workflows (the original text predates P8-08, P8-53 and P8-54).
- `step-security/harden-runner`: **partly done.** `ci.yml` (`check`, `authz`, `workers`), `bench.yml`, `e2e.yml`,
  `zap.yml`, `docker.yml` and every `release.yml` job already have it (`egress-policy: audit`). Still missing: `ci.yml`
  `actionlint`, `dco`, `pr-title`; all four `security.yml` jobs; `live.yml`; `staging-smoke.yml`; `scorecard.yml`.
  Add it to each, with `if: runner.environment == 'github-hosted'` on jobs that use the `CI_RUNS_ON` expression (the
  action only supports hosted Linux runners; the macOS/Windows `sqlite-os` matrix is out: unsupported). A test asserts
  that every Linux job has it first. **Block mode for the release jobs** (`release.yml`, `docker.yml` `publish`)
  needs an allowlist derived from audit data; the step logs are not available from the repository, so the endpoints
  are listed from the steps themselves and the switch is left as an owner decision unless that list is complete.
- `ci.yml` actionlint download: **pin the expected sha256 of the binary tarball in the workflow** instead of trusting
  the checksums file from the same release. (`security.yml` gitleaks has the same pattern: pin it too, same reason.)
- `scripts/check-package.ts`: **add** NR license keys (40 hex + `NRAL`), the `rb_` master key form, AWS/Cloudflare
  token shapes and `C:\Users\` / `/root/` paths (the single-backslash form too); **check** `main`/`exports` point at
  shipped files, `publishConfig`, `bundledDependencies`, and **require exact dependency versions** (no ranges, tags).
  No false positives on the real package (run against a real `pnpm pack`).
- Document (and ask the owner to set) the deployment-branch rule for the `live` environment (`main` only) so a
  `workflow_dispatch` from a feature branch cannot run unreviewed test code with `RB_LIVE_API_KEY`. `release` is
  already documented in `docs/dev/releasing.md`.

## Acceptance criteria
- [x] actionlint passes; every Linux job has harden-runner (test enforced).
- [x] actionlint (and gitleaks) download verified against a sha256 pinned in the workflow.
- [x] `scripts/test/check-package.test.ts` covers each new pattern and check; `pnpm check:package` passes on the real tarball.
- [x] CONTRIBUTING.md lists the environment settings (`live` deployment branches). Owner still has to set the rule in GitHub (not done from here).
- [x] THREAT_MODEL T18 row added.

## Security notes
T18. Update THREAT_MODEL T18 row.

## Docs to update
- `docs/THREAT_MODEL.md`, CONTRIBUTING.md.

## Out of scope
- Splitting the publish job (P1-16).
