---
id: P8-115
title: Hold lefthook 2.2.2 (published without provenance)
phase: 8
status: done
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-115 — Hold lefthook 2.2.2 (published without provenance)

## Goal
Renovate's grouped dev-dependency PR (#332) cannot update the lockfile: pnpm (`trustPolicy: no-downgrade`) refuses
`lefthook@2.2.2` as a "high-risk trust downgrade (possible package takeover)". `2.2.1` was published by GitHub Actions
(npm trusted publishing, provenance attestation); `2.2.2` was published by hand from a maintainer account with no
attestation, 27 minutes after the project's CI made the GitHub release. Most likely a manual publish after a failed CI
step, but that cannot be verified, and lefthook runs on every local commit.

## Scope
- `renovate.json`: a rule that excludes `lefthook` 2.2.2 (`allowedVersions: "!/^2\\.2\\.2$/"`), so the rest of the
  dev-dependency group can update and the next lefthook release is offered as usual.
- Keep `trustPolicy: no-downgrade` as is.

## Acceptance criteria
- [x] Renovate config excludes lefthook 2.2.2 only.
- [x] Renovate regenerates #332 without lefthook 2.2.2 and its checks pass.

## Security notes
THREAT_MODEL T18 (dependencies / supply chain): the pnpm trust policy worked as intended; this keeps the repo on the
attested 2.2.1.

## Docs to update
- None.

## Out of scope
- Removing the hold: drop the rule once a later lefthook release is published with provenance.
