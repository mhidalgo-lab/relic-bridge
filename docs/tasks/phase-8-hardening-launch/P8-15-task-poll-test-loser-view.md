---
id: P8-15
title: Accept both valid loser views in the concurrent task-poll test
phase: 8
status: done
priority: medium
depends_on: [P8-11]
adr: []
owner: claude-agent
---

# P8-15 — Accept both valid loser views in the concurrent task-poll test

## Goal
"two concurrent polls of one task run one step" (`packages/core/test/tasks.test.ts`) failed in the 0.7.0 release build
(run 38035639310): both polls reported `step 1`. P8-11 allowed either poll to win but still assumed the loser reads
the record *before* the winner saves its step. The loser may read it after, and then reports the winner's step. The
property under test, exactly one step runs (`ran === 1`), held.

## Scope
- Assert: at least one poll reports `step 1`, each reports `step 1` or no message; keep `ran === 1`, both
  `working`, and the follow-up step.

## Acceptance criteria
- [x] Test asserts the invariant without depending on poll order or read timing.
- [x] No product code change.

## Security notes
None (test-only).

## Docs to update
- None.

## Out of scope
- Task store or claim logic.
