---
id: P8-84
title: Release guards - DB fixture for a new minor and changesets for private packages
phase: 8
status: review
priority: medium
depends_on: [P8-05]
adr: []
owner: claude-agent
---

# P8-84 — Release guards: DB fixture for a new minor and changesets for private packages

## Goal
Two things blocked or broke CI around the 0.10.0 release (2026-10-15):

- Publishing `v0.10.0` made `node scripts/gen-db-fixtures.ts --check` (part of `pnpm lint`) fail on `main` and on every
  open pull request: each published minor needs a database fixture, and nothing creates one when a minor ships. Fixed by
  hand in #258; it will happen again at every minor release.
- A changeset that targeted the private `@relic-bridge/core` package (P8-60) is never consumed by changesets, so it
  stayed pending after the Version PR and `release.ts plan` kept returning `mode=version`: the publish was skipped until
  the file was removed by hand (#252).

## Scope
- The fixture: the Version PR for a new minor (or the release job, before tagging) generates and commits
  `packages/storage/test/fixtures/db/v<minor>.json` and registers it in `packages/storage/test/upgrade.ts`; or the check
  treats the newest published minor whose fixture is missing as a warning until the next Version PR adds it. Pick one and
  document it in `docs/dev/releasing.md`.
- Changesets: `pnpm lint` (or a dedicated check) refuses a changeset that names a private workspace package or a
  package changesets ignores, with a message naming the published package to use instead. Test with fixtures.
- `release.ts plan`: when changesets are pending but none of them can produce a version bump, say so instead of silently
  staying in `version` mode.

## Acceptance criteria
- [x] A new minor release cannot leave `main` failing the fixture check (test or documented step that is automated).
- [x] A changeset for a private package fails CI with a clear message (tests).
- [x] `release.ts plan` reports changesets that cannot be consumed (tests).

## Security notes
None (release tooling); the release job keeps its permissions (THREAT_MODEL T18 unchanged unless the job gains a write).

## Docs to update
- `docs/dev/releasing.md`, `.changeset/README.md`.

## Out of scope
- Changing the changesets configuration for private packages.

## Outcome
- Fixture: the **version PR** writes it. `pnpm version-packages` ends with `gen-db-fixtures.ts --next-release`: for a
  stable `X.Y.0` whose minor has no fixture it writes `vX.Y.json` from the build's migrations (the tag points at the
  version PR's merge commit, so they are what ships; the PR is regenerated on every push to `main`). The fixture list the
  upgrade tests import is now generated (`packages/storage/test/db-fixtures.generated.ts`, checked by `--check`), so
  nothing is registered by hand in `upgrade.ts`. The release `build` job runs `--check-release <version>` before
  packing: a missing or stale fixture (or a patch that adds a migration) stops the release instead of breaking `main`
  after the tag. Chosen over "warn until the next version PR" because the check stays strict and nothing depends on a
  follow-up commit.
- 0.11.0: the open version PR (#259) is regenerated when this lands on `main` and then contains `v0.11.json`. If #259 is
  merged first, 0.11.0 ships the old way and the documented fallback (`pnpm db:fixtures` after the tag) applies once.
- Changesets: `release.ts check-changesets` runs in `pnpm lint`; `plan` warns per changeset it cannot consume and fails
  when none of the pending ones can be consumed.
