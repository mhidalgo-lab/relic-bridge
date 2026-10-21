---
id: P8-114
title: Clear the failing dependency audit (vite and launch-editor, GHSA-587h-7wmj-h5pm)
phase: 8
status: review
priority: high
depends_on: []
adr: []
owner: claude-agent
---

# P8-114 — Clear the failing dependency audit (vite and launch-editor, GHSA-587h-7wmj-h5pm)

## Goal
Since 2026-10-21 the `Dependency audit` job (`pnpm audit --audit-level high`) fails on every PR: GHSA-587h-7wmj-h5pm
(`launch-editor` <= 2.14.1, existence check bypass on Windows) reaches the repo through `@changesets/cli` and through
`vite` 8.3.0 to 8.3.2 (vitest, astro).

## Scope
- Refresh the lockfile to the first patched releases inside the existing ranges (`vite` 8.3.4, `launch-editor`
  2.14.2). No manifest change and no override needed.

## Runtime reachability
Both are dev dependencies only (test runner, docs site build, changesets CLI). No shipped artifact (CLI bundle, Docker
image, Worker bundle) contains them.

## Acceptance criteria
- [x] `pnpm audit --audit-level high` reports no known vulnerabilities.
- [x] Tests run on the updated vite.

## Security notes
THREAT_MODEL T18 (dependencies): dev-only, no runtime exposure.

## Docs to update
- None (no changeset: dev dependencies only).

## Out of scope
- The Renovate dev-dependency PR (#332).
