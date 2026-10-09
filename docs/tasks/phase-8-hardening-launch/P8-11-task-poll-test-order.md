---
id: P8-11
title: Make the concurrent task-poll test independent of which poll wins
phase: 8
status: review
priority: low
depends_on: [P7-29]
adr: []
owner: claude-agent
---

# P8-11 — Make the concurrent task-poll test independent of which poll wins

## Goal
`packages/core/test/tasks.test.ts` "two concurrent polls of one task run one step" failed intermittently under load:
it assumed the first poll always wins the compare-and-swap claim, but record sealing uses async WebCrypto, so either
poll can claim first. The property under test (exactly one step runs, the loser returns the stored claim) holds either
way.

## Scope
- Assert the two status messages as an unordered pair; keep `ran === 1` and the follow-up step assertions.

## Acceptance criteria
- [x] The test asserts the invariant without depending on poll order.
- [x] No product code change.

## Security notes
None (test-only).

## Docs to update
- None.

## Out of scope
- Changes to the task store or claim logic.
