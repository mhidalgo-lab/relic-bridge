---
id: P7-26
title: "Bind write approvals to one attempt (no replay of non-idempotent writes)"
phase: 7
status: review
priority: low
depends_on: [P7-20]
adr: [ADR-0015]
owner: claude-agent
---

# P7-26 — Bind write approvals to one attempt

## Goal
Phase 7 review M3: the elicitation answer key is a hash of the message and the change, with no nonce or expiry
(`packages/core/src/tools/write-common.ts`, `humanGate`). A client that resends the same `inputResponses` repeats
`create_change_event` or `create_dashboard`, which are not idempotent. ADR-0015 calls a stale approval harmless; it is
not for these two tools.

## Scope
- Add a time bucket (e.g. 10 minutes) or a server-issued nonce (stateless: HMAC of the change and a timestamp, carried
  in `requestState`) to the key, so an approval answers one attempt in a bounded window.
- Optionally refuse an identical non-idempotent write repeated within the window.

## Acceptance criteria
- [x] Test: an approval replayed after the window asks again; within the window an identical second call of a
      non-idempotent tool is refused or asks again.
- [x] ADR-0015 addendum and THREAT_MODEL T31 residual updated.

## Security notes
T31.

## Docs to update
- `docs/adr/0015-opt-in-write-tools.md`, `docs/THREAT_MODEL.md`.
