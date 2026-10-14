---
id: P8-53
title: Scorecard quick wins - spike lockfiles, workflow_run checkout, security policy link
phase: 8
status: todo
priority: high
depends_on: []
adr: []
owner: ""
---

# P8-53 — Scorecard quick wins: spike lockfiles, workflow_run checkout, security policy link

## Goal
OpenSSF Scorecard is 5.0. Three checks have small, code-side fixes:
- **Vulnerabilities (0):** all 11 advisories (undici, sharp) come from `spikes/*/pnpm-lock.yaml`; the root lockfile is
  clean.
- **Dangerous-Workflow (0):** `.github/workflows/docker.yml` `plan` checks out `github.event.workflow_run.head_sha`
  only to read `apps/cli/package.json`.
- **Security-Policy (4):** `SECURITY.md` has no absolute link ("no linked content found").

## Scope
- Remove the spike lockfiles (or the finished spikes, keeping their results in docs). Spikes are not installed by CI.
- In `plan`, read the version with the contents API at `HEAD_SHA` (no checkout); keep the version/sha validation.
  Update `scripts/test/docker-workflow.test.ts`.
- Add the absolute advisories URL to `SECURITY.md`.
- `docs/security/repo-settings.md`: record the `main` ruleset as applied on 2026-10-14 (PR required, 0 approvals,
  squash only, required checks, no bypass actors).

## Acceptance criteria
- [ ] No lockfile in the repo has known advisories (`pnpm audit` per lockfile).
- [ ] docker.yml has no checkout of `workflow_run` refs in `plan`; workflow structure test passes; actionlint passes.
- [ ] SECURITY.md has an https link to private vulnerability reporting.

## Security notes
T18 (CI supply chain): removes a checkout of a workflow_run ref.

## Docs to update
- `SECURITY.md`, `docs/security/repo-settings.md`, `docs/THREAT_MODEL.md` (T18 note).

## Out of scope
- Signed releases (P8-54), Best Practices badge (P8-55).
