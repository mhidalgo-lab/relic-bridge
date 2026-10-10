---
id: P0-03
title: CI pipeline
phase: 0
status: done
priority: high
depends_on: [P0-01]
adr: [0004]
owner: ""
---

# P0-03 — CI pipeline

## Goal
Every PR is linted, type-checked, tested and built on the supported runtimes.

## Scope
- GitHub Actions workflow `ci.yml`: install (frozen lockfile, cache), lint, typecheck, test, build.
- Matrix: Node current LTS + previous LTS; a Workers test job (`@cloudflare/vitest-pool-workers`) once P3 lands (placeholder job now).
- DCO check, SPDX check, Conventional Commit PR title check.
- **All actions pinned by commit SHA**; top-level `permissions: contents: read`; no `pull_request_target` with checkout of untrusted code.
- Concurrency group to cancel superseded runs.

## Acceptance criteria
- [x] CI green on a sample PR; red on a PR missing sign-off.
- [x] `permissions` least-privilege verified (no write tokens on PR builds).

## Security notes
T18 (supply chain). Document the workflow security rules in CONTRIBUTING.

## Docs to update
- CONTRIBUTING (CI section).

## Out of scope
- Release workflow (P1-15), security scanners (P0-04).

## Progress notes
- 2026-10-01: `.github/workflows/ci.yml` (Node 24 + 26 matrix, lint/typecheck/test/build/license check, DCO, PR title,
  actionlint), all actions pinned by SHA, harden-runner (audit mode), `persist-credentials: false`. actionlint passes locally.
- 2026-10-02: verified on private repo `matiashidalgo/relic-bridge` (now `mhidalgo-lab/relic-bridge`): PR #1 (unsigned commit) → DCO failed, every other
  check passed; main is green. Private-repo limits are documented in `docs/security/repo-settings.md`.
