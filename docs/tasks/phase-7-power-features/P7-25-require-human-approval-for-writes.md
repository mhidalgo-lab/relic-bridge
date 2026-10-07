---
id: P7-25
title: "Owner switch to require human approval (elicitation) for write tools"
phase: 7
status: review
priority: medium
depends_on: [P7-20]
adr: [ADR-0015]
owner: claude-agent
---

# P7-25 — Owner switch to require human approval for write tools

## Goal
Phase 7 review M2: with writes on, a client that cannot be asked (no elicitation capability, or any 2025-era client
on stateless HTTP and Workers) lets the model approve its own change with `confirm: true`. That is the documented
P7-09 behaviour, but an owner has no way to say "writes only when a person approves in the client".

## Scope
- A server setting (`RB_WRITE_APPROVAL=client|required`, default `client` = today) and/or a per-grant flag. With
  `required`, a write call from a connection that cannot be asked is refused with a clear error and no mutation.
- `tools/list` keeps listing write tools (or hides them, owner's call) for connections that cannot be asked.

## Acceptance criteria
- [x] Test on both hosts: `required` + a client without elicitation refuses the write (no mutation, audit row
      `confirmation: unavailable`); with elicitation it asks as today.
- [x] Docs: ADR-0015 addendum, security guide, THREAT_MODEL T31.

## Security notes
T31, T6 (prompt injection driving writes).

## Docs to update
- `docs/adr/0015-opt-in-write-tools.md` (addendum), `docs/guide/security-basics.md`, `docs/THREAT_MODEL.md`.
