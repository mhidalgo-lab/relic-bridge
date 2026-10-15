# Releasing: required repository settings

The release workflows (`release.yml`, `docker.yml`) assume the settings below. Workflow code cannot enforce them, so
check them once, and again after any repository transfer or settings reset. Nothing here is automated on purpose:
settings are an owner decision (THREAT_MODEL T13, T18).

## Settings the release path relies on

| Setting | Required value | Why |
| --- | --- | --- |
| Environment `release` | **Required reviewers**: at least one maintainer who is not the person who triggered the run; **prevent self-review** on. | `publish` (OIDC token, staging on npm) waits for this approval. This is the first of two approvals. Without reviewers the gate is a no-op. |
| Environment `release` | **Deployment branches**: selected branches, `main` and `release/*` (no tags rule, no "all branches"). | A workflow on another branch must not obtain the approval prompt or the environment's permissions. `release/*` is safe only together with the `release/*` ruleset below (P8-68). |
| Repository variable `RB_RELEASE_ENABLED` | unset or `false` until the first release is intended; then `true`. | Every release job is skipped without it. |
| Branch protection / ruleset on `main` | Pull request required, status checks required (including `Docker` and `CI`), no force push, no deletion. | The release workflows run for what is on `main`. |
| Branch ruleset `release/*` | Same rules as `main`: pull request required (squash only), the same required status checks, no force push, no deletion; creation restricted to maintainers. | A backport release runs for what is on `release/x.y` (P8-68); without the ruleset anyone with write access could push a branch that reaches the `release` environment. |
| Tag ruleset `v*` | Only maintainers can create; no update, no deletion. | `plan` trusts that `v<version>` points at the released commit; image tags are immutable by convention. |
| Environment `live` | **Deployment branches**: selected branches, only `main`; required reviewers. | `Live` is a manual workflow that holds `RB_LIVE_API_KEY`: a dispatch from a feature branch must not reach the secret (P8-07). |
| Actions permissions | Default `GITHUB_TOKEN` read-only; "allow GitHub Actions to create pull requests" only if the release PR is used; actions pinned by SHA. | Each job declares its own permissions. |
| GHCR package `relic-bridge` | Visibility public after the first push; package settings link it to this repository; only the workflow can write. | Consumers verify signatures; nobody should push by hand. |

## Backport releases (`release/x.y`, P8-68)

From 1.0 the previous minor gets security fixes for a while (`docs/guide/versioning.md`). A backport ships from a
`release/x.y` branch that is created only when it is needed, from the newest tag of that minor, and is never kept in
advance. `release.yml` runs for pushes to `main` and `release/*`; `plan` (`scripts/release.ts`) refuses any other ref,
a nested name such as `release/1.2/x`, and a version outside `x.y` (`release/1.2` can only release `1.2.z`). The `build`
and `publish` jobs keep every other rail: `RB_RELEASE_ENABLED`, the `release` environment approval and the npm approval.

What a backport never does:
- **npm `latest`:** `plan` outputs the dist-tag `release-x.y` for a backport (`latest` only from `main`), `publish`
  re-checks the pair against the ref and runs `npm stage publish --tag "$NPM_TAG"`. `npm install relic-bridge` keeps
  resolving to the newest minor; users of the old line install `relic-bridge@release-1.2` or an exact version.
- **GitHub "Latest release":** the GitHub Release is created with `--latest=false`.
- **`:latest` image:** `docker.yml` `plan` sets `latest=true` only when the triggering branch is `main` (and the release
  is the highest stable one). The image gets its `:<version>` tag only. `docker.yml` runs through `workflow_run`, so its
  jobs run with the default branch's workflow file and ref: the `release` environment and the cosign identity
  (`docker.yml@refs/heads/main`) are unchanged for backports.

Procedure (example: security fix for 1.2 while `main` is on 1.3):

1. Fix on `main` first, in a normal pull request with a `relic-bridge` patch changeset, and release it as `1.3.z`.
2. Create the branch from the newest 1.2 tag (maintainer): `git fetch --tags && git push origin v1.2.3^{commit}:refs/heads/release/1.2`.
   Check the `release/*` ruleset applies to it (Settings, Rules, Rulesets).
3. Cherry-pick onto a work branch and open a pull request **into `release/1.2`**:
   `git switch -c backport/1.2-<slug> origin/release/1.2 && git cherry-pick -x <sha>`. Keep the changeset (patch only;
   no migration, versioning policy). The same CI checks run as for `main`.
4. Merging it starts `release.yml` on `release/1.2`: `plan` finds the changeset and the `version` job opens the
   version PR `changeset-release/release/1.2` against `release/1.2` (changesets uses the current branch). Close and
   reopen it to run CI (PRs opened with the workflow token do not trigger workflows), then merge it.
5. The run for the merge stages `1.2.4` with the dist-tag `release-1.2` after the `release` environment approval.
   Check the dist-tag and integrity on npmjs.com, approve with 2FA, then run *Release* again with **Use workflow from:
   `release/1.2`** to create the GitHub Release (not marked latest). `docker.yml` then publishes `:1.2.4`.
6. Bring the `1.2.4` CHANGELOG section to `main` only if you want it listed there (optional, normal pull request).
7. Retire the branch when the minor leaves the support window: stop merging into it and remove it from the
   supported-versions table. The ruleset forbids deletion; delete it only by editing the ruleset, as an owner decision.

## `:latest` rule

`plan` (`docker.yml`) sets `latest=true` only when `v<version>` is a stable release **and** is the highest stable
semver among the published GitHub Releases (`sort -V`, drafts and prereleases excluded). `publish` copies `:latest`
only then. Re-running the workflow for an older tag therefore keeps its own `:<version>` tag but leaves `:latest`
where it is. Prereleases never move `:latest`.

## What a pull request proves about the image

The `Docker` workflow builds the image for amd64 and arm64, scans **both** with Trivy (fixed high and critical
vulnerabilities and secrets fail the job), and runs `scripts/docker-smoke.sh` against the amd64 image. The smoke test
runs the image hardened (read-only root, no capabilities, non-root) next to a local HTTPS stand-in for
`api.newrelic.com` (`scripts/docker-smoke/fake-nerdgraph.mjs`, trusted through `NODE_EXTRA_CA_CERTS`), then, using
only the image: checks `/health`, refuses a foreign `Host`, runs `db backup`, creates a credential, project, grant and
device token with the CLI, and lists tools over MCP with that token (and gets `401` without it). Run it locally with
`docker build -t relic-bridge:dev . && scripts/docker-smoke.sh relic-bridge:dev` (needs docker, jq, openssl; it needs no bind mounts or published ports, so it also works against a remote Docker daemon).

The compose example was also run once with a local Caddy (internal CA) in front of the image (P2-19): `/health`
answered over TLS and Caddy waited for the server's health check. That is a manual check; repeat it when
`deploy/` changes.

## npm: staged publishing (second approval, P1-18)

A release needs **two** approvals: the GitHub `release` environment and an approval with 2FA on npmjs.com. The
`publish` job runs `npm stage publish` (never `npm publish`): the tarball is uploaded with provenance but the version
is not public until a maintainer approves it. A compromised GitHub account or workflow alone cannot put a version on
npm, and CI cannot approve (`npm stage` subcommands refuse OIDC tokens). Facts and sources: RESEARCH section 6.

### One-time set-up (owner)

1. Trusted publisher for `relic-bridge` allowing staged publishing only, so nothing can publish directly:
   `npm trust github relic-bridge --repo <owner>/relic-bridge --file release.yml --env release --allow-stage-publish`
   (or npmjs.com: package *Settings, Trusted publisher*, GitHub Actions, workflow `release.yml`, environment `release`,
   allowed actions: `npm stage publish` only). Do not add `--allow-publish`.
2. Package *Publishing access*: "Require 2FA and disallow tokens".
3. 2FA enabled on the approving npm account, with publish access to the package.

### Releasing

1. Merge to `main`, set `RB_RELEASE_ENABLED=true`, approve the `release` deployment on GitHub.
2. The `publish` job stages the tarball. Its summary shows the integrity of the tarball it staged.
3. On npmjs.com open the package, *Staged Packages*, review (or `npm stage download <stage-id>` and compare with the
   GitHub artifact and `SHA256SUMS`), then **Approve** with 2FA (CLI alternative: `npm stage list relic-bridge`,
   `npm stage approve <stage-id>`; reject with `npm stage reject <stage-id>`).
4. Run the *Release* workflow again on `main` (Actions, *Run workflow*). `plan` sees the version on npm without a
   GitHub Release (mode `release`), rebuilds, checks the tarball is identical to the one on npm and creates only the
   GitHub Release `v<version>`.

### Changesets and the DB fixture of a new minor (P8-84)

- **Changesets name `relic-bridge` only.** It is the only package changesets versions: the workspace packages are
  private (`privatePackages.version: false`) and `@relic-bridge/worker` is ignored. A changeset for any of them is never
  consumed, stays in `.changeset/` and keeps `plan` in mode `version`, so nothing is published (#252).
  `node scripts/release.ts check-changesets` (part of `pnpm lint`) refuses such a changeset and names the package to use.
  If one reaches `main` anyway, `plan` prints a warning per file and fails when no pending changeset can be consumed.
- **Every published minor has a DB upgrade fixture** (`packages/storage/test/fixtures/db/v<minor>.json`, P8-05) and
  `gen-db-fixtures.ts --check` fails once the tag of a minor exists without one (#258). The version PR writes it:
  `pnpm version-packages` ends with `gen-db-fixtures.ts --next-release`, which, when the new version is a stable `X.Y.0`
  whose minor has no fixture, writes `vX.Y.json` from the migrations of the build (the tag points at the version PR's
  merge commit, so these are the migrations that ship) and rewrites `db-fixtures.generated.ts`, the list the upgrade
  tests import. The version PR is regenerated on every push to `main`, so a migration merged in the meantime lands in
  the fixture too. The release `build` job runs `gen-db-fixtures.ts --check-release <version>` and stops the release if
  the fixture of that minor is missing or records other migrations than the build (this also stops a patch release
  that adds a migration). After the tag exists, `--check` compares the fixture with the tag as before.
- Fallback, if a minor was ever published without its fixture: fetch the tags (`git fetch --tags`), run
  `pnpm db:fixtures` and commit the new `v<minor>.json` and `db-fixtures.generated.ts` in a pull request.

### Release assets and provenance (P8-54)

The GitHub Release carries `relic-bridge-<v>.tgz`, `.cdx.json`, `SHA256SUMS` and `relic-bridge-<v>.intoto.jsonl`, the
Sigstore bundle of the build provenance attestation for the first three. The `publish` job creates it with
`actions/attest` and uploads it as a release asset because OpenSSF Scorecard (Signed-Releases) only counts signature or
provenance files among the assets. Verification for users: [Verify a release](../guide/verify-release.md). Old
releases (before this change) have attestations on GitHub but no `.intoto.jsonl` asset.

### Reruns

| Situation | What happens |
| --- | --- |
| Staged, not approved, workflow rerun | `npm stage publish` is refused because the version is already staged; the step reports "already staged, awaiting approval", succeeds, stages nothing and creates no GitHub Release. |
| Approved, no GitHub Release | The next run is mode `release`, or the "Already on npm?" step finds the version: nothing is staged and only the GitHub Release is created (the tarball must match `dist.integrity`, otherwise the run stops). |
| Rejected on npmjs.com | Rerun the workflow: the version is neither staged nor on npm, so it is staged again. |
| Stage failed for another reason | The job fails with npm's output. |

The conflict error text of staging a version twice is not documented by npm; the step matches it loosely (see RESEARCH
section 6). After the first real release, confirm the wording and tighten the pattern in `release.yml` and
`scripts/test/release.test.ts`. A rerun cannot tell whether the version staged earlier has the same content as the
current build (CI cannot run `npm stage download`), so compare integrities before approving.
