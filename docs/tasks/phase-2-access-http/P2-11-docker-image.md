---
id: P2-11
title: Docker image (signed, SBOM)
phase: 2
status: todo
priority: medium
depends_on: [P2-06, P2-02]
adr: []
owner: ""
---

# P2-11 — Docker image

## Scope
- `Dockerfile` (repo root), multi-stage: a build stage (Node 24 slim, pnpm from `packageManager`) runs the release build
  (`RB_TEST_HOOKS=0`) and `pnpm deploy --prod` of `apps/cli`; the runtime stage is distroless Node 24 (`:nonroot`,
  uid 65532, no shell, no package manager). Both base images are pinned by digest (Renovate keeps them current).
- Read-only root FS compatible: the only writable path is the `/data` volume (`RB_DATA_DIR=/data`, SQLite). Defaults for
  the container: `RB_HOST=0.0.0.0` (clients must still set `RB_ALLOWED_HOSTS`), port 8787.
- `HEALTHCHECK` through Node (`/health`), OCI labels, no secrets in layers, `.dockerignore`.
- Master key / admin token only through `RB_MASTER_KEY[_FILE]` / `RB_ADMIN_TOKEN[_FILE]` at run time. The 0600 key-file
  check stays on (P2-03); the guide says how to satisfy it in Docker and Kubernetes.
- Workflow `.github/workflows/docker.yml`: on pull requests, build for amd64 and arm64 without pushing, Trivy scan
  (high/critical fail) and a smoke test (`serve` starts, `/health` answers). On `main`/release only, behind the same
  gates as the npm release (`RB_RELEASE_ENABLED`, protected `release` environment): multi-arch build and push to GHCR by
  digest, SBOM (syft, SPDX/CycloneDX) and provenance attestations, cosign keyless signature (OIDC).
- `docker-compose.example.yml` with Caddy for TLS (`deploy/`).
- Self-hosting guide: Docker section, signature/SBOM verification commands.

## Acceptance criteria
- [ ] Dockerfile builds; image runs as non-root with a read-only root FS and `/data` volume; `serve` starts and
  `/health` answers (verified locally).
- [ ] Base images pinned by digest; no secrets in layers; `.dockerignore` present; HEALTHCHECK and OCI labels set.
- [ ] CI builds the image (amd64, arm64) on pull requests without pushing; Trivy fails on high/critical.
- [ ] Release workflow builds, scans, creates the SBOM, signs (cosign keyless) and pushes to GHCR only from `main`
  behind `RB_RELEASE_ENABLED` and the protected `release` environment; actionlint passes.
- [ ] `docker-compose.example.yml` with Caddy; self-hosting guide Docker section with the verification commands.
- [ ] Key-file permission handling in containers documented (decision logged).
- [ ] Trivy scan clean of high/critical; signature verifiable with the documented command (confirmed on the first
  real release; not possible before anything is published).

## Security notes
T18.

## Docs to update
- Self-hosting guide (Docker section).

## Out of scope
- Helm chart (consider post-1.0).
