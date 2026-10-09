---
id: P7-20
title: "Confirm write tool calls through MCP elicitation"
phase: 7
status: review
priority: low
depends_on: [P7-09]
adr: [0005, 0015]
owner: claude-agent
---

# P7-20 — Confirm write tool calls through MCP elicitation

## Goal
Ask the human (not the model) to confirm each write tool call when the client supports elicitation, instead of relying
only on the `confirm: true` argument the model sets (ADR-0015).

## Scope
- Use MCP elicitation (or the spec's multi-round-trip request mechanism) from the write tool handlers when the client
  declares the capability; stateless HTTP (ADR-0005) needs a design for the round trip.
- Clients without the capability keep the `confirm: true` + `dry_run` flow.

## Acceptance criteria
- [x] A declined, cancelled or unanswered elicitation sends no mutation and is audited (`details.write.record.confirmation`
  is `asked`, then `declined`, `cancelled` or `accepted`; an unanswered one leaves its `asked` row).
- [x] Works on stdio and HTTP, or the ADR records why not: stdio (2025-era connection, SDK shim) and HTTP with a
  2026-07-28 client (multi-round-trip, stateless) are tested; HTTP with a stateless 2025-era client cannot be asked
  (recorded in ADR-0015).
- [x] Only asked when the client declares the elicitation capability, only after every other check, never for dry runs
  or no-ops; `confirm: true` and all opt-ins still apply.
- [x] The message shows the exact change; New Relic text and arguments are quoted and escaped one-liners.
- [x] The approval is bound to the exact message shown (a retry with other arguments asks again).
- [ ] Verified with a real client (Claude Code, Claude Desktop, VS Code, phone) and a real New Relic test account (owner).

## Security notes
T6/T31: moves the approval out of the model's reach.

## Docs to update
- ADR-0015 (addendum), clients guide, security basics, THREAT_MODEL T31, RESEARCH §31, pending decisions.

## Out of scope
- New write tools.
