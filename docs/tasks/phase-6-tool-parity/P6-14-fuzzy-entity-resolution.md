---
id: P6-14
title: "Fuzzy entity-name resolution with per-credential cache"
phase: 6
status: todo
priority: medium
depends_on: [P5-07]
adr: []
owner: ""
---

# P6-14 — Fuzzy entity-name resolution with per-credential cache

## Goal
Let users say "shippingservice" instead of an exact entity name or GUID (idea from prior-art: adjohn).

## Scope
- Shared resolver used by every tool that takes an entity: exact GUID → exact name → case-insensitive/normalised → substring;
  ambiguous matches return a short candidate list instead of guessing.
- Cache of entity names per **credential id + allowed accounts** (TTL ~5 min); never shared across credentials (T16).

## Acceptance criteria
- [ ] Tests: ambiguity handling, cache keying isolation, allowed-account filtering.

## Security notes
T3, T16. Entity names are untrusted text (T6) — escape in entity search (P1-08 helper).

## Docs to update
- Tool reference.

## Out of scope
- Cross-account search beyond the grant's accounts.
