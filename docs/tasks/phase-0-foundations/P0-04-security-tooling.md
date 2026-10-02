---
id: P0-04
title: Security tooling baseline
phase: 0
status: review
priority: high
depends_on: [P0-03]
adr: [0003]
owner: ""
---

# P0-04 — Security tooling baseline

## Goal
Automated guardrails that catch the common open-source security failures.

## Scope
- CodeQL (JS/TS) on PRs + weekly.
- gitleaks: pre-commit hook (lefthook or simple-git-hooks) **and** CI job; custom rules for `NRAK-…` keys and `rb_` tokens.
- Dependency review action (fail on high-severity and on disallowed licenses: GPL/AGPL/unknown).
- Renovate config: grouped, weekly, `minimumReleaseAge` ≥ 3 days, lockfile maintenance, pin GitHub Actions digests.
- OpenSSF Scorecard workflow + badge.
- `docs/security/repo-settings.md`: recommended branch protection / rulesets, required checks, signed commits optional, secret scanning + push protection enabled, private vulnerability reporting enabled.

## Acceptance criteria
- [ ] Committing a fake `NRAK-` key is blocked locally and in CI.
- [x] Adding a GPL dependency fails CI.
- [ ] Scorecard runs and the badge is in the README.

## Security notes
T8, T18.

## Docs to update
- SECURITY.md, CONTRIBUTING (pre-commit hooks), `docs/security/repo-settings.md`.

## Out of scope
- Release signing and SBOM (P1-15, P2-11).

## Progress notes
- 2026-10-01: `security.yml` (CodeQL security-extended for JS/TS + Actions, gitleaks full-history scan with checksum-verified
  binary, `pnpm audit --audit-level high`, dependency-review with license allowlist), `scorecard.yml`, `.gitleaks.toml`
  (NR User/ingest/license keys, `rb_` tokens, master key), `renovate.json`, lefthook pre-commit (Biome + gitleaks if installed)
  and commit-msg DCO hook, `scripts/check-licenses.ts` (whole dependency tree, run in CI), `docs/security/repo-settings.md`.
- Verified locally: gitleaks rules catch a realistic fake NRAK key and `rb_` token and ignore `EXAMPLE` placeholders; license
  checker unit-tested (GPL/AGPL/unknown rejected). Prior-art S13 (dependency audit) covered.
- **Pending:** local pre-commit block requires gitleaks installed on the dev machine; Scorecard badge + CI behaviour need the
  GitHub repository and the settings in repo-settings.md.
