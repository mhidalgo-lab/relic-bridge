# Releasing: required repository settings

The release workflows (`release.yml`, `docker.yml`) assume the settings below. Workflow code cannot enforce them, so
check them once, and again after any repository transfer or settings reset. Nothing here is automated on purpose:
settings are an owner decision (THREAT_MODEL T13, T18).

## Settings the release path relies on

| Setting | Required value | Why |
| --- | --- | --- |
| Environment `release` | **Required reviewers**: at least one maintainer who is not the person who triggered the run; **prevent self-review** on. | `publish` (OIDC token, registry credentials, npm publish) waits for this approval. Without reviewers the gate is a no-op. |
| Environment `release` | **Deployment branches**: selected branches, only `main` (no tags rule, no "all branches"). | A workflow on another branch must not obtain the approval prompt or the environment's permissions. |
| Repository variable `RB_RELEASE_ENABLED` | unset or `false` until the first release is intended; then `true`. | Every release job is skipped without it. |
| Branch protection / ruleset on `main` | Pull request required, status checks required (including `Docker` and `CI`), no force push, no deletion. | The release workflows run for what is on `main`. |
| Tag ruleset `v*` | Only maintainers can create; no update, no deletion. | `plan` trusts that `v<version>` points at the released commit; image tags are immutable by convention. |
| Actions permissions | Default `GITHUB_TOKEN` read-only; "allow GitHub Actions to create pull requests" only if the release PR is used; actions pinned by SHA. | Each job declares its own permissions. |
| GHCR package `relic-bridge` | Visibility public after the first push; package settings link it to this repository; only the workflow can write. | Consumers verify signatures; nobody should push by hand. |

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
