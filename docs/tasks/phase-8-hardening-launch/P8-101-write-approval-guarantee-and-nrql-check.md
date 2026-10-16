---
id: P8-101
title: State what write approval guarantees, and warn on rejected dashboard queries
phase: 8
status: review
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-101 — State what write approval guarantees, and warn on rejected dashboard queries

## Goal
Review 5 (0.12.0) findings on the write tools:
- **NEW-37:** `whoami` says a write "needs a person to approve it". In the stateless 2026-07-28 flow the server sends
  an `input_required` question and accepts whatever `inputResponses` come back, keyed by a deterministic hash of the
  arguments. The approval is bound to the exact change, but the server cannot verify that a person answered it: a
  custom client could answer its own question. The wording promises more than the server can enforce.
- **NEW-36:** the NRQL syntax check of `create_dashboard` runs only in `dry_run`. A failed check is `isError: false`
  with `checks[].status: "error"` and no `warnings` entry, and a confirmed call without a prior dry run can create
  widgets New Relic rejects (for example `…WHERE SINCE…`).

## Scope
- Reword `whoami` (`limits.writeApproval` text), the write tool descriptions and the guide: the approval is answered
  through the client's elicitation UI; the server binds it to the exact change and refuses `confirm: true` alone and
  legacy clients, but cannot prove a person answered. Mention that a stronger guarantee would need something outside
  MCP (out of scope here).
- `create_dashboard` dry run: add a `warnings` entry when New Relic rejects one or more queries ("N queries rejected by
  New Relic: …").
- `create_dashboard` confirm: run the same per-query check before the approval question and refuse (nothing written,
  `RB_INPUT_INVALID` with the failing widget) when New Relic rejects a query. Update the request-count text in the
  description.
- THREAT_MODEL: record the residual risk (approval as strong as the client) on the write-approval threat.

## Acceptance criteria
- [x] Tests: dry run with a rejected query has a warning; confirm with a rejected query refuses before asking and
      writes nothing; confirm with valid queries still asks and writes.
- [x] `whoami` and description texts updated; generated tool docs regenerated.
- [x] THREAT_MODEL updated.

## Security notes
Write path (T23 neighbours, write approval). The check must run before the elicitation question so a refused plan is
never shown for approval. Values stay GraphQL variables.

## Docs to update
- `docs/THREAT_MODEL.md`, the write tools guide page, generated tool docs, changeset (patch).

## Out of scope
- Signed approval tokens or a second factor.

## Owner decisions

2026-10-16:

1. The shared write-tool notice reads "Approved in the client (whoami limits.writeApproval)." The owner asked for "Approved in the client's prompt" and "Approved in the client prompt", but the description lint rejects both (overlap of create_change_event with acknowledge_issue and close_issue, and the character headroom); this is the closest wording that passes.
2. Keep the double probe pass (the question round and the answer round each check the queries, the server keeps no state) and let queries beyond the cap or budget go to approval, listed in `notes`.
