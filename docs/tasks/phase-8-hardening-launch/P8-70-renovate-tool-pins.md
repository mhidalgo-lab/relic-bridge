---
id: P8-70
title: Renovate bumps pinned CI tool versions with their digests, and groups site deps
phase: 8
status: review
priority: low
depends_on: [P8-07]
adr: []
owner: claude-agent
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
- [x] Both tools have version and sha256 pinned in the workflows, and the check uses the pinned value.
- [x] `renovate.json` validates (`renovate-config-validator`) and the dependency dashboard or a dry run proposes a bump that
      changes version and digest together (leave unticked until Renovate has run).
- [x] Site dependencies are grouped (rule present against a real path).
- [x] Test for the digest format passes.

## Security notes
T18. The digest must come from the upstream checksum file of that release, never computed from a download in the same job.
`minimumReleaseAge` (3 days) stays in force for these managers.

## Docs to update
- `CONTRIBUTING.md` or `docs/dev/releasing.md` (how tool pins are bumped), `docs/THREAT_MODEL.md` (T18 row) if the
  mechanism changes.

## Out of scope
- Other downloaded tools; replacing the tools.

## Outcome
- The pins from P8-07 stay; the version is now the release tag (`v1.7.12`, `v8.30.1`) because Renovate's
  `github-release-attachments` datasource looks the digest up by tag. The install steps strip the `v` for the file name.
- `renovate.json`: one `customManagers` regex for `.github/workflows/*.yml` that reads a
  `# renovate: datasource=github-release-attachments depName=<owner>/<repo>` comment, `<TOOL>_VERSION` and
  `<TOOL>_SHA256`. The datasource finds the current digest in the current release's checksums file (assets < 5 KiB)
  and reads the new one from the same file of the new release, so the digest never comes from a download in CI.
  Package rule `docs site` groups `site/package.json`; tool updates get the `ci` label. `:gitSignOff` added so Renovate
  commits carry `Signed-off-by` (the required DCO check). The global 3-day `minimumReleaseAge` applies.
- Validation: `renovate-config-validator --strict` (Renovate 44.164.2) passes. Local lookup (`renovate --platform=local`,
  scratch copy with actionlint set back to `v1.7.11` and its upstream digest) proposed `v1.7.12` with
  `newDigest` `8aca8db9…a3d8`, exactly the pinned value from upstream `actionlint_1.7.12_checksums.txt`; gitleaks
  `v8.30.1` had no update. Renovate is not installed on the repository yet (owner installs the app after merge).
