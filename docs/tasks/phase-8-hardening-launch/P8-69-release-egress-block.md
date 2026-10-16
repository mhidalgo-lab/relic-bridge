---
id: P8-69
title: Release jobs egress policy block
phase: 8
status: review
priority: low
depends_on: [P8-07]
adr: []
owner: claude-agent
---

# P8-69 — Release jobs egress policy block

## Goal
Every `step-security/harden-runner` step in `release.yml` and `docker.yml` runs with `egress-policy: audit`. Once the real
set of endpoints is known, the publish jobs should block everything else so a compromised step cannot send the OIDC token
or build output elsewhere.

**Start after the next release.** The allowlist comes from the audit data of a real release run.

## Scope
- After the next release run, read the harden-runner audit of each job (StepSecurity insights for that run) and list the
  endpoints per job.
- Switch the publish jobs of `release.yml` and `docker.yml` to `egress-policy: block` with `allowed-endpoints`. Plan and
  build jobs may stay on `audit` if their endpoint set is unstable; decide from the data.
- Keep the lists in the workflow files with a comment per endpoint class (registry, GitHub API, Sigstore, npm).
- A test in `scripts/test/` that fails if a publish job returns to `audit` or allows a wildcard.

## Acceptance criteria
- [x] Allowlist derived from a real run; hosts recorded in the PR description.
- [ ] The first release after the change passes (leave unticked until a release has run with `block`).
- [x] Test asserts `block` on the publish jobs.

## Security notes
T18. A list that is too tight breaks a release at the worst moment: document `audit` as the fallback in
`docs/dev/releasing.md`, and never add a broad wildcard to get a run through.

## Docs to update
- `docs/dev/releasing.md`, `docs/THREAT_MODEL.md` (T18 row).

## Out of scope
- Pull-request CI jobs; repository-wide egress control.

## Evidence (0.10.0 release, 2026-10-15)
harden-runner (agent v0.16.3, audit mode) printed its agent log in the *Post* step of each job; `endpoint called`
lines name the host and the process. Runs: release.yml 38676388739 (mode `publish`: staged on npm) and 38677640166 (mode
`release`: GitHub Release created), docker.yml 38678194338 (image pushed, signed, attested).

| Job | Endpoint (process seen) | Class |
| --- | --- | --- |
| `release.yml` `publish` | `api.github.com` (gh, node) | GitHub API: tag check, release lookup, attestations |
| | `uploads.github.com` (gh) | GitHub Release asset upload (mode `release` run only) |
| | `token.actions.githubusercontent.com` (node) | OIDC token |
| | `registry.npmjs.org` (node) | `npm view`, `npm stage publish` |
| | `fulcio.sigstore.dev`, `rekor.sigstore.dev` (node) | Sigstore: `actions/attest`, npm provenance |
| `docker.yml` `publish` | `ghcr.io` (dockerd, skopeo, cosign, node), `pkg-containers.githubusercontent.com` (dockerd, skopeo, cosign) | GHCR and its blob storage |
| | `github.com`, `release-assets.githubusercontent.com` (curl) | cosign and syft binaries downloaded by `cosign-installer` / `sbom-action` |
| | `raw.githubusercontent.com` (node) | `sbom-action` installer script |
| | `api.github.com` (node), `token.actions.githubusercontent.com` (node) | GitHub API, OIDC token |
| | `fulcio.sigstore.dev`, `rekor.sigstore.dev`, `timestamp.sigstore.dev`, `tuf-repo-cdn.sigstore.dev` (cosign, node) | Sigstore: keyless signing, attestations, trust root |
| both | `results-receiver.actions.githubusercontent.com`, `run-actions-*.actions.githubusercontent.com`, `productionresultssa*.blob.core.windows.net` | Artifact download and job results: allowed implicitly by harden-runner (hard-coded GitHub Actions endpoints), not listed |

## Outcome
- `publish` in both workflows: `egress-policy: block` with exactly those hosts on 443. Plan, version and build jobs stay
  on `audit` (dependency and image builds, unstable endpoint set).
- harden-runner allows GitHub Actions endpoints implicitly (`*.actions.githubusercontent.com`,
  `productionresultssa*.blob.core.windows.net`, results receiver, `codeload.github.com`, plus the GitHub meta domains
  it fetches), so artifact download needs no entry. The GitHub API hosts are still listed explicitly in case the meta
  fetch fails.
- `scripts/test/workflow-hardening.test.ts`: the publish jobs must block with exactly these lists (hosts on 443, no
  wildcard), and only and all `id-token: write` jobs block.
- Not covered by the evidence: a `setup-node` that has to download Node (the runner image had Node 24 cached) and the
  "already staged" rerun path (same hosts as the stage path). If either is blocked, follow the procedure in
  `docs/dev/releasing.md`.
