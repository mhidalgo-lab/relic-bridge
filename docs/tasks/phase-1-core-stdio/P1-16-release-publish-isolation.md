---
id: P1-16
title: Isolate the OIDC publish step and make release reruns idempotent
phase: 1
status: done
priority: high
depends_on: [P1-15]
adr: []
owner: claude-agent
---

# P1-16 — Isolate the OIDC publish step and make release reruns idempotent

## Goal
Before the first npm publish, make sure no dependency, install script or test can ever run with the `id-token: write`
permission that npm trusted publishing relies on. Also make a failed release safe to rerun. Found in the Phase 1
consolidation review (`docs/reviews/phase-1-review.md`, M1 and M3).

## Scope
- Split the `publish` job in `.github/workflows/release.yml` in two:
  - `build`: `contents: read` only, no `id-token`. Runs install, lint, typecheck, test, build, `pnpm pack`,
    `check-package`, SBOM and `SHA256SUMS`, then uploads them as a workflow artifact.
  - `publish`: `id-token: write`, `attestations: write`, `contents: write`, environment `release`. No checkout of
    dependencies and no `pnpm install`. Downloads the artifact, checks `SHA256SUMS`, attests, runs
    `npm publish <tgz> --provenance` and creates the GitHub Release.
- Idempotent reruns: `scripts/release.ts plan` (or a new `release` mode) detects "version on npm but no GitHub
  Release / tag" and lets the workflow create only the missing release. Tests for it in `scripts/test/release.test.ts`.
- Tag safety: fail when tag `v<version>` already exists and points at a commit other than `GITHUB_SHA`.

## Acceptance criteria
- [x] No job that runs `pnpm install` or project scripts has `id-token: write` (actionlint passes; a script check or
      test asserts it on `release.yml`).
- [x] The publish job verifies the artifact checksum before publishing.
- [x] Rerunning after a failed `gh release create` creates the release without republishing.
- [x] An existing `v<version>` tag on another commit stops the release.
- [x] `docs/dev/release.md` (or the release section of CONTRIBUTING.md) describes the two jobs.

## Security notes
T18 (malicious dependency / compromised Action): an OIDC token minted by a compromised install script could publish
through trusted publishing. Update THREAT_MODEL T18 row and §5a.

## Docs to update
- `docs/THREAT_MODEL.md` (T18), CONTRIBUTING.md release section, `docs/pending-decisions/phase-1.md` owner steps.

## Notes
- The tag check lives in `scripts/release.ts plan` and again in the `publish` job (no checkout there, so it is a short
  `gh api` loop) because a tag could appear while the deployment waits for approval.
- "Re-run failed jobs" reuses the old `plan` outputs (mode `publish`), so `publish` also asks npm at runtime and
  skips `npm publish` when the identical tarball is already there.
- `scripts/test/release.test.ts` parses `release.yml` and asserts the OIDC rules (only `publish` has `id-token`, no
  checkout/pnpm/node/npm scripts in it, `--ignore-scripts`, checksum verification before attest and publish).

## Out of scope
- harden-runner block mode and other CI hardening (P8-07).
