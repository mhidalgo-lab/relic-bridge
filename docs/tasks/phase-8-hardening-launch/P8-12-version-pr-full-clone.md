---
id: P8-12
title: Full-history checkout for the release Version PR job
phase: 8
status: done
priority: high
depends_on: [P1-16]
adr: []
owner: claude-agent
---

# P8-12 — Full-history checkout for the release Version PR job

## Goal
The first run of `release.yml` on `main` (after all phases landed) failed in `Version PR`: `changeset version`
deepens the shallow clone with `git fetch` (`@changesets/git` `deepenCloneBy`), which has no credentials because the
checkout uses `persist-credentials: false`, and the repository is private (`could not read Username`).

## Scope
- `version` job: `fetch-depth: 0` so no fetch is needed; keep `persist-credentials: false` (pushes go through the
  GitHub API).

## Acceptance criteria
- [x] `version` job checks out full history without persisted credentials; release workflow tests pass.
- [x] After merge (and once the setting was enabled), the `Version PR` job on `main` opens (or updates) the version PR — needs the repository setting
      "Allow GitHub Actions to create and approve pull requests" (owner checklist §1). Version PR #178 was opened.

## Security notes
T18: no credential is persisted; the job's permissions are unchanged.

## Docs to update
- None.

## Out of scope
- Releasing.
