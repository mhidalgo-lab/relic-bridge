---
id: P1-15
title: Release pipeline and v0.1.0
phase: 1
status: in-progress
priority: high
depends_on: [P1-11, P1-12, P1-14]
adr: [0003]
owner: "claude-agent"
---

# P1-15 — Release pipeline and v0.1.0

## Scope
- Changesets for versioning: a pending changeset on `main` opens/updates a "Version Packages" PR
  (`changesets/action/version`); merging it leaves no changesets and an unpublished version, which triggers publish.
- Only the `relic-bridge` CLI package (`apps/cli`) is published. Internal workspace packages are marked `private` so no
  tool publishes them by accident (`@relic-bridge/core` is bundled into the CLI, P1-11).
- Publish job (`.github/workflows/release.yml`): `main` only, behind a protected GitHub environment (`release`, required
  reviewer) **and** an opt-in repository variable (`RB_RELEASE_ENABLED=true`), so the workflow cannot publish before the
  owner configures it. npm **trusted publishing** (OIDC, no npm token) with `--provenance`; no dependency cache in the
  release job.
- Release artifacts: the exact tarball published to npm, a CycloneDX SBOM (`pnpm sbom`), `SHA256SUMS`, and a GitHub
  build-provenance attestation (Sigstore) for all three; attached to a GitHub Release `v<version>` whose notes come from
  the CHANGELOG entry.
- Package checks (`scripts/check-package.ts`, run in CI after the build): pack the CLI with `pnpm pack`; the tarball holds
  only `dist/index.mjs`, `package.json`, `README.md`, `LICENSE`, `NOTICE`; `LICENSE`/`NOTICE` equal the repo root's;
  bin points at an executable file with a shebang; no `workspace:` ranges or install scripts; no secret-shaped strings;
  version matches `VERSION` in core; installing the tarball and running `relic-bridge --version` works; the packed build
  refuses `RB_TEST_NERDGRAPH_URL` (test hooks compiled out).
- `VERSION` in `packages/core/src/version.ts` synced from the CLI's `package.json` by the version script, checked by
  `pnpm lint`.
- Prepare v0.1.0: version bump to `0.1.0` and `apps/cli/CHANGELOG.md`; dry-run locally (`pnpm pack`,
  `npm publish --dry-run` on the tarball, packed-tarball run).

## Acceptance criteria
- [ ] Release workflow pinned by SHA, harden-runner, least-privilege per-job permissions, no untrusted expression
      interpolation in `run:`; triggers only on push to `main` / `workflow_dispatch` (never on pull requests); actionlint
      clean.
- [ ] `scripts/check-package.ts` with unit tests for its pure checks; runs in CI after `pnpm build`.
- [ ] Version sync script + lint check; `pnpm version-packages` = `changeset version` + sync.
- [ ] v0.1.0 prepared (version, CHANGELOG, README install section) and dry-run locally: tarball contents verified,
      `npm publish --dry-run` passes, packed CLI runs via `npx`-style install.
- [ ] v0.1.0 on npm with provenance badge; install + quickstart verified on macOS, Windows, Linux. *(owner: requires
      the npm trusted publisher, the `release` environment and an actual release; see pending decisions)*

## Security notes
T18: trusted publishing (OIDC), protected environment with required reviewer, opt-in variable, provenance + Sigstore
attestation, SBOM and checksums, no cache in the release job, tag protection (owner configures a ruleset for `v*`).

## Docs to update
- `apps/cli/CHANGELOG.md`, README install section, `docs/RESEARCH.md` (npm trusted publishing facts),
  `docs/THREAT_MODEL.md` (T18), `CONTRIBUTING.md` (release process), pending decisions.
- After the real publish (owner): drop the "pre-release, use `node …/dist/index.mjs`" notes in
  `docs/guide/quickstart-local.md` and `docs/guide/clients.md`.

## Out of scope
- Docker image and its signing (P2-11).
- Actually publishing, creating tags/releases, configuring npm or repository settings (owner).
