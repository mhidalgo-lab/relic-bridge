---
id: P2-19
title: Docker release hardening and an end-to-end image smoke test
phase: 2
status: done
priority: medium
depends_on: [P2-11]
adr: []
owner: claude-agent
---

# P2-19 — Docker release hardening and an end-to-end image smoke test

Found by the Phase 2 consolidation review (`docs/reviews/phase-2-review.md`, M3/M4/L1/L2). The image and the
workflow are well built (digest-pinned bases, distroless non-root, SHA-pinned actions, signing in a job that runs no
project code), but a few release properties are not enforced and the image has never been exercised in CI.

## Goal
`:latest` only ever moves forward, the release path is protected by settings the docs require, and every PR proves
the built image answers MCP and the documented operator commands.

## Scope
- `docker.yml`: move `:latest` only when the version is the highest non-prerelease release (a re-run for an older tag
  must not roll it back); test in `scripts/test/docker-workflow.test.ts`.
- Scan the arm64 image too (or document why the amd64 scan covers it).
- A test that no `run:` step interpolates `${{ github.event... }}` / `${{ github.head_ref }}`.
- Extend `scripts/docker-smoke.sh` (the review already added the foreign-`Host` `403` and `db backup` through
  `docker exec`): create a project and token with the CLI in the container and answer an MCP `tools/list` through the
  image; run the compose example with a local Caddy (internal CA) once.
- Docs: the `release` environment must have required reviewers and a `main`-only deployment rule; pin images by
  digest rather than `:latest`; compose `depends_on: condition: service_healthy` for Caddy.

## Acceptance criteria
- [x] Workflow tests cover the `:latest` rule and the injection rule (`scripts/test/docker-workflow.test.ts`, plus the
  arm64 scan and the compose `service_healthy` dependency).
- [x] The image smoke job is green on a PR (the extended smoke test passes locally against a freshly built image; see
  the PR checks for the CI run).
- [x] `docs/guide/self-hosting.md` and `docs/dev/releasing.md` describe the required repository settings
  (`CONTRIBUTING.md` links to it).
- [ ] Publish-dependent, left for the owner: the settings themselves (reviewers, `main`-only deployment rule) are not
  applied by this task, and the `:latest` rule has run only in tests, not in a real release.

## Security notes
T18 (supply chain), T13 (deployment hardening).

## Docs to update
- `docs/guide/self-hosting.md`, `deploy/docker-compose.example.yml`, `CONTRIBUTING.md` (release settings).

## Out of scope
- Publishing the first image (owner step).

## Implementation notes
- `:latest`: `plan` outputs `latest` (highest stable semver among published Releases); `publish` no longer reads the
  prerelease flag.
- arm64: cross-built into a docker archive and scanned with Trivy (`input:`) in PR and release builds. Trivy cannot
  read a multi-arch OCI archive, so for releases this is a rebuild of the same inputs (pending-decisions entry).
- Injection test covers every workflow: no `run:` interpolates `github.event.*`, `head_ref`, `ref_name`, `inputs.*`
  or step/job outputs.
- Smoke test: `credential add` validates the key against NerdGraph and the release image has no endpoint override, so
  the script runs a local HTTPS stand-in as `api.newrelic.com` on a private docker network and trusts its throwaway
  certificate with `NODE_EXTRA_CA_CERTS`. Everything else goes through the image: CLI setup, MCP `initialize` and
  `tools/list` with the device token, `401` without it.
- Compose with Caddy: run once locally (internal CA, image built here): `/health` answered over TLS and Caddy waited
  for the healthy server. Not automated.
