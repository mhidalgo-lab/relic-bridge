---
id: P8-88
title: Report refused writes as errors and document how write approval is detected
phase: 8
status: review
priority: high
depends_on: []
adr: [0015, 0016]
owner: claude-agent
---

# P8-88 — Report refused writes as errors and document how write approval is detected

## Goal
Review 4 (0.11.0) found two problems with `RB_WRITE_APPROVAL=required`:
- **NEW-15:** a write the server refuses for lack of approval returns `isError: false`, and its `structuredContent`
  (`applied: false`, nothing else) looks like a successful call that did nothing. The reason is only in the text and
  `_meta`, and the span says `ok`.
- **NEW-16:** a client that declares `elicitation` in `initialize` is still told it has no elicitation support, because
  the server is stateless (ADR-0005). The per-request capability path
  (`_meta["io.modelcontextprotocol/clientCapabilities"]`) answers "handled as a question round" but sends no question,
  and its hint ("…or with confirm: true") contradicts a call that already has `confirm: true`.

Agents and clients must be able to tell from the structured result that nothing was written and why. Operators need to
know which clients can approve a write.

## Scope
- A write refused for lack of approval (approval unavailable, declined, cancelled, or timed out) returns
  `isError: true` with a stable code (`RB_WRITE_APPROVAL_UNAVAILABLE`, `RB_WRITE_APPROVAL_DECLINED`), says "nothing was
  changed", and reports it to the client through the normal local-error path (no "untrusted" wrapper).
- Every write tool's output schema and `structuredContent` gain `confirmation` (`approved | not_required | dry_run`) on
  success. On a dry run of `create_change_event`, `structuredContent` carries the planned payload (`plan`), as
  `create_dashboard`'s dry run already does.
- The question-round path: either return the actual input request, as the MCP spec version in use defines it, or remove
  the path. The hint must not tell a caller who already sent `confirm: true` to add it.
- Detection rule documented: in each write tool's description (one sentence), in `whoami.limits.writeApproval`
  (`required | off`, plus how support is detected), and in `docs/guide/write-tools.md` (or the existing write-tools
  page), including which clients are known to work (Claude Code) and why a stateless JSON-RPC client cannot.
- The span records `write.applied` and `write.confirmation`, and marks the span as an error for a refused write (with
  the P8-90 helper if it has landed, otherwise a local status set).

## Acceptance criteria
- [x] Tests: refused write (unavailable, declined) → `isError: true`, code, no NerdGraph mutation sent, and no
      "untrusted" block.
- [x] Tests: dry run of `create_change_event` has `plan` in `structuredContent` that matches the output schema.
- [x] Tests: the per-request capability path either returns an input request or is gone; the hint text is correct.
- [x] `whoami.limits.writeApproval` present, with a schema and test.
- [x] Authorization suite: a refused write is not counted as applied in the audit log (an audit row records the
      refusal).

## Security notes
T23 and the write-approval controls (ADR-0016). A refusal must stay fail-closed: no path may apply a write without
approval when `RB_WRITE_APPROVAL=required`. Update THREAT_MODEL if the detection rule changes.

## Docs to update
- Write tools guide, `docs/reference/tools.md` (generated), THREAT_MODEL (write approval), changeset (minor: the output
  contract changes).

## Out of scope
- Server sessions to remember client capabilities (stateless by decision, ADR-0005).
