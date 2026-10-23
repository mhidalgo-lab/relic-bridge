---
id: P8-117
title: Do not ask a person to approve a change whose approval is already spent
phase: 8
status: done
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-117 — Do not ask a person to approve a change whose approval is already spent

## Goal
0.13.1 retest (2026-10-23), sandbox, Claude Code: right after an applied `acknowledge_issue`, the same call was
repeated. New Relic still showed the issue unacknowledged (read lag, P8-100), so the question round asked the person to
approve again; they approved, and the answer round then refused: "This approval was already used for one attempt"
(P8-111). Nothing was sent twice (correct), but the person was asked a question whose answer could never be used.

The question round computes the same key as the spent one (same tool, message, change and time bucket), so the server
can tell before asking.

## Scope
- `WriteApprovals` gains a read-only check (`isSpent(key)` or similar) next to `consume`: memory ledger (stdio) and the
  http-app store (`write-approval:<project>/<grant>/<user>/<key>` in `kv`, read without incrementing).
- `humanGate`, before returning `ask`: when the key it would ask for (the current bucket's) is already spent,
  do not ask. With `returnSpent` (ack/close) return `spent`, so P8-111's re-read gives "nothing to do" or the refusal
  with the lag hint; otherwise throw `spentApprovalError()`. A ledger read error falls back to asking as today (the
  answer round still consumes atomically, so this check is only an optimisation, never the guard).
- Span/audit: the call records the refusal as today (`confirmation` unchanged vocabulary; no new value unless needed).

## Acceptance criteria
- [x] Test (core): a question round for a change whose key is spent returns the spent refusal (or `spent` with
      `returnSpent`) without an input request; a fresh key still asks.
- [x] Test (core): a ledger read error still asks; the answer round's atomic `consume` is unchanged.
- [x] Test (http-app): the store check reads the scoped key and does not change it.
- [x] THREAT_MODEL T31 updated.

## Security notes
T31: the single-use guarantee stays on the atomic `consume` in the answer round; the new check only removes a prompt
and can only refuse, never let a change through. Keys stay scoped to project, grant and user (T21).

## Docs to update
- `docs/THREAT_MODEL.md` (T31), `docs/guide/write-tools.md` if it describes the repeat case, changeset (patch).

## Out of scope
- A lag note on dry runs (P8-100 keeps them unchanged); polling New Relic after a write.

## Review
The first version also refused when the previous bucket's key was spent. That was wrong: in the next bucket the question asks
for a new key, its answer is usable and `consume` succeeds, so refusing blocked a legitimate repeat 10 to 20 minutes later.
Only the key the question would ask for is checked.
