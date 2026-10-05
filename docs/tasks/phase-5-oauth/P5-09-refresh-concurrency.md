---
id: P5-09
title: "Decide and handle concurrent refreshes from real clients"
phase: 5
status: todo
priority: medium
depends_on: [P5-06]
adr: [0009, 0011]
owner: ""
---

# P5-09 — Decide and handle concurrent refreshes from real clients

## Goal
Make sure a real client that refreshes more than once at a time is not signed out by strict refresh rotation (P5-05),
without giving a stolen refresh token a free window.

## Scope
- Use the owner's manual P5-06 results (claude.ai, mobile, Desktop, Claude Code) to learn whether any real client
  refreshes concurrently (the SDK client does: three parallel calls over an expired token revoke the device).
- If yes, decide with the owner and write an ADR (supersede, do not edit ADR-0009/0011 history) for one of:
  a short replay window for the **same client id** that returns the already issued token pair (idempotent replay, stored
  encrypted for the window), a provider-style "previous token valid once more", or keeping strict rotation.
- Implement the choice with tests in the P5-05 lifecycle suite and the P5-06 conformance suite (the parallel-refresh
  test there currently asserts the strict behaviour).
- Update THREAT_MODEL T9/T15 with the accepted window.

## Acceptance criteria
- [ ] ADR with the decision and the measured client behaviour.
- [ ] Conformance suite: parallel requests over an expired token keep the device (or the test documents why not).
- [ ] Reuse of a token outside the window still revokes the device (test).

## Security notes
T9 (token theft), T15 (revocation timing): any window is a window for a stolen refresh token.

## Docs to update
- `docs/dev/oauth.md`, `docs/guide/oauth.md`, `docs/reference/client-compatibility.md`, THREAT_MODEL.

## Out of scope
- Anything not about concurrent refresh.
