---
id: P8-36
title: nerdgraph:schema creates its snapshot folder on the first run
phase: 8
status: done
priority: high
depends_on: [P8-32]
adr: []
owner: claude-agent
---

# P8-36 — nerdgraph:schema creates its snapshot folder on the first run

## Goal
The owner's first `pnpm nerdgraph:schema` run fetched the schema but failed writing it:
`ENOENT … scripts/fixtures/nerdgraph-schema.json.gz`. `scripts/fixtures/` does not exist until the first snapshot.

## Scope
- Create the snapshot's folder before writing; regression test writing into a folder that does not exist yet.

## Acceptance criteria
- [x] Test fails before the fix and passes after.
- [ ] Owner's run writes the snapshot (verified after merge).

## Security notes
None (dev tooling; the key handling is unchanged).

## Docs to update
- None.

## Out of scope
- The snapshot itself (owner run, committed separately).
