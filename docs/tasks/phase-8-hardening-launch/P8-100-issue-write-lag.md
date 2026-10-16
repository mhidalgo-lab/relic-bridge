---
id: P8-100
title: Note New Relic's read lag after acknowledge_issue and close_issue
phase: 8
status: done
priority: low
depends_on: []
adr: []
owner: claude-agent
---

# P8-100 — Note New Relic's read lag after acknowledge_issue and close_issue

## Goal
The first live test of `acknowledge_issue` and `close_issue` (sandbox, 2026-10-16) passed, but New Relic's issue reads
trailed the acknowledge: reads within about 2 seconds still showed the issue unacknowledged, and a lookup by id showed
`state: CREATED` while the list showed `ACTIVATED`. A dry run or read right after a write can therefore mislead an agent.

## Scope
- An applied acknowledge or close carries a note (text and `structuredContent.note`) that New Relic can take a few
  seconds to show the change.
- Record the observed behaviour in `docs/RESEARCH.md`.

## Acceptance criteria
- [x] Applied acknowledge and close return the note; dry runs and no-ops are unchanged (test in
      `packages/core/test/tools-writes.test.ts`).
- [x] RESEARCH.md records the live verification and the lag.

## Security notes
None: both tools are idempotent, so a stale read cannot cause a wrong write.

## Docs to update
- `docs/RESEARCH.md`.

## Out of scope
- Polling New Relic until the change shows.
