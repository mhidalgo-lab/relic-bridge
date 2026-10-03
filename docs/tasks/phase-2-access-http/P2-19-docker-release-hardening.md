---
id: P2-19
title: Docker release hardening and an end-to-end image smoke test
phase: 2
status: todo
priority: medium
depends_on: [P2-11]
adr: []
owner: ""
---

# P2-19 — Docker release hardening and an end-to-end image smoke test

Found by the Phase 2 consolidation review (`docs/reviews/phase-2-review.md`, M3/M4/L1/L2). The image and the
workflow are well built (digest-pinned bases, distroless non-root, SHA-pinned actions, signing in a job that runs no
project code), but a few release properties are not enforced and the image has never been exercised in CI.

## Goal
`:latest` only ever moves forward, the release path is protected by settings the docs require, and every PR proves
the built image starts, serves `/health` and answers MCP behind its own `Host` allowlist.

## Scope
- `docker.yml`: move `:latest` only when the version is the highest non-prerelease release (a re-run for an older tag
  must not roll it back); test in `scripts/test/docker-workflow.test.ts`.
- Scan the arm64 image too (or document why the amd64 scan covers it).
- A test that no `run:` step interpolates `${{ github.event... }}` / `${{ github.head_ref }}`.
- A PR job (no secrets, no push) that runs the built image with a throwaway master key and checks `/health`, a `403`
  for a foreign `Host`, `db backup` through `docker exec`, and that the root filesystem is read-only.
- Docs: the `release` environment must have required reviewers and a `main`-only deployment rule; pin images by
  digest rather than `:latest`; compose `depends_on: condition: service_healthy` for Caddy.

## Acceptance criteria
- [ ] Workflow tests cover the `:latest` rule and the injection rule.
- [ ] The image smoke job is green on a PR.
- [ ] `docs/guide/self-hosting.md` and `docs/dev/` describe the required repository settings.

## Security notes
T18 (supply chain), T13 (deployment hardening).

## Docs to update
- `docs/guide/self-hosting.md`, `deploy/docker-compose.example.yml`, `CONTRIBUTING.md` (release settings).

## Out of scope
- Publishing the first image (owner step).
