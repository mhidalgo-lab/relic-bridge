---
id: P8-54
title: Signed releases - provenance attestations attached to GitHub Releases
phase: 8
status: review
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-54 — Signed releases: provenance attestations attached to GitHub Releases

## Goal
Scorecard Signed-Releases is 0: the release assets (`relic-bridge-<v>.tgz`, `.cdx.json`, `SHA256SUMS`) have no signature
or provenance file. The Docker image is signed, but this check only reads release assets.

## Scope
- In the release job that already holds the OIDC token, attest the assets (`actions/attest-build-provenance`, pinned)
  and upload the Sigstore bundle as `relic-bridge-<v>.intoto.jsonl` (Scorecard recognises `*.intoto.jsonl`).
- Keep the job free of checkout/install/project code. Document verification (`gh attestation verify`).

## Acceptance criteria
- [ ] Next release has a `.intoto.jsonl` asset that verifies against the tarball.
- [x] `scripts/test/*workflow*.test.ts` asserts the step; actionlint passes.

## Security notes
T18: no new permissions beyond `id-token: write` / `attestations: write` in the publishing job.

## Docs to update
- `docs/guide/` release verification page (or README section), `docs/THREAT_MODEL.md` T18.

## Out of scope
- Re-signing old releases.
