---
id: P8-70
title: Renovate bumps pinned CI tool versions with their digests, and groups site deps
phase: 8
status: todo
priority: low
depends_on: [P8-07]
adr: []
owner: ""
---

# P8-70 — Renovate bumps pinned CI tool versions with their digests, and groups site deps

## Goal
`ACTIONLINT_VERSION` (`ci.yml`, job `actionlint`) and `GITLEAKS_VERSION` (`security.yml`, job `gitleaks`) are plain
environment variables that Renovate does not see, so they go stale. The workflows also download the checksum file from the
same release as the tarball (`sha256sum -c` against `…_checksums.txt`), which only detects a corrupted download. P8-07 asks
for the expected sha256 to be pinned in the workflow. This task makes that pin maintainable: Renovate must change the
version and the digest in one PR.

## Scope
- Pin the expected sha256 of each tarball in the workflow next to its version (if P8-07 has not already done so, reuse its
  format) and verify against the pinned value.
- A Renovate custom regex manager (`customManagers` in `renovate.json`) for both tools with the `github-releases`
  datasource that updates version and digest together (the digest comes from the release's checksum file). If Renovate
  cannot fetch the digest itself, add a small script under `scripts/` plus a CI check that version and digest agree.
- A package rule grouping the docs-site dependencies into one PR. The `site/` directory (P8-04) does not exist on `main`
  yet: add the rule against the path the site package actually gets, or leave this part until P8-04 lands.
- A test in `scripts/test/` that parses the workflows and asserts each pinned tool has a 64-hex digest.

## Acceptance criteria
- [ ] Both tools have version and sha256 pinned in the workflows, and the check uses the pinned value.
- [ ] `renovate.json` validates (`renovate-config-validator`) and the dependency dashboard or a dry run proposes a bump that
      changes version and digest together (leave unticked until Renovate has run).
- [ ] Site dependencies are grouped (rule present against a real path).
- [ ] Test for the digest format passes.

## Security notes
T18. The digest must come from the upstream checksum file of that release, never computed from a download in the same job.
`minimumReleaseAge` (3 days) stays in force for these managers.

## Docs to update
- `CONTRIBUTING.md` or `docs/dev/releasing.md` (how tool pins are bumped), `docs/THREAT_MODEL.md` (T18 row) if the
  mechanism changes.

## Out of scope
- Other downloaded tools; replacing the tools.
