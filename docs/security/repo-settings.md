# Repository security settings

Settings that can't be committed as files. Apply them when the GitHub repository is created, and re-check before each release.

## While the repository is private (organization repository on the free plan)

Some controls only exist for public repos, with GitHub Advanced Security, or with a paid plan (on the free plan, branch
protection and rulesets are not available for private repositories). Until the repo goes public:
- Rulesets / branch protection, secret-scanning push protection and private vulnerability reporting are **unavailable**.
  The local lefthook hooks (DCO + gitleaks) and the CI gitleaks job are the stand-ins.
- CodeQL runs with `upload: never` (analysis still fails the job on errors). Scorecard and dependency review are skipped (PAT / GHAS needed on private repos); `scripts/check-licenses.ts` and
  `pnpm audit` still run in CI.
- **When making the repo public:** enable everything in this file, then confirm the CodeQL and Scorecard uploads appear.

## General
- Default branch: `main`. Disable merge commits; allow **squash merge** only (PR title = Conventional Commit).
- Automatically delete head branches.
- Disable wiki, keep Discussions optional.

## Rulesets for `main`
Applied on 2026-10-14 (ruleset `main`, enforcement active, **no bypass actors**):
- Restrict deletions and block force pushes (`non_fast_forward`).
- Require a pull request: **0 approvals** (single maintainer; raise to >= 1 once there are >= 2 maintainers), dismiss stale
  reviews on new commits, require review-thread resolution, **squash merge only**.
- Required status checks: `Lint, typecheck, test, build (Node 24)`, `Lint, typecheck, test, build (Node 26)`,
  `Workflow lint`, `Dependency audit`, `DCO sign-off`, `Conventional PR title`, `CodeQL`, `Secret scan (gitleaks)`,
  `Dependency review`, `Authorization suite`.
- Optional: require signed commits.
- Tag ruleset `v*`: only maintainers / the release workflow may create tags.

## Code security (Settings → Code security)
- Dependency graph: on. Dependabot alerts: on. (Updates are done by Renovate, so Dependabot version updates stay off.)
- **Secret scanning: on**, with **push protection: on**.
- **Private vulnerability reporting: on** (required by SECURITY.md).
- Verified on 2026-10-14: private vulnerability reporting, secret scanning with push protection and Dependabot alerts were
  found off and turned on; the 11 secret-scanning alerts on fake test keys (`NRAK-FAKE…`) were closed as "used in tests".
- CodeQL: on through `.github/workflows/security.yml` (not "default setup", so the two don't conflict).

## Actions
- Workflow permissions: **read repository contents** by default; Actions **may create and approve pull requests**
  (enabled; the changesets Version PR needs it). A PR opened with the workflow token does not trigger CI: close and
  reopen it to run the checks.
- Allow only actions pinned by SHA from: GitHub, verified creators, and the allowlist used in our workflows.
- Fork PR workflows: require approval for first-time contributors. Pull-request CI runs on self-hosted runners only
  while the repository is private; before going public, switch it to GitHub-hosted runners via the `CI_RUNS_ON`
  variable (THREAT_MODEL T18).
- Environments: `release` (npm trusted publishing, required reviewer) and `staging` (Workers smoke tests,
  required reviewer). Secrets live only in environments, never at repository level.

## Apps
- Install the **Renovate** GitHub App for this repository only.
- Optional: StepSecurity app for harden-runner insights.

## npm
- Create the `@relic-bridge` org/scope and reserve `relic-bridge` (P0-01).
- Enable 2FA for publishing, and configure **trusted publishing** from the `release` environment (P1-15). No long-lived npm tokens.
