---
id: P7-20
title: "Confirm write tool calls through MCP elicitation"
phase: 7
status: todo
priority: low
depends_on: [P7-09]
adr: [0005, 0015]
owner: ""
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
- [ ] A declined or timed-out elicitation sends no mutation and is audited.
- [ ] Works on stdio and HTTP, or the ADR records why not.

## Security notes
T6/T31: moves the approval out of the model's reach.

## Docs to update
- ADR-0015 (or a successor), clients guide.

## Out of scope
- New write tools.
