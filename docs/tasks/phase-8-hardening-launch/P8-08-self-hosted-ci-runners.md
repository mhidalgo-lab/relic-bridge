---
id: P8-08
title: Run CI on the organization's self-hosted runners, with a hosted fallback
phase: 8
status: todo
priority: high
depends_on: []
adr: []
owner: ""
---

# P8-08 — Run CI on the organization's self-hosted runners, with a hosted fallback

## Goal
The repository moved to an organization that has self-hosted Linux runners. Pull-request CI should run there by
default, switchable back to GitHub-hosted runners with one variable when the runners are offline.

## Scope
- Linux jobs that only build/test code use
  `runs-on: ${{ fromJSON(vars.CI_RUNS_ON || '["self-hosted","linux","x64"]') }}`: `ci.yml` (all jobs except the
  macOS/Windows `sqlite-os` matrix), `security.yml`, `bench.yml`, `e2e.yml`, `zap.yml`, and the pull-request path of
  `docker.yml` `build` (release-mode builds stay hosted).
- Stay on GitHub-hosted runners (unchanged): `release.yml` (provenance claims a hosted builder; OIDC), `docker.yml`
  `plan`/`publish` and release builds, `scorecard.yml` (OIDC publishing), `live.yml` and `staging-smoke.yml`
  (environment secrets), the macOS/Windows matrix.
- Make the jobs work on a fresh ephemeral Linux container runner (no preinstalled tools beyond what the actions set
  up): e.g. multi-arch Docker builds may need `docker/setup-qemu-action`; `harden-runner` must not fail on
  self-hosted.
- Workflow structure tests (`scripts/test/docker-workflow.test.ts`, `release.test.ts`) assert which jobs may and may not
  use self-hosted runners.

## Acceptance criteria
- [ ] A PR on this branch runs CI, Security and (if triggered) Docker/bench on self-hosted runners and passes.
- [ ] Setting `CI_RUNS_ON` to `["ubuntu-latest"]` routes the same jobs back to hosted runners (documented).
- [ ] Tests fail if `release.yml`, docker `publish`, `scorecard.yml`, `live.yml` or `staging-smoke.yml` ever use
      `self-hosted` or `vars.CI_RUNS_ON`.

## Security notes
THREAT_MODEL T18 (CI/release supply chain): self-hosted runners must only serve a **private** repository (a fork PR
could run code on them). Before the repository goes public (P1-15 owner list), either move PR CI back to hosted
(`CI_RUNS_ON`) or restrict fork PR workflows. Secrets and OIDC jobs never run self-hosted.

## Docs to update
- `docs/dev/` CI section (runner variable, what stays hosted, public-repo warning), `docs/THREAT_MODEL.md` T18,
  `docs/pending-decisions/owner-checklist.md` (public-repo step).

## Out of scope
- Any description of the runner infrastructure itself (lives outside this repository).
