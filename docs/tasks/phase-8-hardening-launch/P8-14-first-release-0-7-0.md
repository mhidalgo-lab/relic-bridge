---
id: P8-14
title: Number the first published release 0.7.0
phase: 8
status: done
priority: high
depends_on: [P8-13]
adr: []
owner: claude-agent
---

# P8-14 — Number the first published release 0.7.0

## Goal
Owner decision (2026-10-10): the first npm/GitHub release covers everything through Phase 7, so it is **0.7.0**, not
the 0.2.0 that Changesets proposed in Version PR #178. 0.1.0-0.6.x were never published.

## Scope
- Consume the pending changesets (`pnpm version-packages`), then set `apps/cli/package.json` to 0.7.0 and sync
  `packages/core/src/version.ts` and `server.json` (`release.ts sync-version`); Claude Code plugin manifest to 0.7.0.
- `apps/cli/CHANGELOG.md`: one `0.7.0` entry ("first published release"); the old `0.1.0` entry is marked as never
  published.
- Close Version PR #178 (superseded).

## Acceptance criteria
- [x] No pending changesets; CLI, core `VERSION`, `server.json` and plugin say 0.7.0; `sync-version --check` passes.
- [x] `release.ts notes 0.7.0` returns the new entry; `release.ts plan` reports `mode=publish`, `version=0.7.0`
      (publishing stays gated by `RB_RELEASE_ENABLED` and the `release` environment).

## Security notes
None (no workflow or gate change; T18 gates unchanged).

## Docs to update
- `docs/pending-decisions/owner-checklist.md` §1 (version item done).

## Out of scope
- Publishing (owner checklist §1).
