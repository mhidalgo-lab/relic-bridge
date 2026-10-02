---
id: P6-15
title: "Decide on a raw NerdGraph tool (ADR)"
phase: 6
status: todo
priority: low
depends_on: [P5-07]
adr: []
owner: ""
---

# P6-15 — Decide on a raw NerdGraph tool (ADR)

## Goal
Make an explicit, documented decision about raw GraphQL passthrough, which several community servers expose ungated (prior-art S2, THREAT_MODEL T22).

## Scope
- ADR: omit entirely (default proposal) **or** `nerdgraph_query` that is: separately granted, parsed with `graphql` and
  restricted to `query` operations (reject `mutation`/`subscription`, introspection allowed), account-scoped, budget- and size-limited.
- If accepted: implement + negative tests (mutation rejected, other-account ids rejected).

## Acceptance criteria
- [ ] ADR merged; THREAT_MODEL T22 updated with the outcome.

## Security notes
T22, T3.

## Docs to update
- ADR, THREAT_MODEL, tool reference if implemented.

## Out of scope
- Mutations of any kind.
