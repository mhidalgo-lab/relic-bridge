---
id: P8-106
title: Tell a client in advance that it cannot approve writes
phase: 8
status: review
priority: medium
depends_on: [P8-101]
adr: []
owner: claude-agent
---

# P8-106 — Tell a client in advance that it cannot approve writes

## Goal
First mobile test (Claude Android), issue 6: every write dry run succeeds, then every real run fails with
`RB_WRITE_APPROVAL_UNAVAILABLE` because the mobile connection can't answer the elicitation prompt. Nothing tells the user
or the model beforehand.

## Scope
- The server already knows, per request, whether the client can answer an approval (2026-07-28 envelope with the
  elicitation capability, or not). Use that in:
  - `whoami`: say whether writes can be approved from this client (for example `limits.writeApprovalReachable` or a
    note), without changing `limits.writeApproval`;
  - write dry runs: a warning that the real run will be refused from this client, and why.
- Guide: which clients can approve writes (Claude Code), and that `RB_WRITE_APPROVAL=off` is the operator's switch for
  a sandbox project. No new way to relax approval from the client side.
- Check `whoami`'s output schema stays backward compatible.

## Acceptance criteria
- [x] Tests: legacy handshake → whoami and dry run say approval isn't reachable; 2026-07-28 with elicitation → they
      don't; `writeApproval: off` → no warning.
- [x] Generated tool docs regenerated; guide updated.

## Security notes
Informational only: the write path and its refusals are unchanged. Per-request capability, not cached (T21).

## Docs to update
- Write tools guide, generated tool docs, changeset (patch), `THREAT_MODEL.md` T31 (one sentence).

## Out of scope
- A per-project approval setting.

## Owner decisions
- 2026-10-16: rebase onto the updated P8-101 branch (write-tool notice now "Approved in the client (whoami
  limits.writeApproval).").
- 2026-10-16: `RB_WRITE_APPROVAL` accepts `off` as a synonym for `client` everywhere it is parsed (`serve`, stdio, the
  Worker); `client` keeps working. Error messages, help text, startup warnings and the docs say `off`, matching
  `whoami`'s `writeApproval: "off"`. No output schema change.
