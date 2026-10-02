---
id: P1-10
title: "Tools: list_event_types, get_attributes"
phase: 1
status: todo
priority: high
depends_on: [P1-06]
adr: []
owner: ""
---

# P1-10 — Tools: schema discovery

## Goal
Let agents write *correct* NRQL by discovering what data exists.

## Scope
- `list_event_types { account?, since? }` → `SHOW EVENT TYPES` (+ optional counts).
- `get_attributes { event_type, account?, since?, sample? }` → `SELECT keyset() FROM <type>` with types; optional 1-row sample (enveloped as untrusted).
- Cache per isolate/process (short TTL).

## Acceptance criteria
- [ ] Event type validated via `nrql.identifier()`; tests.

## Security notes
T4, T6.

## Docs to update
- Tool reference.

## Out of scope
- MCP resources version of schema (P6-12).
