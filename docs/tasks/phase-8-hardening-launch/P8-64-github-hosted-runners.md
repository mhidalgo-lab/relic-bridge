---
id: P8-64
title: CI runs on GitHub-hosted runners only
phase: 8
status: done
priority: high
depends_on: [P8-07]
adr: []
owner: claude-agent
---

# P8-64 — CI runs on GitHub-hosted runners only

## Goal
Remove self-hosted runner support entirely. Owner decision (2026-10-14): the repository is public, and a `runs-on`
fallback to self-hosted runners would run fork pull-request code on them if the repository variable were ever unset.

## Scope
- Every `runs-on: ${{ fromJSON(vars.CI_RUNS_ON || ...) }}` (and the `docker.yml` `build` variant) becomes
  `runs-on: ubuntu-latest`; the macOS/Windows OS matrix is unchanged.
- Remove the harden-runner "skip on non-hosted runners" conditions: it runs unconditionally as the first step of every
  Linux job.
- `scripts/test/ci-runners.test.ts` and `scripts/test/workflow-hardening.test.ts` assert that no workflow uses a
  self-hosted label or `vars.CI_RUNS_ON` and that harden-runner is unconditional.
- Remove or rewrite every mention of `CI_RUNS_ON` and self-hosted runners in current docs.

## Acceptance criteria
- [x] No workflow contains `self-hosted`, `CI_RUNS_ON` or `runner.environment`; actionlint passes.
- [x] harden-runner is the unconditional first step of every Linux job.
- [x] Tests updated and passing; `pnpm lint && pnpm typecheck && pnpm test` pass.
- [x] Docs updated (testing guide, CONTRIBUTING, repo settings, THREAT_MODEL T18).
- [ ] Owner: delete the repository variable `CI_RUNS_ON` (and any leftover `CI_RUNS_ON` secret) after this merges.
  Needs the owner (repository settings).

## Security notes
THREAT_MODEL T18: removes the risk of fork pull-request code reaching a self-hosted runner.

## Docs to update
`docs/dev/testing.md`, `CONTRIBUTING.md`, `docs/security/repo-settings.md`, `docs/THREAT_MODEL.md`.

## Out of scope
- Editing completed task files and pending-decisions history. No changeset (CI only).
