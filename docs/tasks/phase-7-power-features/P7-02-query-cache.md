---
id: P7-02
title: "Query cache (Cache API / in-memory LRU)"
phase: 7
status: todo
priority: medium
depends_on: [P6-13]
adr: []
owner: ""
---

# P7-02 — Query cache (Cache API / in-memory LRU)

## Scope
- Key = credential id + accounts + normalised NRQL + time bucket; TTL rules (relative windows short, absolute past windows longer); `cache: bypass` option; metrics.

## Acceptance criteria
- [ ] Never shared across credentials (test).

## Security notes
**T16**.

## Docs to update
- Configuration reference.

## Out of scope
- —
