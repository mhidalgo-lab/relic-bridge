---
id: P8-111
title: Reused approval on an issue already changed; honest "cancelled" wording
phase: 8
status: done
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-111 — Reused approval on an issue already changed; honest "cancelled" wording

## Goal
0.13.0 retest (2026-10-17):
- Repeating `acknowledge_issue(confirm)` right after an applied acknowledge was refused with `RB_INPUT_INVALID`
  "This approval was already used for one attempt…". New Relic's read lag (P8-100) made the issue still look
  unacknowledged, so the call reached the approval gate again with an answer already spent. Nothing was sent twice
  (correct), but review 5 got "already acknowledged: nothing to do" for the same step, and the refusal reads like an
  input mistake. About 30 s later the dry run says "already acknowledged: nothing to do".
- Claude Android declared form elicitation and answered the question with `cancel` about 1.3 s later with nobody
  tapping. The server says "The user cancelled this change in the confirmation prompt", which states more than the
  server knows.

## Scope
- `acknowledge_issue` / `close_issue` (idempotent): when the approval was already spent, read the issue once more; if
  it is now in the target state, return the usual no-op result (`applied: false`, "already acknowledged/closed:
  nothing to do") instead of the refusal. Otherwise keep the refusal, and say in the hint that New Relic can lag a few
  seconds after a write (P8-100). Non-idempotent tools (`create_change_event`, `create_dashboard`) keep the refusal
  unchanged.
- Cancel wording: "The approval prompt was cancelled (by the user, or by the client without showing it): nothing was
  changed." Decline keeps "The user declined…". Same code `RB_WRITE_APPROVAL_DECLINED`.
- Write tools guide: note that some clients declare elicitation but cancel without showing the prompt.

## Acceptance criteria
- [x] Test: spent approval + issue now in target state → no-op result, no mutation, no error.
- [x] Test: spent approval + issue still not in target state → refusal with the lag hint, no mutation.
- [x] Test: spent approval on `create_change_event` → unchanged refusal, no mutation.
- [x] Test: cancel answer → new wording; decline answer → unchanged wording.

## Security notes
Write approval (T31): the one-approval-one-attempt rule is unchanged; the extra read happens only after the approval
was found spent, and can only turn a refusal into a no-op, never into a mutation. Update THREAT_MODEL T31 in one
sentence.

## Docs to update
- `docs/THREAT_MODEL.md` (T31), write tools guide, changeset (patch).

## Out of scope
- Polling New Relic until a change shows.
