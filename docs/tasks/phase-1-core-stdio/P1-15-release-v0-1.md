---
id: P1-15
title: Release pipeline and v0.1.0
phase: 1
status: todo
priority: high
depends_on: [P1-11, P1-12, P1-14]
adr: [0003]
owner: ""
---

# P1-15 — Release pipeline and v0.1.0

## Scope
- Changesets release workflow: version PR → publish on merge.
- npm publish with **provenance** (OIDC trusted publishing, no long-lived npm token).
- GitHub Release with changelog; tag protection.
- `relic-bridge` package contains only built files (`files` allowlist); verify tarball contents in CI (`npm pack --dry-run`).

## Acceptance criteria
- [ ] v0.1.0 on npm with provenance badge; install + quickstart verified on macOS, Windows, Linux.

## Security notes
T18: trusted publishing, protected environment with required reviewer.

## Docs to update
- CHANGELOG, README install section.

## Out of scope
- Docker (P2-11).
