# Repository security settings

Settings that can't be committed as files. Apply them when the GitHub repository is created, and re-check before each release.

## While the repository is private (free personal plan)

Some controls only exist for public repos (or with GitHub Advanced Security). Until the repo goes public:
- Rulesets / branch protection, secret-scanning push protection and private vulnerability reporting are **unavailable**.
  The local lefthook hooks (DCO + gitleaks) and the CI gitleaks job are the stand-ins.
- CodeQL runs with `upload: never` (analysis still fails the job on errors). Scorecard is skipped (it needs a PAT on private repos).
- **When making the repo public:** enable everything in this file, then confirm the CodeQL and Scorecard uploads appear.

## General
- Default branch: `main`. Disable merge commits; allow **squash merge** only (PR title = Conventional Commit).
- Automatically delete head branches.
- Disable wiki, keep Discussions optional.

## Rulesets for `main`
- Require a pull request (≥ 1 approval once there are ≥ 2 maintainers; until then, the PR + green checks).
- Dismiss stale approvals; require conversation resolution.
- Required status checks: `Lint, typecheck, test, build (Node 24)`, `Lint, typecheck, test, build (Node 26)`,
  `Workflow lint`, `Dependency audit`, `DCO sign-off`, `Conventional PR title`, `CodeQL`, `Secret scan (gitleaks)`, `Dependency review`.
- Block force pushes and deletions.
- Optional: require signed commits.
- Tag ruleset `v*`: only maintainers / the release workflow may create tags.

## Code security (Settings → Code security)
- Dependency graph: on. Dependabot alerts: on. (Updates are done by Renovate, so Dependabot version updates stay off.)
- **Secret scanning: on**, with **push protection: on**.
- **Private vulnerability reporting: on** (required by SECURITY.md).
- CodeQL: on through `.github/workflows/security.yml` (not "default setup", so the two don't conflict).

## Actions
- Workflow permissions: **read repository contents** by default; don't allow Actions to create or approve PRs.
- Allow only actions pinned by SHA from: GitHub, verified creators, and the allowlist used in our workflows.
- Fork PR workflows: require approval for first-time contributors.
- Environments: `release` (npm trusted publishing, required reviewer) and `staging` (Workers smoke tests,
  required reviewer). Secrets live only in environments, never at repository level.

## Apps
- Install the **Renovate** GitHub App for this repository only.
- Optional: StepSecurity app for harden-runner insights.

## npm
- Create the `@relic-bridge` org/scope and reserve `relic-bridge` (P0-01).
- Enable 2FA for publishing, and configure **trusted publishing** from the `release` environment (P1-15). No long-lived npm tokens.
