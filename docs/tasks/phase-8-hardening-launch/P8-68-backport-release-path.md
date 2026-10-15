---
id: P8-68
title: Backport release path with on-demand release/x.y branches
phase: 8
status: review
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-68 — Backport release path with on-demand release/x.y branches

## Goal
After 1.0 a security or critical fix must be releasable for the previous minor without shipping what is on `main`.
`release.yml` and `docker.yml` trigger only on `main` (`on.push.branches: [main]`), the release jobs guard on
`github.ref == 'refs/heads/main'`, and the `release` environment accepts deployments from `main` only
(`docs/security/repo-settings.md`). **Must land before 1.0.**

## Scope
- Branch model: `release/x.y` branches are created on demand from the release tag (not kept in advance) and protected by
  a ruleset like `main`: pull request required, required checks, no force push, no deletion.
- `release.yml` and `docker.yml`: run for `main` or `release/*`; every job guard (including `RB_RELEASE_ENABLED`) accepts
  exactly those refs. Approval on the `release` environment is still required. A backport never moves `:latest` (the
  `plan` job in `docker.yml` already computes `latest` from the highest stable release) or the npm `latest` dist-tag.
- Changesets on the branch: how the version PR is produced and targeted at `release/x.y`.
- `docs/dev/releasing.md`: a worked procedure (create the branch, cherry-pick, version PR, approve, tag, retire the branch).
- `scripts/test/release.test.ts` and `scripts/test/docker-workflow.test.ts`: assert the ref guards (`main` and `release/*`
  only) and the no-`latest` rule for backports.
- Owner action (not done by an agent): add `release/*` to the `release` environment's deployment branches and create the
  `release/*` ruleset; record both in `docs/security/repo-settings.md`.

## Acceptance criteria
- [x] A run from `release/1.2` passes the guards; from any other branch or a tag the release jobs are skipped (tests).
- [x] A backport release never sets `:latest` or the npm `latest` tag (tests).
- [x] `docs/dev/releasing.md` has the backport procedure.
- [x] `docs/security/repo-settings.md` lists the new ruleset and environment setting.
- [ ] Owner action done and a dry run verified (leave unticked until the owner has changed the settings).

## Security notes
T18. The environment's branch restriction is what stops a pushed branch from obtaining the approval prompt and the
OIDC/npm permissions. Widening it to `release/*` is safe only together with the branch ruleset. The `v*` tag ruleset is
unchanged.

## Docs to update
- `docs/dev/releasing.md`, `docs/security/repo-settings.md`, `docs/THREAT_MODEL.md` (T18 row), `docs/guide/versioning.md`
  when it exists (support window).

## Out of scope
- Long-lived maintenance branches; automating cherry-picks.

## Owner action (pending)
In this order, after this change is on `main`:
1. Settings, Rules, Rulesets, **New branch ruleset** `release/*`: target pattern `release/*`, enforcement active, no
   bypass actors; restrict creations (maintainers only), restrict deletions, block force pushes; require a pull request
   (squash only, same review settings as `main`); require the same status checks as the `main` ruleset.
2. Settings, Environments, `release`, Deployment branches and tags: keep `main`, **add the branch rule `release/*`**.
3. Dry run when the first backport is needed (or with a throwaway `release/0.x` while `RB_RELEASE_ENABLED` stays as is):
   check that `plan` runs, that the version PR targets `release/x.y` and that the stage step uses `--tag release-x.y`.

## Outcome
- `release.yml` runs on `main` and `release/*`; `plan`, `build` and `publish` share one ref guard;
  `scripts/release.ts plan` also refuses nested names and a version outside the branch's minor and outputs `npm-tag`
  (`latest` from `main`, `release-x.y` from a backport). `publish` re-checks the pair, stages with `--tag "$NPM_TAG"`
  and creates the GitHub Release with `--latest=false` for a backport.
- `docker.yml` accepts `workflow_run` from `release/*`; `plan` sets `latest=true` only for `main`. Its jobs run with the
  default branch's ref (`workflow_run`), so the environment rule and the cosign identity are unchanged.
- Tests evaluate the job guards with a small expression evaluator (`scripts/test/gha-expr.ts`) against allowed and
  refused refs.
