# Changesets

Run `pnpm changeset` in any PR that changes a published package. See https://github.com/changesets/changesets.

Only `relic-bridge` (`apps/cli`) is published, so a changeset names `"relic-bridge"` and nothing else. The workspace
packages (`@relic-bridge/core`, `@relic-bridge/storage`, ...) are private and `@relic-bridge/worker` is ignored: a
changeset for one of them is never consumed and blocks publishing, so `pnpm lint` refuses it
(`node scripts/release.ts check-changesets`, P8-84). Describe a change to an internal package in the `relic-bridge`
changeset when users of the CLI or the server notice it; CI-only and docs-only changes need no changeset.
